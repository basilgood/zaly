import type { MetaPart, TextPart, ToolContext } from "@zaly/ai"

import { defineTool } from "@zaly/ai"
import { Type } from "typebox"
import type { GhApi, GhRepo } from "./gh-shared.ts"
import { assertGh, budgetTruncate, extractGhIds, ghJson, ghText, isGhUrl, isNumericId, parseRepo } from "./gh-shared.ts"

export type GhCheckRunTool = typeof ghCheckRunTool
export type GhCheckRunToolMeta = {
  /** Set when the ID resolved to a workflow run (feed it to `gh_fetch`). */
  runId?: string
  code: number
  durationMs: number
  ok: boolean
  /** "run" for a resolved workflow run, "check" for an external app check-run. */
  resolved?: string
  truncated?: { bytes: number; hint: string; lines: number }
  url: string
}

// ── URL / ID parsing ───────────────────────────────────────────────────

// parseRepo / extractGhIds / isGhUrl / isNumericId live in gh-shared.ts so both
// gh tools share one parser.

export function isGitHubActionsApp(checkRun: { app?: { name?: string; slug?: string } }): boolean {
  return checkRun.app?.slug === "github-actions" || checkRun.app?.name === "GitHub Actions"
}

// ── Tool ──────────────────────────────────────────────────────────────

// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const ghCheckRunTool = defineTool({
  name: "gh_run",
  desc:
    `Resolve a GitHub Actions check-run ID to the workflow run ID it belongs to, so gh_fetch can read it. ` +
    `Use this when you have a check-run/check-suite link (or a bare check_run_id) and gh run view / gh_fetch ` +
    `return HTTP 404, because a check_run_id is not a run_id. Answers with the run ID and, for GitHub Actions ` +
    `check-runs, the job that matched. For external app check-runs (codecov, orca) that belong to no workflow ` +
    `run, returns that app's own output and annotations instead. ` +
    `This tool never fetches metadata or logs: once you have a run ID, use gh_fetch ` +
    `(e.g. gh_fetch(".../actions/runs/<id>", mode: "log", grep: "Error")).`,
  parallel: true,
  // oxlint-disable-next-line sort-keys -- semantic param order: url, repo, branch, workflow, limit
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
    max_tokens: Type.Optional(
      Type.Integer({
        default: 4000,
        description: "Cap on estimated tokens kept inline (~4 chars each).",
        minimum: 100,
      })
    ),
  }),
  async call(args, ctx: ToolContext<GhCheckRunToolMeta>): Promise<(MetaPart | TextPart)[]> {
    const t0 = Date.now()
    assertGh()

    const meta: GhCheckRunToolMeta = { code: 0, durationMs: 0, ok: true, url: args.url }
    const result = await resolve(args, ctx)
    if (result.runId) {
      meta.resolved = "run"
      meta.runId = result.runId
    } else if (result.external) {
      meta.resolved = "check"
    }
    const budget = await budgetTruncate(result.text, {
      ctx,
      hint: "output exceeded budget. Full output is at truncated.fullOutputPath — read it instead of refetching.",
      maxTokens: args.max_tokens,
    })
    if (budget.truncated) meta.truncated = budget.truncated
    meta.durationMs = Date.now() - t0
    return [{ data: meta, tag: "gh_run", type: "meta" }, { text: budget.text, type: "text" }]
  },
})

async function resolve(
  args: { branch?: string; limit?: number; repo?: string; url: string; workflow?: string },
  ctx: ToolContext
): Promise<{ external?: boolean; runId?: string; text: string }> {
  const { branch, limit, repo: repoArg, url: input, workflow } = args

  let repo: GhRepo | undefined
  let id = ""
  let kind: "run" | "check" | undefined

  if (isGhUrl(input)) {
    repo = parseRepo(input)
    const ids = extractGhIds(input)
    id = ids?.id ?? ""
    kind = ids?.kind
    if (!repo) return { text: "Could not parse owner/repo from the URL." }
    if (!id) return { text: "Could not extract a run/check-run ID from the URL." }
  } else if (isNumericId(input)) {
    kind = undefined
    id = input
    if (!repoArg) return { text: "A numeric ID requires repo in owner/repo form." }
    const m = repoArg.match(/^([^/]+)\/([^/]+)$/)
    if (!m) return { text: "repo must be in owner/repo form." }
    repo = { owner: m[1], repo: m[2] }
  } else {
    return { text: "Input must be a GitHub Actions URL or a numeric ID." }
  }

  const { owner, repo: repoName } = repo
  const slug = `${owner}/${repoName}`

  const api: GhApi = (path) => ghJson(path, ctx)

  /** A run the ID already is — no resolution needed. */
  const isWorkflowRun = async (runId: string): Promise<boolean> => {
    const detail = await api(`repos/${slug}/actions/runs/${runId}`)
    return detail.data !== undefined && detail.error === undefined
  }

  const runIdAnswer = (runId: string, how: string, extra?: string): { runId: string; text: string } => ({
    runId,
    text: [
      `Resolved to workflow run ${runId} in ${slug} (${how}).`,
      `Next: gh_fetch("https://github.com/${slug}/actions/runs/${runId}", mode: "metadata") for status/jobs,`,
      `or mode: "log" with grep/head for failures.`,
      ...(extra ? [extra] : []),
    ].join("\n"),
  })

  // Only a bare numeric ID is ambiguous — URLs name the resource themselves
  // (/runs/… is a run, /check-runs/… is a check run), so skip the probe there.
  if (kind !== "check" && (await isWorkflowRun(id))) return runIdAnswer(id, "ID is a workflow run ID")

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
  }>(`repos/${slug}/check-runs/${id}`)
  if (!checkRun.data) {
    return { text: `Could not resolve ${id} in ${slug}: not a workflow run and not a check-run. ${checkRun.error ?? ""}` }
  }

  // External app check-runs (codecov, orca, …) belong to no workflow run: their
  // own output is the only answer that exists.
  if (!isGitHubActionsApp(checkRun.data)) {
    return { external: true, text: await describeCheckRun(checkRun.data, slug, api) }
  }

  const fromJobLink = await runIdFromJobLink(checkRun.data, slug, api)
  if (fromJobLink) return runIdAnswer(fromJobLink, "check-run job link")

  const suiteId = checkRun.data.check_suite?.id
  if (suiteId) {
    const suiteRuns = await api<{ check_runs?: { details_url?: string; html_url?: string }[] }>(
      `repos/${slug}/check-suites/${suiteId}/check-runs`
    )
    const runs = suiteRuns.data?.check_runs ?? []
    for (const cr of runs) {
      // oxlint-disable-next-line no-await-in-loop -- candidates are tried in order
      const resolved = await runIdFromJobLink(cr, slug, api)
      if (resolved) return runIdAnswer(resolved, "sibling check-run in the same suite")
    }
  }

  const checkName = checkRun.data.name
  if (checkName) {
    const runs = await listRuns(slug, { branch, limit, workflow }, ctx)
    for (const run of runs) {
      // oxlint-disable-next-line no-await-in-loop -- candidates are tried in order
      const jobs = await api<{ jobs?: { id: number }[] }>(`repos/${slug}/actions/runs/${run.databaseId}/jobs`)
      for (const job of jobs.data?.jobs ?? []) {
        // oxlint-disable-next-line no-await-in-loop -- candidates are tried in order
        const jobDetail = await api<{ check_runs?: { id: number; name?: string }[] }>(
          `repos/${slug}/actions/jobs/${job.id}`
        )
        const match = jobDetail.data?.check_runs?.find((cr) => String(cr.id) === id || cr.name === checkName)
        if (match) return runIdAnswer(String(run.databaseId), `matched check-run name "${checkName}"`)
      }
    }
  }

  return {
    text: `Could not resolve check-run ${id} in ${slug} to a workflow run. It may have been deleted, or belong to a workflow run older than the last ${limit ?? 10} runs — raise \`limit\`, or narrow with \`branch\`/\`workflow\`.`,
  }
}

