import type { MetaPart, TextPart, ToolContext } from "@zaly/ai"

import { defineTool } from "@zaly/ai"
import { Type } from "typebox"
import { assertGh, budgetTruncate, filterLog, runGh } from "./gh-shared.ts"

export type GhRunTool = typeof ghRunTool
export type GhRunToolMeta = {
  code: number
  durationMs: number
  mode: string
  ok: boolean
  truncated?: { bytes: number; hint: string; lines: number }
  url: string
}

// ── URL / ID parsing ───────────────────────────────────────────────────

export type GhRepo = { owner: string; repo: string }

export function parseRepo(url: string): GhRepo | undefined {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)/)
  return m ? { owner: m[1], repo: m[2] } : undefined
}

export function extractIds(url: string): { id: string; jobId?: string } | undefined {
  // Job URL: /runs/{run_id}/job/{job_id}
  const jobMatch = url.match(/\/runs\/(\d+)\/job\/(\d+)/)
  if (jobMatch) return { id: jobMatch[1], jobId: jobMatch[2] }
  // Standard paths: /runs/123, /actions/runs/123, /check-runs/123
  const m = url.match(/\/(runs|actions\/runs|check-runs)\/(\d+)/)
  if (m) return { id: m[2] }
  // PR checks page query string: /pull/1091/checks?check_run_id=123
  const q = url.match(/[?&]check_run_id=(\d+)/)
  if (q) return { id: q[1] }
  return undefined
}

export function isUrl(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://")
}

export function isNumeric(value: string): boolean {
  return /^\d+$/.test(value)
}

export function isGitHubActionsApp(checkRun: { app?: { name?: string; slug?: string } }): boolean {
  return checkRun.app?.slug === "github-actions" || checkRun.app?.name === "GitHub Actions"
}

// ── Tool ──────────────────────────────────────────────────────────────

// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const ghRunTool = defineTool({
  name: "gh_run",
  desc:
    `Resolve GitHub Actions check-run IDs to real workflow run IDs and fetch run metadata, job metadata, and logs. ` +
    `For external app check-runs (e.g. codecov, orca) that do not belong to a workflow run, returns the check-run output and annotations directly. ` +
    `Use this when the user provides a GitHub Actions URL/check-run ID and gh run view returns an HTTP 404 because the ID is a check_run_id, not a run_id. ` +
    `Optional 'jq' + 'fields' args run a jq expression over the --json metadata output (mode 'metadata' only) for token-efficient queries. ` +
    `When fetching logs to inspect failures, ALWAYS pass 'grep' (e.g. '✘' for Playwright failures, 'Error' for others) and 'head' — returning the full log is extremely token-expensive.`,
  parallel: true,
  params: Type.Object({
    url: Type.String({
      description:
        `GitHub Actions URL or raw check-run/run ID. Accepts full URLs like https://github.com/owner/repo/actions/runs/123456, ` +
        `https://github.com/owner/repo/actions/runs/123456/job/789, https://github.com/owner/repo/check-runs/123456, ` +
        `https://github.com/owner/repo/pull/123/checks?check_run_id=456, or just a numeric ID if repo is provided.`,
    }),
    repo: Type.Optional(
      Type.String({
        description: "Repository in owner/repo form. Required when the input is only a numeric ID.",
      })
    ),
    mode: Type.Optional(
      Type.Union(
        [Type.Literal("metadata"), Type.Literal("log"), Type.Literal("log-failed"), Type.Literal("job")],
        {
          default: "metadata",
          description:
            `What to fetch: 'metadata' (default) returns run/check info, 'log' returns full run logs, ` +
            `'log-failed' returns only failed run logs, 'job' returns only the specific job's metadata/logs ` +
            `(most precise, token-saver). Ignored for external app check-runs.`,
        }
      )
    ),
    branch: Type.Optional(
      Type.String({
        description: "Optional branch name to narrow the run search when resolving a check_run_id.",
      })
    ),
    workflow: Type.Optional(
      Type.String({
        description: "Optional workflow file name to narrow the run search when resolving a check_run_id.",
      })
    ),
    limit: Type.Optional(
      Type.Integer({
        default: 10,
        description: "Max number of recent runs to inspect when resolving a check_run_id.",
      })
    ),
    jq: Type.Optional(
      Type.String({
        description:
          `jq expression applied to the --json output, e.g. '.jobs[] | .name + ": " + .conclusion'. ` +
          `Only used with mode 'metadata'; returns the raw jq output instead of the full text view. Ignored for log modes.`,
      })
    ),
    fields: Type.Optional(
      Type.String({
        default: "jobs",
        description: "Comma-separated JSON fields for --json when jq is set (default 'jobs').",
      })
    ),
    grep: Type.Optional(
      Type.String({
        description:
          `Regex; when set, log output is filtered to lines matching it (e.g. '✘' for failing test lines). ` +
          `Only used with log modes; ignored for mode 'metadata'. ALWAYS pass this when inspecting failures — ` +
          `the full log is extremely token-expensive.`,
      })
    ),
    head: Type.Optional(
      Type.Integer({
        default: 10,
        description: "Max matching log lines to return when grep is set (default 10).",
      })
    ),
    max_tokens: Type.Optional(
      Type.Integer({
        default: 4000,
        description: "Cap on estimated tokens kept inline (~4 chars each).",
        minimum: 100,
      })
    ),
  }),
  async call(args, ctx: ToolContext<GhRunToolMeta>): Promise<(MetaPart | TextPart)[]> {
    const t0 = Date.now()
    assertGh()

    const mode = args.mode ?? "metadata"
    const meta: GhRunToolMeta = { code: 0, durationMs: 0, mode, ok: true, url: args.url }
    const text = await fetchRun(args, ctx)
    const budget = budgetTruncate(text, {
      hint: "output exceeded budget; pass `jq`/`fields` for metadata or `grep`/`head` for logs.",
      maxTokens: args.max_tokens,
    })
    if (budget.truncated) meta.truncated = budget.truncated
    meta.durationMs = Date.now() - t0
    return [{ data: meta, tag: "gh_run", type: "meta" }, { text: budget.text, type: "text" }]
  },
})

