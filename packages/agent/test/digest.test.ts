import type { Attachment, Message, ToolResultPart } from "@zaly/ai"
import type { Digest } from "../src/context/digest.ts"

import { describe, expect, test } from "vitest"
import { digestOf, elidedOf, isElided } from "../src/context/digest.ts"

const result = (
  part: Omit<Partial<ToolResultPart>, "content"> & {
    content?: ToolResultPart["content"]
    name: string
  }
): ToolResultPart =>
  ({
    content: "",
    id: "call-1",
    type: "tool-result",
    ...part,
  }) as ToolResultPart

const text = (value: string) => ({ text: value, type: "text" as const })

describe("digestOf — file-backed results", () => {
  test("derives path, kind, mtime, and full flag from read meta", () => {
    const part = result({
      content: "     1\talpha\n     2\tbeta",
      meta: { full: true, kind: "read", limit: 2, mtime: 1000, offset: 1, path: "/a.txt" },
      name: "read",
    })
    const digest = digestOf(part)

    expect(digest.tool).toBe("read")
    expect(digest.path).toBe("/a.txt")
    expect(digest.kind).toBe("read")
    expect(digest.full).toBe(true)
    expect(digest.mtime).toBe(1000)
    expect(digest.range).toEqual({ from: 1, to: 2, total: 2 })
    expect(digest.firstLine).toBe("1\talpha")
    expect(digest.tokens).toBeGreaterThan(0)
  })

  test("partial read ranges use the slice meta's total line count", () => {
    const part = result({
      content: [
        { content: "showing 151-170 of 200", tag: "slice", type: "meta" },
        text("   151\tline one"),
      ],
      meta: { full: false, kind: "read", limit: 20, mtime: 1000, offset: 151, path: "/a.txt" },
      name: "read",
    })
    const digest = digestOf(part)

    expect(digest.full).toBeUndefined()
    expect(digest.range).toEqual({ from: 151, to: 170, total: 200 })
    expect(digest.firstLine).toBe("151\tline one")
  })

  test("overshot read reports the file's line count from the slice meta", () => {
    const part = result({
      content: [
        { content: "offset 999 past end of file (5 lines)", tag: "slice", type: "meta" },
        text(""),
      ],
      meta: { full: false, kind: "read", limit: 0, mtime: 1000, offset: 999, path: "/a.txt" },
      name: "read",
    })
    // limit 0 means the read produced no lines; no range, but the first
    // line falls back to the slice note.
    const digest = digestOf(part)
    expect(digest.range).toBeUndefined()
    expect(digest.firstLine).toBe("offset 999 past end of file (5 lines)")
  })

  test("edit meta yields path, kind, mtime without a range", () => {
    const digest = digestOf(
      result({
        content: '{"bytes":10,"edits":1,"lines":2,"ok":true,"path":"/a.txt"}',
        meta: { content: "beta", kind: "edit", mtime: 2000, original: "alpha", path: "/a.txt" },
        name: "edit",
      })
    )

    expect(digest).toMatchObject({ kind: "edit", mtime: 2000, path: "/a.txt", tool: "edit" })
    expect(digest.range).toBeUndefined()
  })

  test("transcriptLine is carried when provided", () => {
    const digest = digestOf(
      result({ content: "x", meta: { kind: "read", mtime: 1, path: "/a" }, name: "read" }),
      { transcriptLine: 42 }
    )
    expect(digest.transcriptLine).toBe(42)
  })

  test("stat probe reports freshness", () => {
    const part = result({
      content: "x",
      meta: { full: true, kind: "read", limit: 1, mtime: 1000, offset: 1, path: "/a.txt" },
      name: "read",
    })

    expect(digestOf(part, { stat: () => 1000 }).changed).toBe(false)
    expect(digestOf(part, { stat: () => 2000 }).changed).toBe(true)
    expect(digestOf(part, { stat: () => undefined }).missing).toBe(true)
    // No probe → neither flag is asserted.
    expect(digestOf(part).changed).toBeUndefined()
    expect(digestOf(part).missing).toBeUndefined()
  })
})

