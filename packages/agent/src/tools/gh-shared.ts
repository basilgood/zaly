import type { ToolContext } from "@zaly/ai"

import { AiError } from "@zaly/ai"
import { randomHash } from "@zaly/shared"
import type { Stream } from "@zaly/shared/process"
import { Spawn, which } from "@zaly/shared/process"
import { createReadStream, createWriteStream, mkdirSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "pathe"
import { createInterface } from "node:readline"
import { truncate } from "../utils/truncate.ts"

// ── URL / ID parsing ───────────────────────────────────────────────────

export type GhRepo = { owner: string; repo: string }

/** Owner/repo from any github.com URL. */
export function parseRepo(url: string): GhRepo | undefined {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)/)
  return m ? { owner: m[1], repo: m[2] } : undefined
}

/** Run/check-run ID, plus the job ID when the URL names one, from any GitHub
 *  Actions/checks URL. `jobs?` covers both the web UI's /job/ and API /jobs/.
 *  `kind` records which resource the URL names, so callers know when the ID is
 *  unambiguous: only a bare numeric ID can be either. */
export function extractGhIds(url: string): { id: string; jobId?: string; kind: "run" | "check" } | undefined {
  const jobMatch = url.match(/\/runs\/(\d+)\/jobs?\/(\d+)/)
  if (jobMatch) return { id: jobMatch[1], jobId: jobMatch[2], kind: "run" }
  // /runs/… also matches inside /actions/runs/…; check-runs has its own path.
  const runMatch = url.match(/\/runs\/(\d+)/)
  if (runMatch) return { id: runMatch[1], kind: "run" }
  const checkMatch = url.match(/\/check-runs\/(\d+)/)
  if (checkMatch) return { id: checkMatch[1], kind: "check" }
  // PR checks page query string: /pull/1091/checks?check_run_id=123
  const q = url.match(/[?&]check_run_id=(\d+)/)
  if (q) return { id: q[1], kind: "check" }
  return undefined
}

export function isGhUrl(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://")
}

export function isNumericId(value: string): boolean {
  return /^\d+$/.test(value)
}

/** Run `gh <args>`, returning stdout plus the exit code. Shared by every gh
 *  tool so callers never touch the process layer directly. */
export async function ghText(args: string[], ctx: ToolContext): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await runGh(args, ctx)
  return { code: out.code, stderr: out.stderr, stdout: readOutput(out) }
}

/** `gh api <path>` parsed as JSON. Non-JSON bodies come back as raw strings so
 *  a plain-text endpoint degrades gracefully instead of throwing. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller's response shape
export async function ghJson<T = unknown>(
  apiPath: string,
  ctx: ToolContext
): Promise<{ data: T | undefined; error: string | undefined; code: number; stdout: string }> {
  const { code, stderr, stdout } = await ghText(["api", apiPath], ctx)
  if (code !== 0) return { code, data: undefined, error: `gh api ${apiPath}: ${stderr || stdout}`, stdout }
  try {
    return { code, data: JSON.parse(stdout) as T, error: undefined, stdout }
  } catch {
    return { code, data: stdout as unknown as T, error: undefined, stdout }
  }
}

/** Bound `gh api` reader passed between resolve helpers. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller's response shape
export type GhApi = <T>(path: string) => Promise<{ data: T | undefined; error: string | undefined }>

export const GH_TIMEOUT_MS = 60_000
// Hard kill switch. Far above this threshold output is spilled to disk, so this
// only fires on a runaway process, not on an ordinarily huge log.
export const GH_MAX_BUFFER = 512 * 1024 * 1024 // 512 MB
/** Past this many captured chars the run spills to disk and streams there, so a
 *  60 MB CI log costs a file handle instead of 60 MB of heap. */
export const GH_MEMORY_BUDGET = 2 * 1024 * 1024 // 2 MB
export const GH_DEFAULT_MAX_TOKENS = 4000 // like bash — cap on inline output
export const GH_MAX_LINE_CHARS = 500 // like grep's rg setting — log lines carry timestamps
export const GH_MAX_LINES = 200 // like bash's max_lines default

export type GhTruncated = { bytes: number; fullOutputPath: string; hint: string; lines: number }

export type GhOutput = {
  code: number
  /** Captured text — empty once `path` is set, so the bytes stay off the heap. */
  stdout: string
  stderr: string
  /** Set when output exceeded `GH_MEMORY_BUDGET`; `stdout` then lives here. */
  path?: string
}