async function fetchRun(
  args: {
    branch?: string
    fields?: string
    grep?: string
    head?: number
    jq?: string
    limit?: number
    mode?: "job" | "log" | "log-failed" | "metadata"
    repo?: string
    url: string
    workflow?: string
  },
  ctx: ToolContext
): Promise<string> {
  const { branch, fields, grep, head, jq, limit, mode, repo: repoArg, url: input, workflow } = args
  const logMode = mode === "log" || mode === "log-failed"

  let repo: GhRepo | undefined = undefined
  let id = ""
  let explicitJobId: string | undefined

  if (isUrl(input)) {
    repo = parseRepo(input)
    const ids = extractIds(input)
    id = ids?.id ?? ""
    explicitJobId = ids?.jobId
    if (!repo) return "Could not parse owner/repo from the URL."
    if (!id) return "Could not extract a run/check-run ID from the URL."
  } else if (isNumeric(input)) {
    id = input
    if (!repoArg) return "A numeric ID requires repo in owner/repo form."
    const m = repoArg.match(/^([^/]+)\/([^/]+)$/)
    if (!m) return "repo must be in owner/repo form."
    repo = { owner: m[1], repo: m[2] }
  } else {
    return "Input must be a GitHub Actions URL or a numeric ID."
  }

  const { owner, repo: repoName } = repo

  // oxlint-disable-next-line no-unnecessary-type-parameters -- callers pass explicit type args
  async function api<T = unknown>(path: string): Promise<{ data: T | undefined; error: string | undefined }> {
    const { stdout, stderr, code } = await runGh(["api", path], ctx)
    if (code !== 0) return { data: undefined, error: `gh api ${path}: ${stderr || stdout}` }
    try {
      return { data: JSON.parse(stdout) as T, error: undefined }
    } catch {
      return { data: stdout as unknown as T, error: undefined }
    }
  }

  async function tryRunView(runId: string): Promise<string | undefined> {
    const { stdout, stderr, code } = await runGh(["run", "view", runId, "--repo", `${owner}/${repoName}`], ctx)
    if (code !== 0) {
      if (stderr.includes("HTTP 404") || stdout.includes("HTTP 404")) return undefined
      return `gh run view ${runId} error: ${stderr}`
    }
    return stdout
  }

  async function fetchLogs(runId: string): Promise<string> {
    const logFlag = mode === "log-failed" ? "--log-failed" : "--log"
    const { stdout, stderr, code } = await runGh(
      ["run", "view", runId, "--repo", `${owner}/${repoName}`, logFlag],
      ctx
    )
    if (code !== 0) return `gh run view ${runId} ${logFlag} error: ${stderr}`
    return filterLog(stdout, grep, head)
  }

  async function fetchJob(jobId: string): Promise<string | undefined> {
    const args = ["run", "view", "--job", jobId, "--repo", `${owner}/${repoName}`]
    if (logMode) args.push(mode === "log-failed" ? "--log-failed" : "--log")
    const { stdout, stderr, code } = await runGh(args, ctx)
    if (code !== 0) {
      if (stderr.includes("HTTP 404") || stdout.includes("HTTP 404")) return undefined
      return `gh run view --job ${jobId} error: ${stderr}`
    }
    return filterLog(stdout, grep, head)
  }

  async function fetchJq(runId: string, jobId?: string): Promise<string> {
    if (!jq) return "jq expression required."
    const args = ["run", "view"]
    if (jobId) args.push("--job", jobId)
    args.push(runId, "--repo", `${owner}/${repoName}`, "--json", fields ?? "jobs", "--jq", jq)
    const { stdout, stderr, code } = await runGh(args, ctx)
    if (code !== 0) return `gh run view --json --jq error: ${stderr || stdout}`
    return stdout
  }

  async function listRuns(): Promise<Array<{ databaseId: number }>> {
    const args = [
      "run",
      "list",
      "--repo",
      `${owner}/${repoName}`,
      "--limit",
      String(limit ?? 10),
      "--json",
      "databaseId,workflowDatabaseId,headBranch,name,displayTitle,status,conclusion,createdAt,url",
    ]
    if (branch) args.push("--branch", branch)
    if (workflow) args.push("--workflow", workflow)
    const { stdout, code } = await runGh(args, ctx)
    if (code !== 0) return []
    try {
      return JSON.parse(stdout) as Array<{ databaseId: number }>
    } catch {
      return []
    }
  }

  async function resolveCheckRunToRunId(checkRun: {
    details_url?: string
    html_url?: string
  }): Promise<string | undefined> {
    const jobUrl = checkRun.html_url ?? checkRun.details_url ?? ""
    const jobMatch = jobUrl.match(/\/runs\/(\d+)\/job\/(\d+)$/)
    if (jobMatch) {
      const jobDetail = await api<{ run_id?: number }>(`repos/${owner}/${repoName}/actions/jobs/${jobMatch[2]}`)
      if (jobDetail.data?.run_id) {
        return String(jobDetail.data.run_id)
      }
    }
    return undefined
  }

  async function fetchCheckRunOutput(checkRun: {
    app?: { name?: string; slug?: string }
    conclusion?: string
    html_url?: string
    details_url?: string
    id: number
    name?: string
    output?: { summary?: string; text?: string; title?: string }
    status?: string
    url?: string
  }): Promise<string> {
    const parts: string[] = []
    parts.push(`Check run: ${checkRun.name} (ID ${checkRun.id})`)
    parts.push(`Status: ${checkRun.status ?? "unknown"}`)
    parts.push(`Conclusion: ${checkRun.conclusion ?? "unknown"}`)
    parts.push(`App: ${checkRun.app?.name ?? "unknown"} (${checkRun.app?.slug ?? "unknown"})`)
    parts.push(`URL: ${checkRun.html_url ?? checkRun.details_url ?? checkRun.url}`)
    if (checkRun.output) {
      const { title, summary, text } = checkRun.output
      if (title) parts.push(`\nTitle: ${title}`)
      if (summary) parts.push(`\nSummary:\n${summary}`)
      if (text) parts.push(`\nDetails:\n${text}`)
    }

    const annotations = await api<Array<{ annotation_level?: string; message?: string; path?: string; start_line?: number; title?: string }>>(
      `repos/${owner}/${repoName}/check-runs/${checkRun.id}/annotations`
    )
    if (annotations.data && Array.isArray(annotations.data) && annotations.data.length > 0) {
      parts.push("\nAnnotations:")
      for (const a of annotations.data) {
        const loc = a.path ? `${a.path}${a.start_line !== undefined ? `:${a.start_line}` : ""}` : ""
        parts.push(`- [${a.annotation_level ?? "notice"}] ${loc} ${a.message ?? ""}`)
        if (a.title) parts.push(`  ${a.title}`)
      }
    }

    return parts.join("\n")
  }

  // 0. If the URL contains an explicit job ID, return only that job.
  if (explicitJobId) {
    if (jq) return await fetchJq(id, explicitJobId)
    const jobOutput = await fetchJob(explicitJobId)
    if (!jobOutput) {
      return `Could not fetch job ${explicitJobId} for ${owner}/${repoName}. It may not exist or you may lack permissions.`
    }
    if (jobOutput.startsWith("gh run view")) {
      return jobOutput
    }
    return `Job ${explicitJobId} for ${owner}/${repoName}\n${"=".repeat(60)}\n${jobOutput}`
  }

  // 1. Try treating the ID as a run_id first.
  let runView = await tryRunView(id)

  if (runView === undefined || (typeof runView === "string" && runView.includes("HTTP 404"))) {
    // 2. Not a run_id — treat as check_run_id.
    const checkRun = await api<{
      app?: { name?: string; slug?: string }
      check_suite?: { id?: number }
      conclusion?: string
      details_url?: string
      html_url?: string
      id: number
      name?: string
      output?: { summary?: string; text?: string; title?: string }
      status?: string
      url?: string
    }>(`repos/${owner}/${repoName}/check-runs/${id}`)
    if (!checkRun.data) {
      return `Could not fetch check-run ${id} for ${owner}/${repoName}. ${checkRun.error ?? ""}`
    }

    // External app check-runs (codecov, orca, etc.) don't belong to a GitHub Actions workflow run.
    // Return their own output directly.
    if (!isGitHubActionsApp(checkRun.data)) {
      return fetchCheckRunOutput(checkRun.data)
    }

    // GitHub Actions check-run: resolve to parent workflow run.
    const resolvedRunId = await resolveCheckRunToRunId(checkRun.data)
    if (resolvedRunId) {
      runView = await tryRunView(resolvedRunId)
      if (runView && !runView.startsWith("gh run view")) {
        const header = `Resolved check_run ${id} to workflow run ${resolvedRunId} for ${owner}/${repoName}\n${"=".repeat(60)}\n`
        if (mode === "metadata") {
          if (jq) return header + (await fetchJq(resolvedRunId))
          return header + runView
        }
        return header + (await fetchLogs(resolvedRunId))
      }
    }

    // Fallback: scan the check suite for any job link.
    if (!resolvedRunId && checkRun.data.check_suite?.id) {
      const suiteId = checkRun.data.check_suite.id
      const suiteRuns = await api<{ check_runs?: Array<{ details_url?: string; html_url?: string }> }>(
        `repos/${owner}/${repoName}/check-suites/${suiteId}/check-runs`
      )
      if (suiteRuns.data && Array.isArray(suiteRuns.data.check_runs)) {
        for (const cr of suiteRuns.data.check_runs) {
          const fallbackRunId = await resolveCheckRunToRunId(cr)
          if (fallbackRunId) {
            const view = await tryRunView(fallbackRunId)
            if (view && !view.startsWith("gh run view")) {
              const header = `Resolved check_run ${id} to workflow run ${fallbackRunId} for ${owner}/${repoName}\n${"=".repeat(60)}\n`
              if (mode === "metadata") {
                if (jq) return header + (await fetchJq(fallbackRunId))
                return header + view
              }
              return header + (await fetchLogs(fallbackRunId))
            }
          }
        }
      }
    }

    // Final fallback: search recent runs by check_run name.
    if (!resolvedRunId && checkRun.data.name) {
      const checkName = checkRun.data.name
      const runs = await listRuns()
      for (const run of runs) {
        const runDetail = await api<{ databaseId?: number }>(
          `repos/${owner}/${repoName}/actions/runs/${run.databaseId}`
        )
        if (!runDetail.data) continue
        const jobs = await api<{ jobs?: Array<{ id: number }> }>(
          `repos/${owner}/${repoName}/actions/runs/${run.databaseId}/jobs`
        )
        if (!jobs.data || !Array.isArray(jobs.data.jobs)) continue
        for (const job of jobs.data.jobs) {
          const jobDetail = await api<{ check_runs?: Array<{ id: number; name?: string }> }>(
            `repos/${owner}/${repoName}/actions/jobs/${job.id}`
          )
          if (jobDetail.data && Array.isArray(jobDetail.data.check_runs)) {
            const match = jobDetail.data.check_runs.find(
              (cr) => String(cr.id) === id || cr.name === checkName
            )
            if (match) {
              const header = `Resolved check_run ${id} to workflow run ${run.databaseId} for ${owner}/${repoName}\n${"=".repeat(60)}\n`
              if (mode === "metadata") {
                if (jq) return header + (await fetchJq(String(run.databaseId)))
                const view = await tryRunView(String(run.databaseId))
                return header + (view ?? "")
              }
              return header + (await fetchLogs(String(run.databaseId)))
            }
          }
        }
      }
    }

    return `Could not resolve check_run ${id} to a workflow run for ${owner}/${repoName}. It may be an external app check-run or the run was deleted.`
  }

  // 3. ID was already a valid run_id.
  if (typeof runView === "string" && runView.startsWith("gh run view")) {
    return runView
  }

  if (mode === "metadata") {
    if (jq) return await fetchJq(id)
    return `Workflow run ${id} for ${owner}/${repoName}\n${"=".repeat(60)}\n${runView}`
  }

  return `Workflow run ${id} for ${owner}/${repoName}\n${"=".repeat(60)}\n${await fetchLogs(id)}`
}