describe("digestOf — process results", () => {
  test("bash snapshot exposes status, exit code, and truncation facts", () => {
    const digest = digestOf(
      result({
        content: [
          { data: { status: "exited" }, tag: "bash", type: "meta" },
          text("hello world\nsecond line"),
        ] as ToolResultPart["content"],
        name: "bash",
      })
    )

    expect(digest.tool).toBe("bash")
    expect(digest.status).toBe("exited")
    expect(digest.firstLine).toBe("hello world")
    expect(digest.path).toBeUndefined()
  })

  test("kill reason and truncated full-output path survive", () => {
    const digest = digestOf(
      result({
        content: [text("tail")],
        meta: {
          code: -1,
          durationMs: 10,
          killReason: "timeout",
          status: "exited",
          truncated: { fullOutputPath: "/tmp/zaly-bash/x.log", totalLines: 900 },
        },
        name: "bash",
      })
    )

    expect(digest).toMatchObject({
      code: -1,
      fullPath: "/tmp/zaly-bash/x.log",
      killReason: "timeout",
      status: "exited",
      totalLines: 900,
      truncated: true,
    })
  })

  test("gh truncation shape maps bytes/lines onto the digest", () => {
    const digest = digestOf(
      result({
        content: [text("diff body")],
        meta: {
          code: 0,
          durationMs: 10,
          mode: "diff",
          ok: true,
          truncated: { bytes: 100, hint: "narrow the URL", lines: 42 },
          url: "https://github.com/o/r/pull/1",
        },
        name: "gh_fetch",
      })
    )

    expect(digest).toMatchObject({
      code: 0,
      totalLines: 42,
      truncated: true,
      url: "https://github.com/o/r/pull/1",
    })
  })

  test("isError results still digest, using the error message as preview", () => {
    const digest = digestOf(
      result({
        content: [{ code: "NOT_FOUND", message: "no such file", type: "error" }],
        isError: true,
        name: "read",
      })
    )
    expect(digest.firstLine).toBe("no such file")
  })
})

describe("digestOf — attachments and plain parts", () => {
  test("attachment result with no meta mines the payload", () => {
    const attachment: Attachment = {
      mime: "image/png",
      source: { data: "abc", type: "base64" },
      type: "image",
    }
    const digest = digestOf(result({ content: [attachment], name: "read" }))
    expect(digest.mime).toBe("image/png")
    expect(digest.path).toBeUndefined()
  })

  test("attachment with a file source reports the path", () => {
    const attachment: Attachment = {
      mime: "image/png",
      source: { path: "/tmp/shot.png", type: "file" },
      type: "image",
    }
    const digest = digestOf(attachment)
    expect(digest).toMatchObject({ mime: "image/png", path: "/tmp/shot.png", tool: "image" })
  })

  test("plain text and meta parts digest by content", () => {
    expect(digestOf(text("hello\nworld"))).toMatchObject({ firstLine: "hello", tool: "text" })
    expect(digestOf({ content: "line one", tag: "note", type: "meta" })).toMatchObject({
      firstLine: "line one",
    })
    expect(digestOf({ message: "boom", code: "X", type: "error" })).toMatchObject({
      firstLine: "boom",
      tool: "error",
    })
  })

  test("first line skips blanks and truncates long lines", () => {
    const long = "x".repeat(300)
    const digest = digestOf(text(`\n\nshort\n${long}`))
    expect(digest.firstLine).toBe("short")

    const truncated = digestOf(text(long))
    expect(truncated.firstLine).toHaveLength(161)
    expect(truncated.firstLine?.endsWith("…")).toBe(true)
  })

  test("digest is pure — same part, same output", () => {
    const part: Message<"tool">["content"][number] = result({
      content: "stable",
      meta: { kind: "write", mtime: 5, path: "/w" },
      name: "write",
    })
    const a: Digest = digestOf(part)
    const b: Digest = digestOf(part)
    expect(a).toEqual(b)
  })
})

describe("elidedOf", () => {
  test("renders an `<elided>` MetaPart wrapping the digest", () => {
    const part = result({ content: "hello", name: "bash" })
    const stub = elidedOf(part, { transcriptLine: 12 })

    expect(stub).toEqual({
      data: { firstLine: "hello", tokens: 3, tool: "bash", transcriptLine: 12 },
      tag: "elided",
      type: "meta",
    })
  })

  test("isElided recognizes stubs, including stub-only tool results", () => {
    const stub = elidedOf(result({ content: "hello", name: "bash" }))
    expect(isElided(stub)).toBe(true)
    expect(isElided({ text: "regular", type: "text" })).toBe(false)
    expect(isElided(result({ content: [stub], name: "bash" }))).toBe(true)
    expect(isElided(result({ content: [stub, text("leftover")], name: "bash" }))).toBe(false)
  })
})