/** Throw when the gh CLI is not on PATH. */
export function assertGh(): void {
  if (!which("gh")) {
    throw new AiError({ code: "MISSING_TOOL", message: "gh requires the GitHub CLI (gh)" })
  }
}

/** Above this many unflushed bytes the child is paused (see `blocked`). */
const HIGH_WATER = 256 * 1024

/** Captures a process stream, staying on the heap only while the output is
 *  small. Past `budget` chars it opens a file and every later chunk goes
 *  straight to disk, so a 60 MB CI log never becomes a 60 MB string. */
class CaptureStream implements Stream<string> {
  #decoder = new TextDecoder()
  #chunks: string[] = []
  #chars = 0
  #writer?: ReturnType<typeof createWriteStream>
  #closed?: Promise<void>
  #done = false

  constructor(
    private readonly budget: number,
    private readonly resolvePath: () => string,
    private readonly hooks: { onBlocked?: () => void; onDrained?: () => void } = {}
  ) {}

  get path(): string | undefined {
    return this.#writer ? this.resolvePath() : undefined
  }
  get result(): string {
    return this.#writer ? "" : this.#chunks.join("")
  }
  get done(): boolean {
    return this.#done
  }
  close(): Promise<void> {
    return this.#closed ?? Promise.resolve()
  }

