import type { AnyPart, Attachment, Content, MetaPart, ToolResultPart } from "@zaly/ai"

import { isAttachment } from "@zaly/ai"
import { estimatePart } from "./tokens.ts"

/** Meta tag the masking layer renders digest stubs under. */
export const ELIDED_TAG = "elided"

/** Max length of a derived `firstLine` before it gets an ellipsis. Long
 *  enough to recognize a payload, short enough that a masked stub stays
 *  a stub. */
const MAX_FIRST_LINE = 160

/** 1-based, inclusive line range a read result carried. `total` is the
 *  file's line count when the original content knew it. */
export type DigestRange = {
  from: number
  to: number
  total?: number
}

/** Facts-only description of a content part, derived from the tool meta
 *  captured at execution time — no instructions, no prose. Every field
 *  answers a "what did I have?" question so a model reading a masked
 *  result knows exactly which facts survived and which are gone.
 *
 *  The masking layer renders this as an `<elided>` `MetaPart`; keeping
 *  the deriver pure means the renderer and tests can both treat it as
 *  plain data. */
export type Digest = {
  /** Tool that produced the result, or the part type for non-tool parts. */
  tool: string
  /** Approximate tokens the original part occupied. */
  tokens: number
  /** First non-empty line of the result text, truncated. */
  firstLine?: string
  /** Line number of the owning message in the session transcript. */
  transcriptLine?: number

  // ── File facts (read / write / edit) ───────────────────────────────
  path?: string
  kind?: "read" | "write" | "edit"
  /** True when the result reflected the whole file. */
  full?: boolean
  range?: DigestRange
  /** File mtime (ms) recorded when the tool executed. */
  mtime?: number
  /** Stat probe at mask time found a different mtime — the file changed
   *  since the result was captured. Absent when not probed. */
  changed?: boolean
  /** Stat probe at mask time found the path gone. */
  missing?: boolean

  // ── Process facts (bash) ────────────────────────────────────────────
  status?: string
  code?: number
  killReason?: string
  /** Full output path when the result was truncated. */
  fullPath?: string
  totalLines?: number
  truncated?: boolean

  // ── Media facts (attachments) ──────────────────────────────────────
  mime?: string
  url?: string

  // ── Subagent facts ─────────────────────────────────────────────────
  stop?: string
}

export type DigestOptions = {
  /** Line number of the message holding this part in the session
   *  transcript, when known. */
  transcriptLine?: number
  /** Freshness probe for file-backed parts: returns the path's current
   *  mtime in ms, or `undefined` when the path no longer exists.
   *  Injected so the deriver performs no I/O itself — the masking layer
   *  passes a lookup it already resolved. */
  stat?: (path: string) => number | undefined
}

/** Derive the facts-only digest of a content part. Pure: the only inputs
 *  are the part, the options, and whatever `opts.stat` returns. */
export function digestOf(part: AnyPart, opts: DigestOptions = {}): Digest {
  const digest: Digest = { tokens: estimatePart(part).tokens, tool: nameOf(part) }
  if (opts.transcriptLine !== undefined) digest.transcriptLine = opts.transcriptLine
  const first = firstLineOf(part)
  if (first !== undefined) digest.firstLine = first
  if (part.type === "tool-result") resultDigest(part, digest, opts)
  else if (isAttachment(part)) attachmentDigest(part, digest)
  return digest
}

function nameOf(part: AnyPart): string {
  if (part.type === "tool-result" || part.type === "tool-call") return part.name
  return part.type
}

function resultDigest(part: ToolResultPart, digest: Digest, opts: DigestOptions): void {
  // Facts live in two places: the sidecar (`ToolResultPart.meta`, set by
  // file tools) and embedded `MetaPart.data` blocks (bash / gh / subagent
  // snapshot their runtime facts into content). Merge both; the sidecar
  // wins on conflicts since it's the tool's own record.
  const meta = mergedMeta(part)

  const path = meta && typeof meta.path === "string" ? meta.path : undefined
  const kind = meta ? fileKind(meta.kind) : undefined
  const mtime = meta && typeof meta.mtime === "number" ? meta.mtime : undefined
  if (path !== undefined && kind !== undefined && mtime !== undefined) {
    digest.path = path
    digest.kind = kind
    digest.mtime = mtime
    if (meta?.full === true) digest.full = true
    if (
      part.name === "read" &&
      typeof meta?.offset === "number" &&
      typeof meta.limit === "number" &&
      meta.limit > 0
    ) {
      const range: DigestRange = { from: meta.offset, to: meta.offset + meta.limit - 1 }
      const total = sliceTotal(part.content) ?? (meta.full === true ? meta.limit : undefined)
      if (total !== undefined) range.total = total
      digest.range = range
    }
    freshness(digest, opts)
  }

  if (meta) {
    if (typeof meta.status === "string") digest.status = meta.status
    if (typeof meta.code === "number") digest.code = meta.code
    if (typeof meta.killReason === "string") digest.killReason = meta.killReason
    if (typeof meta.stop === "string") digest.stop = meta.stop
    if (typeof meta.url === "string") digest.url = meta.url
    truncation(meta.truncated, digest)
  }

  // Attachment-only results (a read of an image, a screenshot tool) carry
  // no file meta — mine the payload itself.
  if (digest.path === undefined && digest.mime === undefined) {
    const attachment = firstAttachment(part.content)
    if (attachment) attachmentDigest(attachment, digest)
  }
}

