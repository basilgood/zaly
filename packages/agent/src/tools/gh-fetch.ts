import type { MetaPart, TextPart, ToolContext } from "@zaly/ai"

import { defineTool } from "@zaly/ai"
import { createHash } from "node:crypto"
import { Type } from "typebox"
import { assertGh, assertJqFieldsExist, budgetTruncate, filterLog, filterOutput, GH_DEFAULT_MAX_TOKENS, ghJson, readOutput, renderGhPayload, runGh, runJq, stripAnsi } from "./gh-shared.ts"

export type GhTool = typeof ghTool
export type GhToolMeta = {
  code: number
  durationMs: number
  mode: string
  ok: boolean
  truncated?: { bytes: number; hint: string; lines: number }
  url: string
}

// ── URL parsing ────────────────────────────────────────────────────────

export function filenameHash(filename: string): string {
  return createHash("sha256").update(filename).digest("hex")
}

export function parseDiffHash(url: string): string | undefined {
  const match = url.match(/#diff-([a-f0-9]+)/i)
  return match ? match[1] : undefined
}

export function isRawApiPath(url: string): boolean {
  return !url.startsWith("http") && !url.startsWith("github.com")
}

/** A 404 on a run/check-run ID almost always means the ID is a check_run_id,
 *  which `gh run view` cannot accept. Point at the resolver instead of leaving
 *  the model to guess. */
export function runViewError(stderr: string, id: string): string {
  const base = `gh run view error: ${stderr}`
  if (!/404|Not Found/i.test(stderr)) return base
  return (
    `${base}\n` +
    `A 404 usually means ${id} is a check_run_id, not a run_id. ` +
    `Call gh_run with the original URL or id to resolve it to the real run ID, then gh_fetch that.`
  )
}

// A blob/tree URL path is ambiguous when the ref itself contains slashes
// (e.g. blob/chore/visuals/src/file.ts), so try every ref/path split.
export function refCandidates(ref: string, path: string): { path: string; ref: string }[] {
  const candidates = [{ path, ref }]
  if (!path) return candidates
  const parts = path.split("/")
  for (let i = 1; i < parts.length; i++) {
    candidates.push({ path: parts.slice(i).join("/"), ref: [ref, ...parts.slice(0, i)].join("/") })
  }
  return candidates
}

export function parseGitHubUrl(
  url: string
): { owner: string; repo: string; type: string; id: string; suffix?: string; format?: string } | undefined {
  const cleanUrl = url.split("#")[0]
  // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path> — the same shape as a
  // blob URL, but the ref/path boundary is unknown (refs may contain slashes),
  // so hand the first segment to `id` and let refCandidates split it.
  const raw = cleanUrl.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.+))?/)
  if (raw) return { id: raw[3], owner: raw[1], repo: raw[2], suffix: raw[4], type: "blob" }
  const formatMatch = cleanUrl.match(/\.(diff|patch)$/)
  const format = formatMatch ? formatMatch[1] : undefined
  const urlWithoutFormat = formatMatch ? cleanUrl.slice(0, -formatMatch[0].length) : cleanUrl
  const match = urlWithoutFormat.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|actions|commit|issues|tree|blob)\/([^/?]+)(?:\/(.+))?/
  )
  if (!match) return undefined
  let id = match[4]
  let suffix: string | undefined = match[5]
  if (match[3] === "actions" && id === "runs" && suffix) {
    const runMatch = suffix.match(/^(\d+)(?:\/(.*))?/)
    if (runMatch) {
      id = runMatch[1]
      suffix = runMatch[2]
    }
  }
  return { format, id: id!, owner: match[1], repo: match[2], suffix, type: match[3] }
}

// ── Tool ──────────────────────────────────────────────────────────────

// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const ghTool = defineTool({
  name: "gh_fetch",
  desc:
    `Read-only fetcher for GitHub content using the authenticated gh CLI. Use instead of fetch for GitHub URLs — ` +
    `works with private repos. Handles PRs, diffs (including #diff- anchors), CI runs, issues, commits, ` +
    `tree (directory listings), blob (file content), and raw API paths. Resolves diff anchors to specific ` +
    `file changes. Base64 content is automatically decoded. For any gh api endpoint (e.g. ` +
    `repos/owner/repo/commits/<sha>/check-runs), pass the raw API path as url. When fetching logs to ` +
    `inspect failures, ALWAYS pass 'grep' (e.g. '✘' for Playwright failures, 'Error' for others) and ` +
    `'head' — the full log is extremely token-expensive. For JSON responses, pass 'jq' to keep them small. ` +
    `Read-only: for other gh commands (merge, release, …) use bash.`,
  parallel: true,
  // oxlint-disable-next-line sort-keys -- semantic param order: url, mode, grep, head
  params: Type.Object({
    url: Type.String({
      description:
        `GitHub URL or gh api path. Supports: PR URLs (with #diff-<sha256-filename-hash> for specific ` +
        `files), CI run/job URLs, commit URLs, issue URLs, tree URLs (github.com/owner/repo/tree/branch/path ` +
        `for directories), blob URLs (github.com/owner/repo/blob/branch/path for files), raw API paths like ` +
        `repos/owner/repo/pulls/123), or raw.githubusercontent.com/owner/repo/ref/path URLs.`,
    }),
    mode: Type.Optional(
      Type.Union(
        [Type.Literal("diff"), Type.Literal("json"), Type.Literal("log"), Type.Literal("metadata"), Type.Literal("raw")],
        {
          default: "json",
          description:
            `What to fetch: 'diff' for PR/commit diffs, 'json' for structured data (default), 'log' for CI job logs, ` +
            `'metadata' for run/job metadata (alias of 'json'), 'raw' for decoded file text (alias of 'json').`,
        }
      )
    ),
    grep: Type.Optional(
      Type.String({
        description:
          `Regex; when set, log output is filtered to lines matching it (e.g. '✘' for failing test lines). ` +
          `Only used with mode 'log'. ALWAYS pass this when inspecting failures — the full log is extremely token-expensive. ` +
          `The result reports the TOTAL match count, so if you see "94 matching line(s), showing first 40" the ` +
          `remaining matches exist but were not printed: raise \`head\`, or narrow \`grep\` (e.g. 'Error|✘'), ` +
          `rather than re-running the same call.`,
      })
    ),
    head: Type.Optional(
      Type.Integer({
        default: 10,
        description:
          "Max matching log lines to return when grep is set (default 10). The match count in the result is the " +
          "total, not the number shown — raise head (e.g. 100) to see more instead of re-running.",
      })
    ),
    jq: Type.Optional(
      Type.String({
        description:
          `jq expression applied to any JSON response, e.g. ".full_name, .description" or ` +
          `"[.[] | {name, conclusion}]". Applied in-process to pr/issue/run/commit JSON as ` +
          `well as raw API paths. Use it to keep responses small. If a response is cut off, ` +
          `the shape line tells you the available keys/paths to filter on.`,
      })
    ),
    max_tokens: Type.Optional(
      Type.Integer({
        default: GH_DEFAULT_MAX_TOKENS,
        description: "Cap on estimated tokens kept inline (~4 chars each).",
        minimum: 100,
      })
    ),
  }),
  async call(args, ctx: ToolContext<GhToolMeta>): Promise<(MetaPart | TextPart)[]> {
    const t0 = Date.now()
    assertGh()

    const { url, grep, head, jq } = args
    const mode = args.mode === "metadata" || args.mode === "raw" ? "json" : (args.mode ?? "json")
    const meta: GhToolMeta = { code: 0, durationMs: 0, mode, ok: true, url }
    const text = await fetchGh(url, { grep, head, jq, mode }, ctx)
    const budget = await budgetTruncate(text, {
      ctx,
      hint: "output exceeded budget; pass `jq` to filter JSON or `grep`/`head` for logs. Full output is at truncated.fullOutputPath — read it instead of refetching.",
      maxTokens: args.max_tokens,
    })
    if (budget.truncated) meta.truncated = budget.truncated
    meta.durationMs = Date.now() - t0
    return [{ data: meta, tag: "gh_fetch", type: "meta" }, { text: budget.text, type: "text" }]
  },
})