  add(chunk: Buffer): void {
    const text = this.#decoder.decode(chunk, { stream: true })
    this.#chars += text.length
    if (this.#writer) {
      this.#writer.write(text)
      // Pause immediately when the writer falls behind — waiting for a poll
      // lets a fast producer buffer tens of MB on the heap first.
      if (this.#writer.writableLength > HIGH_WATER) this.hooks.onBlocked?.()
      return
    }
    this.#chunks.push(text)
    if (this.#chars > this.budget) this.#spill()
  }

  finish(): void {
    if (this.#done) return
    this.#done = true
    const tail = this.#decoder.decode()
    if (this.#writer) {
      if (tail) this.#writer.write(tail)
      this.#closed = new Promise<void>((resolve) => this.#writer?.end(() => resolve()))
      return
    }
    if (tail) this.#chunks.push(tail)
  }

  #spill(): void {
    const path = this.resolvePath()
    mkdirSync(join(path, ".."), { recursive: true })
    this.#writer = createWriteStream(path, { flags: "w" })
    this.#writer.on("error", () => {})
    this.#writer.on("drain", () => this.hooks.onDrained?.())
    for (const text of this.#chunks) this.#writer.write(text)
    this.#chunks = []
  }
}

/** Run a gh subcommand. Non-zero exit is not an error; callers branch on
 *  `code`. Small outputs come back as `stdout`; anything past the capture
 *  budget lands in `path` instead, so it can be read or grepped from disk. */
export async function runGh(args: string[], ctx: ToolContext): Promise<GhOutput> {
  const stdoutPath = ghOutputPath(ctx)
  // stderr stays small — gh only writes a message there — so keep it simple.
  const stderrChunks: string[] = []
  const stderrStream: Stream<string> = {
    add: (chunk) => stderrChunks.push(chunk.toString()),
    done: false,
    finish: () => {},
    result: "",
  }
  const stdoutStream = new CaptureStream(GH_MEMORY_BUDGET, () => stdoutPath, {
    onBlocked: () => proc.child.stdout?.pause(),
    onDrained: () => proc.child.stdout?.resume(),
  })

  const proc = new Spawn<string, string>("gh", args, {
    maxBuffer: GH_MAX_BUFFER,
    signal: ctx.signal,
    stderr: stderrStream,
    stdout: stdoutStream,
    timeout: GH_TIMEOUT_MS,
  })

  const result = await proc.result.catch((error: unknown) => {
    throw new AiError({ cause: error, code: "GH_FAILED", message: String(error) })
  })
  const path = stdoutStream.path
  if (path) await stdoutStream.close()
  const stderr = stderrChunks.join("")
  if (path) return { code: result.code, path, stderr, stdout: "" }
  return { code: result.code, stderr, stdout: stdoutStream.result }
}

/** Run a jq filter over a JSON string captured from gh. Compact output (`-c`)
 *  so lists of objects cost one line each instead of pretty-printed blobs. */
export async function runJq(
  filter: string,
  json: string,
  ctx: ToolContext
): Promise<{ ok: boolean; text: string }> {
  if (!which("jq")) return { ok: false, text: "jq is not installed, so `jq` cannot be applied" }
  const errChunks: string[] = []
  const errStream: Stream<string> = {
    add: (chunk) => errChunks.push(chunk.toString()),
    done: false,
    finish: () => {},
    result: "",
  }
  const capture = new CaptureStream(GH_MEMORY_BUDGET, () => jqOutputPath(ctx))
  const proc = new Spawn<string, string>("jq", ["-c", filter], {
    signal: ctx.signal,
    stderr: errStream,
    stdin: json,
    stdout: capture,
    timeout: GH_TIMEOUT_MS,
  })
  const result = await proc.result.catch((error: unknown) => {
    throw new AiError({ cause: error, code: "GH_FAILED", message: String(error) })
  })
  const path = capture.path
  if (path) await capture.close()
  if (result.code !== 0) return { ok: false, text: `jq error: ${errChunks.join("")}` }
  const text = path ? readFileSync(path, "utf8") : capture.result
  return { ok: true, text }
}

function jqOutputPath(ctx: ToolContext): string {
  const dir = ctx.sessionDir ?? join(tmpdir(), "zaly-gh")
  return join(dir, `jq-${randomHash()}.log`)
}

export function readOutput(out: GhOutput): string {
  if (!out.path) return out.stdout
  try {
    return readFileSync(out.path, "utf8")
  } catch {
    return out.stdout
  }
}

/** `filterLog` over a spilled file — scans line by line so a multi-MB log is
 *  never materialised just to grep it. */
async function filterLogFile(path: string, grep: string, head: number): Promise<string> {
  const re = compileGrep(grep)
  if (typeof re === "string") return re
  // Single streaming pass: the job/step prefix is learned from the first line,
  // so the scan stays O(1) in memory however large the log is.
  let strip: ((line: string) => string) | undefined
  const kept: string[] = []
  let matches = 0
  const rl = createInterface({ crlfDelay: Infinity, input: createReadStream(path) })
  for await (const raw of rl) {
    strip ??= makeLogStripper(raw)
    const line = strip(raw)
    if (!re.test(line)) continue
    matches++
    if (kept.length < head) kept.push(line)
  }
  return summarizeGrep(matches, kept)
}

function summarizeGrep(matches: number, kept: string[]): string {
  const summary = `${matches} matching line(s), showing first ${kept.length}${kept.length < matches ? ` — ${matches - kept.length} not shown, raise head to see more` : ""}`
  return kept.length > 0 ? `${summary}\n${kept.join("\n")}` : summary
}

/** Keep only lines matching `grep`, capped by `head`. `out` may be spilled, in
 *  which case the scan happens on disk. */
export async function filterOutput(out: GhOutput, grep?: string, head?: number): Promise<string> {
  if (!grep) return readOutput(out)
  if (out.path) return filterLogFile(out.path, grep, head ?? 10)
  return filterLog(out.stdout, grep, head)
}

function compileGrep(grep: string): RegExp | string {
  try {
    return new RegExp(grep)
  } catch {
    return `Invalid grep regex: ${grep}`
  }
}

/**
 * One-line structural summary of a JSON payload, so the model can pick a `jq`
 * path without a second round trip. Lists report their element shape; objects
 * report their keys. Returns undefined for non-JSON input.
 */
export function describeJsonShape(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return "shape: empty array"
    return `shape: array of ${data.length} x ${summarizeValue(data[0])}`
  }
  if (data && typeof data === "object") {
    const keys = Object.keys(data as object)
    if (keys.length === 0) return "shape: empty object"
    const shown = keys.slice(0, 24)
    const more = keys.length > shown.length ? `, … ${keys.length - shown.length} more` : ""
    return `shape: object keys = ${shown.join(", ")}${more}`
  }
  return `shape: ${summarizeValue(data)}`
}

function summarizeValue(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) {
    return value.length === 0 ? "empty array" : `array of ${value.length} x ${summarizeValue(value[0])}`
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object)
    return keys.length === 0 ? "empty object" : `object {${keys.slice(0, 12).join(",")}}`
  }
  return typeof value
}


const BASE64 = /^[A-Za-z0-9+/\s]*={0,2}$/

type GhEnvelopeItem = { content?: unknown; encoding?: unknown; name?: unknown; path?: unknown; type?: unknown }

function isBase64Item(item: GhEnvelopeItem): boolean {
  return typeof item.content === "string" && item.encoding === "base64" && BASE64.test(item.content.trim())
}

/** Render a GitHub API JSON payload into text an agent can read directly:
 *  base64 file content is decoded, directory listings become a compact
 *  `type: name` list, JSON objects/arrays are pretty-printed, and anything
 *  else (plain text, diffs, logs) is returned unchanged. */