/** The job link on a check-run points at /runs/<id>/job/<id>; the jobs API
 *  turns that into a run ID. This is the only reliable check-run → run hop. */
async function runIdFromJobLink(
  checkRun: { details_url?: string; html_url?: string },
  slug: string,
  api: GhApi
): Promise<string | undefined> {
  const jobUrl = checkRun.html_url ?? checkRun.details_url ?? ""
  const jobMatch = jobUrl.match(/\/runs\/(\d+)\/jobs?\/(\d+)$/)
  if (!jobMatch) return undefined
  const jobDetail = await api<{ run_id?: number }>(`repos/${slug}/actions/jobs/${jobMatch[2]}`)
  return jobDetail.data?.run_id ? String(jobDetail.data.run_id) : undefined
}

async function listRuns(
  slug: string,
  opts: { branch?: string; limit?: number; workflow?: string },
  ctx: ToolContext
): Promise<{ databaseId: number }[]> {
  const args = [
    "run",
    "list",
    "--repo",
    slug,
    "--limit",
    String(opts.limit ?? 10),
    "--json",
    "databaseId,workflowDatabaseId,headBranch,name,displayTitle,status,conclusion,createdAt,url",
  ]
  if (opts.branch) args.push("--branch", opts.branch)
  if (opts.workflow) args.push("--workflow", opts.workflow)
  const { code, stdout } = await ghText(args, ctx)
  if (code !== 0) return []
  try {
    return JSON.parse(stdout) as { databaseId: number }[]
  } catch {
    return []
  }
}

/** External check-runs have no workflow run, so their own report is the answer. */
async function describeCheckRun(
  checkRun: {
    app?: { name?: string; slug?: string }
    conclusion?: string
    details_url?: string
    html_url?: string
    id: number
    name?: string
    output?: { summary?: string; text?: string; title?: string }
    status?: string
    url?: string
  },
  slug: string,
  api: GhApi
): Promise<string> {
  const parts: string[] = []
  parts.push(`${checkRun.name} (check-run ${checkRun.id}) — external app, no workflow run to resolve`)
  parts.push(`Status: ${checkRun.status ?? "unknown"} | Conclusion: ${checkRun.conclusion ?? "unknown"}`)
  parts.push(`App: ${checkRun.app?.name ?? "unknown"} (${checkRun.app?.slug ?? "unknown"})`)
  parts.push(`URL: ${checkRun.html_url ?? checkRun.details_url ?? checkRun.url}`)
  if (checkRun.output) {
    const { title, summary, text } = checkRun.output
    if (title) parts.push(`\nTitle: ${title}`)
    if (summary) parts.push(`\nSummary:\n${summary}`)
    if (text) parts.push(`\nDetails:\n${text}`)
  }

  const annotations = await api<{ annotation_level?: string; message?: string; path?: string; start_line?: number; title?: string }[]>(
    `repos/${slug}/check-runs/${checkRun.id}/annotations`
  )
  if (Array.isArray(annotations.data) && annotations.data.length > 0) {
    parts.push("\nAnnotations:")
    for (const a of annotations.data) {
      const loc = a.path ? `${a.path}${a.start_line === undefined ? "" : `:${a.start_line}`}` : ""
      parts.push(`- [${a.annotation_level ?? "notice"}] ${loc} ${a.message ?? ""}`)
      if (a.title) parts.push(`  ${a.title}`)
    }
  }

  return parts.join("\n")
}