async function fetchGh(
  url: string,
  opts: { grep?: string; head?: number; jq?: string; mode: "diff" | "json" | "log" },
  ctx: ToolContext
): Promise<string> {
  const { grep, head, jq, mode } = opts
  if (isRawApiPath(url)) {
    const args = ["api", url, ...(jq ? ["--jq", jq] : [])]
    let out = await runGh(args, ctx)
    let escaped = false
    // Log endpoints answer with colour codes and `gh api` refuses to print them
    // at all, exiting non-zero. Retry once with the flag that allows them; the
    // codes carry no information once the text is read as plain output.
    if (out.code !== 0 && /escape sequences/.test(out.stderr)) {
      out = await runGh([...args, "--allow-escape-sequences"], ctx)
      escaped = true
      if (out.code !== 0) return `gh api error: ${out.stderr}`
    } else if (out.code !== 0) {
      return `gh api error: ${out.stderr}`
    }
    const stdout = escaped ? stripAnsi(readOutput(out)) : readOutput(out)
    if (jq) return stdout
    // `grep`/`head` apply here too, so a log fetched by API path filters exactly
    // like one fetched by job URL.
    if (grep) return filterLog(stdout, grep, head)
    // `contents` endpoints answer with JSON metadata + base64 content, or a
    // directory listing; hand the model readable text instead of an envelope.
    return renderGhPayload(stdout)
  }

  const parsed = parseGitHubUrl(url)
  if (!parsed) {
    return `Failed to parse GitHub URL. Use a raw gh api path instead, e.g., repos/owner/repo/pulls/123`
  }

  const { owner, repo, type, id, suffix, format } = parsed
  const diffHash = parseDiffHash(url)
  // JSON paths route through `finish`, so `jq` and shape hints apply to every
  // resource instead of only raw API paths.
  const finish = async (text: string, label: string): Promise<string> => {
    if (!jq) return text
    const applied = await runJq(jq, text, ctx)
    if (!applied.ok) return `${label}: ${applied.text}`
    return `${applied.text}${assertJqFieldsExist(jq, text, applied.text) ?? ""}`
  }

  if (type === "pull") {
    const effectiveMode =
      suffix === "files" || suffix === "changes" || diffHash || format === "diff" || format === "patch"
        ? "diff"
        : mode

    if (effectiveMode === "diff") {
      if (diffHash) {
        const allFiles: { filename: string; status: string; additions: number; deletions: number; patch?: string }[] = []
        let page = 1
        let done = false
        while (!done) {
          // oxlint-disable-next-line no-await-in-loop -- pagination is inherently sequential
          const pageRes = await ghJson<{ filename: string; status: string; additions: number; deletions: number; patch?: string }[]>(
            `repos/${owner}/${repo}/pulls/${id}/files?per_page=100&page=${page}`,
            ctx
          )
          if (pageRes.code !== 0) return `gh api PR files error: ${pageRes.error}`
          if (!Array.isArray(pageRes.data)) {
            done = true
          } else {
            allFiles.push(...pageRes.data)
            done = pageRes.data.length < 100
            page++
          }
        }
        const matchingFile = allFiles.find((f) => filenameHash(f.filename) === diffHash)
        if (!matchingFile) {
          const hashes = allFiles.map((f) => `${f.filename} -> ${filenameHash(f.filename)}`).join("\n")
          return `No file found with hash ${diffHash}.\nAvailable files and hashes:\n${hashes}`
        }
        const header = `--- ${matchingFile.filename} (${matchingFile.status}, +${matchingFile.additions}/-${matchingFile.deletions}) ---`
        const patch = matchingFile.patch ?? "(binary or large file, no patch)"
        return `${header}\n${patch}`
      }
      const out = await runGh(["pr", "diff", id, "--repo", `${owner}/${repo}`], ctx)
      if (out.code !== 0) return `gh pr diff error: ${out.stderr}`
      return readOutput(out)
    }

    const out = await runGh(
      ["pr", "view", id, "--repo", `${owner}/${repo}`, "--json", "title,body,url,state,additions,deletions,changedFiles,files,headRefOid,headRefName"],
      ctx
    )
    if (out.code !== 0) return `gh pr view error: ${out.stderr}`
    return finish(readOutput(out), "gh pr view")
  }

  if (type === "actions") {
    // Job URLs appear as /job/<id> (web UI) and /jobs/<id> (API-style links).
    const jobMatch = suffix?.match(/^jobs?\/(\d+)/)
    if (jobMatch) {
      const jobId = jobMatch[1]
      if (mode === "log") {
        const out = await runGh(["run", "view", "--job", jobId, "--repo", `${owner}/${repo}`, "--log"], ctx)
        if (out.code !== 0) return `gh run view --job log error: ${out.stderr}`
        return filterOutput(out, grep, head)
      }
      // `gh run view --job --json steps` silently drops the steps field, and the
      // log route reports every step as "UNKNOWN STEP". The jobs API is the only
      // source that names the failing step. The user's `jq` is applied by
      // `finish()`, not here — passing it twice filters the filtered output.
      const out = await runGh(["api", `repos/${owner}/${repo}/actions/jobs/${jobId}`], ctx)
      if (out.code !== 0) return `gh api job error: ${out.stderr}`
      return finish(readOutput(out), "gh api job")
    }

    if (mode === "log") {
      const out = await runGh(["run", "view", id, "--repo", `${owner}/${repo}`, "--log-failed"], ctx)
      if (out.code === 0) return filterOutput(out, grep, head)
      // A job ID also 404s as a run ID; the job-scoped log still works.
      if (/404|Not Found/i.test(out.stderr)) {
        const jobLog = await runGh(["run", "view", "--job", id, "--repo", `${owner}/${repo}`, "--log"], ctx)
        if (jobLog.code === 0) return filterOutput(jobLog, grep, head)
      }
      return runViewError(out.stderr, id)
    }
    const out = await runGh(
      ["run", "view", id, "--repo", `${owner}/${repo}`, "--json", "databaseId,name,displayTitle,workflowName,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url,jobs"],
      ctx
    )
    if (out.code !== 0) {
      // Job IDs share the numeric space with run IDs, so a bare job id reaches
      // here as a run id and 404s. Fall back to the job endpoint rather than
      // sending the caller off to resolve something they already had.
      if (/404|Not Found/i.test(out.stderr)) {
        const job = await runGh(["api", `repos/${owner}/${repo}/actions/jobs/${id}`], ctx)
        if (job.code === 0) {
          return `${await finish(readOutput(job), "gh api job")}\n\n(${id} is a job ID, not a run ID.)`
        }
      }
      return runViewError(out.stderr, id)
    }
    return finish(readOutput(out), "gh run view")
  }

  if (type === "commit") {
    if (mode === "diff") {
      const out = await runGh(
        ["api", `repos/${owner}/${repo}/commits/${id}`, "-H", "Accept: application/vnd.github.v3.diff"],
        ctx
      )
      if (out.code !== 0) return `gh api commit diff error: ${out.stderr}`
      return readOutput(out)
    }
    const out = await runGh(["api", `repos/${owner}/${repo}/commits/${id}`], ctx)
    if (out.code !== 0) return `gh api commit error: ${out.stderr}`
    return finish(readOutput(out), "gh api commit")
  }

  if (type === "issues") {
    const out = await runGh(
      ["issue", "view", id, "--repo", `${owner}/${repo}`, "--json", "title,body,labels,state,comments"],
      ctx
    )
    if (out.code !== 0) return `gh issue view error: ${out.stderr}`
    return finish(readOutput(out), "gh issue view")
  }

  if (type === "tree" || type === "blob") {
    const path = suffix ?? ""

    const fetchContents = async (refOrSha: string, filePath: string): Promise<string> => {
      const apiPath = filePath
        ? `repos/${owner}/${repo}/contents/${filePath}?ref=${refOrSha}`
        : `repos/${owner}/${repo}/contents?ref=${refOrSha}`
      const out = await runGh(["api", apiPath], ctx)
      if (out.code !== 0) return `gh api error: ${out.stderr}`
      const rendered = renderGhPayload(readOutput(out))
      return rendered || "(empty directory)"
    }

    const attempts = /^[a-f0-9]{40}$/i.test(id) ? [{ path, ref: id }] : refCandidates(id, path)
    let lastError = ""
    for (const attempt of attempts) {
      // oxlint-disable-next-line no-await-in-loop -- candidates are tried in order
      const result = await fetchContents(attempt.ref, attempt.path)
      if (!result.startsWith("gh api error:")) return result
      lastError = result
      if (!result.includes("404") && !result.includes("No commit found")) break
    }
    if (attempts.length > 1) return lastError

    // The ref may only resolve through the branches endpoint (e.g. a slash-containing branch
    // when no usable path split exists).
    const branchRes = await ghJson<{ commit?: { sha?: string } }>(`repos/${owner}/${repo}/branches/${id}`, ctx)
    if (branchRes.code !== 0) return lastError

    const sha = branchRes.data?.commit?.sha
    if (sha) return fetchContents(sha, path)

    return lastError
  }

  return `Unknown GitHub resource type: ${type}`
}