export function renderGhPayload(stdout: string): string {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return stdout
  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    return stdout
  }
  if (data && typeof data === "object" && !Array.isArray(data) && isBase64Item(data as GhEnvelopeItem)) {
    return Buffer.from(((data as GhEnvelopeItem).content as string).trim(), "base64").toString("utf8")
  }
  const items = toEnvelopeItems(data)
  if (items?.length && items.every((item) => typeof item.name === "string" && typeof item.type === "string")) {
    return items.map(formatEnvelopeItem).join("\n")
  }
  // Pretty-print so the model does not have to scan one enormous JSON line.
  return JSON.stringify(data, undefined, 2)
}

function toEnvelopeItems(data: unknown): GhEnvelopeItem[] | undefined {
  if (Array.isArray(data)) return data as GhEnvelopeItem[]
  if (data && typeof data === "object" && Array.isArray((data as { entries?: unknown }).entries)) {
    return (data as { entries: GhEnvelopeItem[] }).entries
  }
  return undefined
}

function formatEnvelopeItem(item: GhEnvelopeItem): string {
  let label = String(item.type)
  if (item.type === "dir") label = "directory"
  else if (item.type === "file") label = "file"
  return `${label}: ${String(item.name)}`
}

/** Per-call output path under the session dir (like bash), so truncated or
 *  spilled captures can be `read({ path })` later. */
export function ghOutputPath(ctx: ToolContext): string {
  const dir = ctx.sessionDir ?? join(tmpdir(), "zaly-gh")
  return join(dir, `gh-${randomHash()}.log`)
}

/** Spill truncated output to the session dir (like bash) so the model can
 *  `read({ path })` the dropped part instead of losing it. Best-effort: a
 *  write failure just means no path is surfaced. */
async function spillOutput(text: string, ctx: ToolContext): Promise<string | undefined> {
  try {
    const path = ghOutputPath(ctx)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, text, "utf8")
    return path
  } catch {
    return undefined
  }
}

/** Warn when a jq filter was written against a different response shape.
 *  `gh run view --json` is camelCase (`headBranch`), the REST API is snake_case
 *  (`head_branch`) — a filter using the wrong one silently yields nulls, which
 *  reads like "the data is missing" rather than "your field name is wrong". */
export function assertJqFieldsExist(filter: string, output: string, applied?: string): string | undefined {
  // Only worth reporting if jq actually emitted a null.
  if (applied !== undefined && !/\bnull\b/.test(applied)) return undefined
  const root = parseJqShape(output)
  if (root === undefined) return undefined

  // Each field is validated against the node jq reads it from, not the response
  // root: in `.jobs[] | {name, id}` the `id` belongs to a job, so checking it
  // against the run object would report the wrong keys (or, previously, nothing
  // at all — the projection was never inspected, and the nulls came through).
  const missing = new Map<string, string[]>()
  const check = (name: string, node: unknown): void => {
    if (!node || typeof node !== "object" || name in node) return
    missing.set(name, Object.keys(node))
  }

  let node: unknown = root
  for (const rawSeg of filter.split("|")) {
    const seg = rawSeg.trim()
    // Every key in a projection reads from the node the projection was applied
    // to, so the base is captured before the parts are walked.
    const base = node
    const projections = [...seg.matchAll(/\{\s*([^}]*)\}/g)].map((m) => m[1])

    for (const projection of projections) {
      for (const part of projection.split(",")) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const colon = trimmed.indexOf(":")
        if (colon === -1) {
          // Shorthand `{name, id}` reads the field directly off the node.
          const key = trimmed.match(/^\.?([A-Za-z_][A-Za-z0-9_]*)$/)?.[1]
          if (key) check(key, base)
          continue
        }
        // Explicit `{label: .path}` — the value side is a path expression.
        readJqPath(trimmed.slice(colon + 1).trim(), base, check)
      }
    }

    // jq's `,` is a stream separator, so `.jobs[].name, .head_branch` reads the
    // second field from the *root*, not from the previous field's value.
    const stripped = seg.replace(/\{\s*[^}]*\}/g, "")
    let last: unknown = base
    for (const part of stripped.split(",")) {
      if (!part.trim()) continue
      last = readJqPath(part.trim(), base, check)
    }
    node = last
  }

  if (missing.size === 0) return undefined
  const reported = [...missing].map(([name, keys]) => {
    // Point at the snake_case/camelCase twin when there is one: an unlinked
    // "available" list is what sent callers off to the REST API instead.
    const flat = name.toLowerCase().replaceAll("_", "")
    const twin =
      keys.find((k) => k.toLowerCase().replaceAll("_", "") === flat) ??
      // `gh run view --json jobs` renames the job's `id` to `databaseId`; the
      // REST jobs API calls it `id` again. Not a spelling variant, so the
      // normalised compare above misses it.
      (name === "id" && keys.includes("databaseId") ? "databaseId" : undefined)
    return twin ? `${name} (use ${twin})` : name
  })
  const available = [...new Set([...missing.values()].flat())]
  return (
    `\njq produced nulls: not present where the filter reads them: ${reported.join(", ")}.\n` +
    `Available at that path: ${available.join(", ")}\n` +
    `Note: gh run view --json uses camelCase (headBranch); the REST API uses snake_case (head_branch).`
  )
}

