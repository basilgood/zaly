import type { MetaPart, TextPart, ToolContext } from "@zaly/ai"

import { defineTool } from "@zaly/ai"
import { createHash } from "node:crypto"
import { Type } from "typebox"
import { assertGh, budgetTruncate, filterLog, GH_DEFAULT_MAX_TOKENS, runGh } from "./gh-shared.ts"

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

export function parseGitHubUrl(
  url: string
): { owner: string; repo: string; type: string; id: string; suffix?: string; format?: string } | undefined {
  const cleanUrl = url.split("#")[0]
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
        `repos/owner/repo/pulls/123.`,
    }),
    mode: Type.Optional(
      Type.Union(
        [Type.Literal("diff"), Type.Literal("json"), Type.Literal("log"), Type.Literal("metadata")],
        {
          default: "json",
          description:
            `What to fetch: 'diff' for PR/commit diffs, 'json' for structured data (default), 'log' for CI job logs, ` +
            `'metadata' for run/job metadata (alias of 'json').`,
        }
      )
    ),
    grep: Type.Optional(
      Type.String({
        description:
          `Regex; when set, log output is filtered to lines matching it (e.g. '✘' for failing test lines). ` +
          `Only used with mode 'log'. ALWAYS pass this when inspecting failures — the full log is extremely token-expensive.`,
      })
    ),
    head: Type.Optional(
      Type.Integer({
        default: 10,
        description: "Max matching log lines to return when grep is set (default 10).",
      })
    ),
    jq: Type.Optional(
      Type.String({
        description:
          `jq expression applied to gh api responses, e.g. ".full_name, .description". ` +
          `Passed as --jq to gh api; only applies to raw API paths and commit JSON. ` +
          `Use it to keep JSON responses small.`,
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
    const mode = args.mode === "metadata" ? "json" : (args.mode ?? "json")
    const meta: GhToolMeta = { code: 0, durationMs: 0, mode, ok: true, url }
    const text = await fetchGh(url, { grep, head, jq, mode }, ctx)
    const budget = budgetTruncate(text, {
      hint: "output exceeded budget; pass `jq` to filter JSON or `grep`/`head` for logs.",
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
    const { stdout, stderr, code } = await runGh(["api", url, ...(jq ? ["--jq", jq] : [])], ctx)
    if (code !== 0) return `gh api error: ${stderr}`
    return stdout
  }

  const parsed = parseGitHubUrl(url)
  if (!parsed) {
    return `Failed to parse GitHub URL. Use a raw gh api path instead, e.g., repos/owner/repo/pulls/123`
  }

  const { owner, repo, type, id, suffix, format } = parsed
  const diffHash = parseDiffHash(url)

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
          const { stdout, stderr, code } = await runGh(
            ["api", `repos/${owner}/${repo}/pulls/${id}/files?per_page=100&page=${page}`],
            ctx
          )
          if (code !== 0) return `gh api PR files error: ${stderr}`
          try {
            const pageFiles = JSON.parse(stdout)
            allFiles.push(...pageFiles)
            done = pageFiles.length < 100
            page++
          } catch {
            done = true
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
      const { stdout, stderr, code } = await runGh(["pr", "diff", id, "--repo", `${owner}/${repo}`], ctx)
      if (code !== 0) return `gh pr diff error: ${stderr}`
      return stdout
    }

    const { stdout, stderr, code } = await runGh(
      ["pr", "view", id, "--repo", `${owner}/${repo}`, "--json", "title,body,url,state,additions,deletions,changedFiles,files,headRefOid,headRefName"],
      ctx
    )
    if (code !== 0) return `gh pr view error: ${stderr}`
    return stdout
  }

  if (type === "actions") {
    if (suffix?.startsWith("jobs/")) {
      const jobId = suffix.replace("jobs/", "")
      if (mode === "log") {
        const { stdout, stderr, code } = await runGh(["run", "view", "--job", jobId, "--repo", `${owner}/${repo}`, "--log"], ctx)
        if (code !== 0) return `gh run view --job log error: ${stderr}`
        return filterLog(stdout, grep, head)
      }
      const { stdout, stderr, code } = await runGh(
        ["run", "view", "--job", jobId, "--repo", `${owner}/${repo}`, "--json", "name,status,conclusion,steps"],
        ctx
      )
      if (code !== 0) return `gh run view --job error: ${stderr}`
      return stdout
    }

    if (mode === "log") {
      const { stdout, stderr, code } = await runGh(["run", "view", id, "--repo", `${owner}/${repo}`, "--log-failed"], ctx)
      if (code !== 0) return `gh run view --log-failed error: ${stderr}`
      return filterLog(stdout, grep, head)
    }
    const { stdout, stderr, code } = await runGh(
      ["run", "view", id, "--repo", `${owner}/${repo}`, "--json", "name,status,conclusion,jobs"],
      ctx
    )
    if (code !== 0) return `gh run view error: ${stderr}`
    return stdout
  }

  if (type === "commit") {
    if (mode === "diff") {
      const { stdout, stderr, code } = await runGh(
        ["api", `repos/${owner}/${repo}/commits/${id}`, "-H", "Accept: application/vnd.github.v3.diff"],
        ctx
      )
      if (code !== 0) return `gh api commit diff error: ${stderr}`
      return stdout
    }
    const { stdout, stderr, code } = await runGh(
      ["api", `repos/${owner}/${repo}/commits/${id}`, ...(jq ? ["--jq", jq] : [])],
      ctx
    )
    if (code !== 0) return `gh api commit error: ${stderr}`
    return stdout
  }

  if (type === "issues") {
    const { stdout, stderr, code } = await runGh(
      ["issue", "view", id, "--repo", `${owner}/${repo}`, "--json", "title,body,labels,state,comments"],
      ctx
    )
    if (code !== 0) return `gh issue view error: ${stderr}`
    return stdout
  }

  if (type === "tree") {
    const ref = id
    const path = suffix ?? ""
    const apiPath = path ? `repos/${owner}/${repo}/contents/${path}?ref=${ref}` : `repos/${owner}/${repo}/contents?ref=${ref}`
    const { stdout, stderr, code } = await runGh(["api", apiPath], ctx)
    if (code !== 0) return `gh api contents error: ${stderr}`
    try {
      const items = JSON.parse(stdout)
      if (!Array.isArray(items)) return stdout
      const listing = items.map((item: { type: string; name: string }) => `${item.type === "dir" ? "directory" : "file"}: ${item.name}`).join("\n")
      return listing || "(empty directory)"
    } catch {
      return stdout
    }
  }

  if (type === "blob") {
    const ref = id
    const path = suffix ?? ""

    const fetchContents = async (refOrSha: string): Promise<string> => {
      const { stdout, stderr, code } = await runGh(["api", `repos/${owner}/${repo}/contents/${path}?ref=${refOrSha}`], ctx)
      if (code !== 0) return `gh api error: ${stderr}`
      try {
        const data = JSON.parse(stdout)
        if (data.content && data.encoding === "base64") {
          return Buffer.from(data.content, "base64").toString("utf8")
        }
        if (Array.isArray(data)) {
          const listing = data.map((item: { type: string; name: string }) => `${item.type === "dir" ? "directory" : "file"}: ${item.name}`).join("\n")
          return listing || "(empty directory)"
        }
        return stdout
      } catch {
        return stdout
      }
    }

    const isSha = /^[a-f0-9]{40}$/i.test(ref)
    if (isSha) return fetchContents(ref)

    const firstAttempt = await fetchContents(ref)
    if (!firstAttempt.startsWith("gh api error:")) return firstAttempt

    const is404 = firstAttempt.includes("404") || firstAttempt.includes("No commit found")
    if (!is404) return firstAttempt

    const { stdout: branchStdout, code: branchExitCode } = await runGh(["api", `repos/${owner}/${repo}/branches/${ref}`], ctx)
    if (branchExitCode !== 0) return firstAttempt

    try {
      const branch = JSON.parse(branchStdout)
      const sha = branch.commit?.sha
      if (sha) return fetchContents(sha)
    } catch {}

    return firstAttempt
  }

  return `Unknown GitHub resource type: ${type}`
}
