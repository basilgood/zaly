import type { Content, ToolContext } from "@zaly/ai"

import { AiError, defineTool, toAttachment } from "@zaly/ai"
import { normPath } from "@zaly/shared"
import { fileDetect } from "@zaly/shared/detect"
import { normalizeEol } from "@zaly/shared/text"
import { stat } from "node:fs/promises"
import { Type } from "typebox"

/**
 * Read a file from disk.
 *
 * Output shape:
 *   - Text files → numbered lines, `cat -n` style (6-char padded number,
 *     tab, content). Line numbers reflect the absolute line in the file
 *     even when reading a slice via `offset`/`limit`.
 *   - Image files (png, jpeg, webp, gif, avif, …) → `ImagePart` attachment.
 *     The model sees the image natively if its modality supports it.
 *   - Other binary files → `BINARY_FILE` error with a hint.
 *
 * Path resolution: relative paths resolve against the agent's session
 * cwd via `process.cwd()` for now. When the permission system gates this
 * via a tool-side hook, the cwd from `PermissionContext` will be used
 * instead so resolution stays consistent across the loop.
 */
const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
/** Beyond this, a read result can't fit context anymore — reject up
 *  front (see the size guard in `call`). */
const MAX_READ_BYTES = 5 * 1024 * 1024

export type ReadTool = typeof readTool

export type FileMeta = {
  path: string
  mtime: number
  kind: "read" | "write" | "edit"
  /** True when the result reflects the whole-file content — set by
   *  un-sliced `read` and by `write` (which always replaces the
   *  full file). `edit` never sets it because the result is
   *  patch-relative. */
  full?: boolean
}

export type ReadToolMeta = FileMeta & {
  offset: number
  limit: number
}

/** Build the `read` tool with model-aware schema description. The
 *  attachment-shape blurb is included only when the loaded model
 *  actually accepts the relevant modality — text-only models see a
 *  description that promises only text output, so they don't reach
 *  for the tool expecting images they can't process. */
// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const readTool = defineTool({
  name: "read",
  desc: `Read a file. Text files return numbered lines (\`cat -n\` style). Image & PDF files are sent as attachments. Use \`offset\`/\`limit\` to slice large files.`,
  parallel: true,
  // oxlint-disable-next-line sort-keys -- semantic param order
  params: Type.Object({
    path: Type.String({ description: "Path to the file. Absolute or cwd-relative." }),
    offset: Type.Optional(
      Type.Integer({
        default: 1,
        description:
          "1-based line number to start at. Negative values count from " +
          "the end: -50 starts 50 lines before EOF (so `offset: -50` " +
          "with the default limit returns the last 50 lines, like " +
          "`tail -n 50`). `offset: -50, limit: 20` reads 20 lines " +
          "starting 50 from the end.",
      })
    ),
    limit: Type.Optional(
      Type.Integer({
        default: DEFAULT_LIMIT,
        description: "Maximum number of lines to return.",
        minimum: 1,
      })
    ),
  }),

  async preflight(args, ctx: ToolContext<ReadToolMeta>) {
    const path = normPath(ctx.cwd, args.path)
    await ctx.need?.("read", path)
  },

  async call(args, ctx: ToolContext<ReadToolMeta>): Promise<Content> {
    const path = normPath(ctx.cwd, args.path)

    const fileStat = await stat(path).catch((error: unknown) => {
      throw new AiError({
        cause: error,
        code: "NOT_FOUND",
        message: `cannot read ${path}: file not found`,
      })
    })
    if (!fileStat.isFile()) {
      throw new AiError({ code: "NOT_A_FILE", message: `${path} is not a regular file` })
    }

    // Hard ceiling before any bytes are read. A legal default `read`
    // (2000 lines × 2000 chars) on a large enough file would inject more
    // tokens than fit in the context window — the oversized result ships
    // to the provider first. Huge files are addressable via `bash`
    // (jq/rg/head) instead; the error tells the model exactly that. Cap
    // is bytes so it bounds RAM churn and the attachment path
    // (base64 ≈ 4/3×) in one stroke.
    if (fileStat.size > MAX_READ_BYTES) {
      throw new AiError({
        code: "FILE_TOO_LARGE",
        data: { bytes: fileStat.size, cap: MAX_READ_BYTES, path },
        message:
          `${path}: file too large to read (${(fileStat.size / 1e6).toFixed(1)} MB, ` +
          `cap ${(MAX_READ_BYTES / 1024 / 1024).toFixed(0)} MB). ` +
          `Use bash to query it in bounded slices (rg, jq, head, tail, sed).`,
      })
    }

    const file = await fileDetect(path)
    if (!file) {
      throw new AiError({
        code: "READ_ERROR",
        message: `${path}: could not read file`,
      })
    }

    // Threshold-based binary check — files with sporadic control bytes
    // (logs with ANSI styling, source with form feeds) still read as
    // text; only when binary content dominates the sample do we bail.
    if (file.type === "binary") {
      throw new AiError({
        code: "BINARY_FILE",
        data: { bytes: file.data.length, path },
        message: `${path}: binary file (${file.data.length} bytes); not displayable as text`,
      })
    }

    // Skip the expensive conversion when the model can't take the attachment.
    const model = ctx.agent?.model
    if (model && !model.canAttach(file.type as never)) {
      return [{ data: { mime: file.mime }, tag: file.type, type: "meta" }]
    }

    const att = await toAttachment(file)
    if (att) return [att]

    if (file.type !== "text") {
      throw new AiError({
        code: "UNSUPPORTED_FILE",
        data: { path, type: file.type },
        message: `${path}: unsupported file type ${file.type}`,
      })
    }

    const text = new TextDecoder().decode(file.data)
    const slice = formatTextSlice(text, {
      limit: args.limit ?? DEFAULT_LIMIT,
      offset: args.offset ?? 1,
    })

    // Record the read so the freshness tracker knows we've seen this
    // file's current bytes. write/edit consult this before mutating.
    ctx.meta = {
      full: slice.full,
      kind: "read",
      limit: slice.limit,
      mtime: fileStat.mtimeMs,
      offset: slice.offset,
      path,
    }

    return slice.content
  },
})