/** Merge every embedded `MetaPart.data` record with the sidecar meta.
 *  Sidecar fields override embedded ones. Returns `undefined` when
 *  neither source had a record. */
function mergedMeta(part: ToolResultPart): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined
  if (Array.isArray(part.content)) {
    for (const inner of part.content) {
      if (inner.type !== "meta") continue
      const data = record(inner.data)
      if (data) merged = Object.assign(merged ?? {}, data)
    }
  }
  const sidecar = record(part.meta)
  if (sidecar) merged = Object.assign(merged ?? {}, sidecar)
  return merged
}

/** Consult the injected stat probe for a file-backed part. A missing
 *  probe leaves `changed` / `missing` unknown rather than guessing. */
function freshness(digest: Digest, opts: DigestOptions): void {
  if (digest.path === undefined || digest.mtime === undefined || opts.stat === undefined) return
  const fresh = opts.stat(digest.path)
  if (fresh === undefined) digest.missing = true
  else digest.changed = fresh !== digest.mtime
}

/** Map the two truncation meta shapes onto the digest: bash snapshots
 *  carry `{ fullOutputPath, totalLines }`, gh tools carry
 *  `{ bytes, hint, lines }`, and some tools only set a boolean. */
function truncation(value: unknown, digest: Digest): void {
  if (value === true) {
    digest.truncated = true
    return
  }
  const trunc = record(value)
  if (!trunc) return
  digest.truncated = true
  if (typeof trunc.fullOutputPath === "string") digest.fullPath = trunc.fullOutputPath
  else if (typeof trunc.fullPath === "string") digest.fullPath = trunc.fullPath
  if (typeof trunc.totalLines === "number") digest.totalLines = trunc.totalLines
  else if (typeof trunc.lines === "number") digest.totalLines = trunc.lines
}

function attachmentDigest(part: Attachment, digest: Digest): void {
  digest.mime = part.mime
  if (part.source.type === "file") digest.path = part.source.path
  else if (part.source.type === "url") digest.url = part.source.url
}

function firstAttachment(content: Content): Attachment | undefined {
  if (typeof content === "string") return undefined
  for (const part of content) if (isAttachment(part)) return part
  return undefined
}

/** Pull the file's total line count off the `<slice>` meta the read tool
 *  emits for partial slices. Handles both the "showing X-Y of Z" and the
 *  empty-slice "offset N past end of file (Z lines)" phrasing. */
function sliceTotal(content: Content): number | undefined {
  if (typeof content === "string") return undefined
  for (const part of content) {
    if (part.type !== "meta" || part.tag !== "slice" || typeof part.content !== "string") continue
    const match = /of (\d+)$/.exec(part.content) ?? /\((\d+) lines\)/.exec(part.content)
    if (match) return Number(match[1])
  }
  return undefined
}

function firstLineOf(part: AnyPart): string | undefined {
  if (part.type === "tool-result") return firstLineOfContent(part.content)
  if (part.type === "text") return firstLine(part.text)
  if (part.type === "meta" && typeof part.content === "string") return firstLine(part.content)
  if (part.type === "error") return firstLine(part.message)
  return undefined
}

/** Prefer the payload's own text over structural meta ("showing 151-170
 *  of 200") when picking the preview line. */
function firstLineOfContent(content: Content): string | undefined {
  if (typeof content === "string") return firstLine(content)
  for (const part of content) {
    if (part.type !== "text") continue
    const line = firstLine(part.text)
    if (line !== undefined) return line
  }
  for (const part of content) {
    if (part.type === "error") {
      const line = firstLine(part.message)
      if (line !== undefined) return line
    } else if (part.type === "meta" && typeof part.content === "string") {
      const line = firstLine(part.content)
      if (line !== undefined) return line
    }
  }
  return undefined
}

/** First non-empty line, without splitting the whole payload. Leading
 *  whitespace is dropped so structural indentation doesn't crowd the
 *  preview; `cat -n` gutter spaces count as leading whitespace. */
function firstLine(text: string): string | undefined {
  let start = 0
  while (start < text.length) {
    const end = text.indexOf("\n", start)
    const stop = end === -1 ? Math.min(text.length, start + MAX_FIRST_LINE + 1) : end
    const line = text.slice(start, stop).trim()
    if (line !== "") return truncate(line, MAX_FIRST_LINE)
    if (end === -1) break
    start = end + 1
  }
  return undefined
}

function truncate(text: string, len: number): string {
  return text.length <= len ? text : `${text.slice(0, len)}…`
}

function fileKind(value: unknown): "read" | "write" | "edit" | undefined {
  return value === "read" || value === "write" || value === "edit" ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Render a part's digest as an `<elided>` `MetaPart`. The masking layer
 *  wraps this in a content array for tool results, or swaps it in whole
 *  for attachments / task text. Facts only — no instructions. */
export function elidedOf(part: AnyPart, opts: DigestOptions = {}): MetaPart {
  return { data: digestOf(part, opts), tag: ELIDED_TAG, type: "meta" }
}

/** True when a part is a digest stub produced by `elidedOf` (or a tool
 *  result whose content is nothing but stubs). Guards against re-masking
 *  an already elided part. */
export function isElided(part: AnyPart): boolean {
  if (part.type === "meta") return part.tag === ELIDED_TAG
  if (part.type === "tool-result" && Array.isArray(part.content))
    return (
      part.content.length > 0 &&
      part.content.every((p) => p.type === "meta" && p.tag === ELIDED_TAG)
    )
  return false
}