/** Parse a JSON response into the shape jq sees (a list is represented by its
 *  first element, which is what an iterator reads). */
function parseJqShape(output: string): unknown {
  const body = output.trim()
  try {
    if (body.startsWith("[")) {
      const parsed: unknown = JSON.parse(body)
      return Array.isArray(parsed) ? parsed[0] : parsed
    }
    if (body.startsWith("{")) return JSON.parse(body)
  } catch {
    return undefined
  }
  return undefined
}

/** Walk `.field` / `[]` tokens, validating each field at the node it is read
 *  from and returning the node the expression ends on. */
function readJqPath(
  expression: string,
  from: unknown,
  check: (name: string, node: unknown) => void
): unknown {
  let node = from
  for (const m of expression.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[\]/g)) {
    if (m[0] === "[]") {
      node = Array.isArray(node) ? node[0] : undefined
      continue
    }
    check(m[1], node)
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[m[1]] : undefined
  }
  return node
}

/** GitHub prefixes every CI log line with `job \t step \t timestampZ `. Within
 *  one job log that job/step pair is constant, so it is identical noise on every
 *  line: it burns the per-line char budget (GH_MAX_LINE_CHARS) and buries the
 *  message. Match it as a pattern rather than one literal prefix — the timestamp
 *  differs per line, and the leading BOM only appears on the first line. */
export function makeLogStripper(first: string): (line: string) => string {
  // `gh run view --log`: `job \t step \t timestampZ message`.
  const m = first.match(/^([^\t]+)\t([^\t]+)\t\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/)
  if (m) {
    const re = new RegExp(
      `^${escapeRegExp(m[1])}\\t${escapeRegExp(m[2])}\\t\\uFEFF?\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\s?`
    )
    return (line) => line.replace(re, "")
  }
  // `gh api .../actions/jobs/<id>/logs`: no job/step columns, the timestamp
  // leads. `Z` is what keeps this from touching a timestamp in the message body.
  return (line) => line.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "")
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/** GitHub's log endpoints emit colour codes, and `gh api` refuses the response
 *  outright when it finds them. They carry no information once the text is read
 *  as plain output, so drop them rather than surfacing a refusal the caller
 *  cannot act on. */
export function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
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
  const lines = log.split("\n")
  const strip = makeLogStripper(lines[0] ?? "")
  const matches = lines.map(strip).filter((line) => re.test(line))
  const shown = matches.slice(0, head ?? 10)
  return summarizeGrep(matches.length, shown)
}

/** Shared budget policy: cap inline output by tokens, lines, and per-line
 *  chars. Returns the truncated text plus a `GhTruncated` meta when the cap
 *  fired, so the model knows to tighten filters. Truncated runs also spill
 *  the full text to disk and surface `fullOutputPath`. */
export async function budgetTruncate(
  text: string,
  opts: { ctx: ToolContext; hint: string; maxTokens?: number }
): Promise<{ text: string; truncated?: GhTruncated }> {
  const summary = truncate(text, {
    maxChars: (opts.maxTokens ?? GH_DEFAULT_MAX_TOKENS) * 4,
    maxLineChars: GH_MAX_LINE_CHARS,
    maxLines: GH_MAX_LINES,
  })
  if (!summary.truncated) return { text }
  const fullOutputPath = await spillOutput(text, opts.ctx)
  const truncated: GhTruncated = {
    bytes: summary.origBytes,
    fullOutputPath: fullOutputPath ?? "(could not write full output to disk)",
    hint: opts.hint,
    lines: summary.origLines,
  }
  // The model keeps the whole structure even though the body was cut, so the
  // next call can go straight to `jq` instead of refetching to explore.
  const shape = describeJsonShape(text)
  const head = shape ? `${shape}\n` : ""
  const notice = fullOutputPath ? `\n[full output: ${fullOutputPath}]` : ""
  return { text: `${head}${summary.text}${notice}`, truncated }
}