/** Format a slice of file content as numbered lines plus, when the
 *  slice doesn't cover the whole file, a `<slice>` MetaPart with
 *  "showing X-Y of Z" info is included, Full reads return a plain
 *  string for the cleanest model surface. */
function formatTextSlice(
  content: string,
  { offset, limit }: { offset: number; limit: number }
): { content: Content; full?: boolean; offset: number; limit: number } {
  // Normalize line endings to LF for display. The model always sees LF;
  // edit/write detect the file's actual style and re-apply it on disk.
  content = normalizeEol(content)
  const lines = content.split("\n")
  // `split` on a final newline produces a trailing empty string — drop
  // it so a 3-line file with trailing LF reads as 3 lines, not 4.
  if (lines.at(-1) === "") lines.pop()

  // Negative offset = "from the end" — Python-slice / `tail -n` semantic.
  // `-1000` on a 30-line file clamps to 0 (read whole file) rather than
  // erroring; `0` is treated as `1` (head, off-by-one tolerance).
  let start = offset < 0 ? Math.max(0, lines.length + offset) : Math.max(0, offset - 1)
  // Overshoot clamps to `lines.length` so the slice loop emits nothing.
  // The agent gets an empty text + a `<slice>` meta that reports the
  // real file size, then can re-issue with a sensible offset.
  if (start >= lines.length) start = lines.length
  const end = Math.min(lines.length, start + limit)

  const out: string[] = []
  for (let i = start; i < end; i++) {
    const lineNo = (i + 1).toString().padStart(6, " ")
    let line = lines[i]
    if (line.length > MAX_LINE_LENGTH) {
      line = `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated, ${line.length} chars]`
    }
    out.push(`${lineNo}\t${line}`)
  }

  const text = out.join("\n")
  const full = start === 0 && end === lines.length
  if (full) return { content: text, full, limit: lines.length, offset: 1 }

  // Empty slice (overshot offset): tell the agent the offset they asked
  // for and the real file size, rather than emitting a nonsensical
  // "showing 6-5 of 5"-style range.
  const sliceMsg =
    start === end
      ? `offset ${offset} past end of file (${lines.length} lines)`
      : `showing ${start + 1}-${end} of ${lines.length}`

  return {
    content: [
      { content: sliceMsg, tag: "slice", type: "meta" },
      { text, type: "text" },
    ],
    full,
    limit: end - start,
    offset: start + 1,
  }
}
