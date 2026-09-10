import type { ToolContext } from "@zaly/ai"

import { AiError } from "@zaly/ai"
import { Spawn, TextStream, which } from "@zaly/shared/process"
import { truncate } from "../utils/truncate.ts"

export const GH_TIMEOUT_MS = 60_000
export const GH_MAX_BUFFER = 16 * 1024 * 1024 // 16 MB — CI logs can be huge
export const GH_DEFAULT_MAX_TOKENS = 4000 // like bash — cap on inline output
export const GH_MAX_LINE_CHARS = 500 // like grep's rg setting — log lines carry timestamps
export const GH_MAX_LINES = 200 // like bash's max_lines default

export type GhTruncated = { bytes: number; hint: string; lines: number }

/** Throw when the gh CLI is not on PATH. */
export function assertGh(): void {
  if (!which("gh")) {
    throw new AiError({ code: "MISSING_TOOL", message: "gh requires the GitHub CLI (gh)" })
  }
}

/** Run a gh subcommand, returning stdout/stderr/exit code. Non-zero exit is
 *  not an error; callers branch on `code`. */
export async function runGh(
  args: string[],
  ctx: ToolContext
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = new Spawn("gh", args, {
    maxBuffer: GH_MAX_BUFFER,
    signal: ctx.signal,
    stderr: new TextStream(),
    stdout: new TextStream(),
    timeout: GH_TIMEOUT_MS,
  })
  const result = await proc.result.catch((error: unknown) => {
    throw new AiError({ cause: error, code: "GH_FAILED", message: String(error) })
  })
  return { code: result.code, stderr: result.stderr, stdout: result.stdout }
}

/** Keep only lines matching `grep`, capped by `head`. */
export function filterLog(log: string, grep?: string, head?: number): string {
  if (!grep) return log
  let re: RegExp
  try {
    re = new RegExp(grep)
  } catch {
    return `Invalid grep regex: ${grep}`
  }
  const matches = log.split("\n").filter((line) => re.test(line))
  const limit = head ?? 10
  const shown = matches.slice(0, limit)
  const summary = `${matches.length} matching line(s), showing first ${shown.length}`
  return shown.length > 0 ? `${summary}\n${shown.join("\n")}` : summary
}

/** Shared budget policy: cap inline output by tokens, lines, and per-line
 *  chars. Returns the truncated text plus a `GhTruncated` meta when the cap
 *  fired, so the model knows to tighten filters. */
export function budgetTruncate(
  text: string,
  opts: { hint: string; maxTokens?: number }
): { text: string; truncated?: GhTruncated } {
  const summary = truncate(text, {
    maxChars: (opts.maxTokens ?? GH_DEFAULT_MAX_TOKENS) * 4,
    maxLineChars: GH_MAX_LINE_CHARS,
    maxLines: GH_MAX_LINES,
  })
  if (!summary.truncated) return { text }
  return {
    text: summary.text,
    truncated: { bytes: summary.origBytes, hint: opts.hint, lines: summary.origLines },
  }
}
