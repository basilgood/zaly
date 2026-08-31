import type { AiError, Message, ToolContext, ToolResultPart } from "@zaly/ai"
import type { EditToolMeta } from "../src/tools/edit.ts"

import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "pathe"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { editTool } from "../src/tools/edit.ts"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zaly-edit-test-"))
})
afterAll(() => {
  rmSync(dir, { force: true, recursive: true })
})

function makeFile(body: string): string {
  const path = join(dir, `f-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(path, body)
  return path
}

function withReadOf(path: string, mtime: number): Message<"tool"> {
  const part: ToolResultPart = {
    content: "",
    id: "1",
    meta: { kind: "read", mtime, path },
    name: "read",
    type: "tool-result",
  }
  return { content: [part], id: "m1", role: "tool" }
}

function ctxFor(path: string): ToolContext<EditToolMeta> {
  return { cwd: dir, messages: [withReadOf(path, statSync(path).mtimeMs)] }
}

/** Mirror the runtime path: coerce + validate before invoking `call`. */
async function callEdit(args: Record<string, unknown>, ctx: ToolContext<EditToolMeta>) {
  const validated = await editTool.validator.validateParams(args)
  return editTool.call(validated, ctx)
}

/** Run an edit against a fresh file and return the resulting bytes. */
async function editBody(args: Record<string, unknown>, body: string): Promise<string> {
  const path = makeFile(body)
  await callEdit({ ...args, path }, ctxFor(path))
  return readFileSync(path, "utf8")
}

describe("editTool", () => {
  test("single top-level oldText/newText still works", async () => {
    const out = await editBody({ newText: "world", oldText: "hello" }, "hello\n")
    expect(out).toBe("world\n")
  })

  test("batch via edits only — no top-level oldText/newText", async () => {
    const out = await editBody(
      {
        edits: [
          { newText: "two", oldText: "one" },
          { newText: "three", oldText: "2" },
        ],
      },
      "one 2 four\n"
    )
    expect(out).toBe("two three four\n")
  })

  test("top-level pair combined with edits — pair runs first", async () => {
    const out = await editBody(
      {
        edits: [{ newText: "3", oldText: "2" }],
        newText: "1",
        oldText: "0",
      },
      "0 2\n"
    )
    expect(out).toBe("1 3\n")
  })

  test("rejected when neither the top-level pair nor edits carry content", async () => {
    const path = makeFile("hello\n")
    await expect(callEdit({ path }, ctxFor(path))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    })
  })

  test("half of the top-level pair (only newText or only oldText) is rejected", async () => {
    const path = makeFile("hello\n")
    await expect(callEdit({ newText: "x", path }, ctxFor(path))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    })
    await expect(callEdit({ oldText: "hello", path }, ctxFor(path))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    })
  })

  test("empty oldText is rejected", async () => {
    const path = makeFile("hello\n")
    await expect(callEdit({ newText: "x", oldText: "", path }, ctxFor(path))).rejects.toMatchObject(
      { code: "EMPTY_OLD_TEXT" }
    )
  })

  test("oldText must be unique", async () => {
    const path = makeFile("dup dup\n")
    let err: unknown
    try {
      await callEdit({ newText: "x", oldText: "dup", path }, ctxFor(path))
    } catch (error) {
      err = error
    }
    expect((err as AiError).code).toBe("NOT_UNIQUE")
  })

  test("result reports edit count", async () => {
    const path = makeFile("a b c\n")
    const res = (await callEdit(
      {
        edits: [{ newText: "B", oldText: "b" }],
        newText: "A",
        oldText: "a",
        path,
      },
      ctxFor(path)
    )) as { edits: number }
    expect(res.edits).toBe(2)
  })
})

describe("EditTool.call — duplicate top-level pair", () => {
  test("pair identical to an edits entry doesn't double-apply", async () => {
    const out = await editBody(
      {
        edits: [{ newText: "B", oldText: "A" }],
        newText: "B",
        oldText: "A",
      },
      "A\n"
    )
    expect(out).toBe("B\n")
  })
})
