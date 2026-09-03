import type { Message, Tool } from "@zaly/ai"

import { describe, expect, test } from "vitest"
import { estimatePart, formatTokenStats, tokenStats } from "../src/context/tokens.ts"

const text = (value: string) => ({ text: value, type: "text" as const })
const user = (content: Message<"user">["content"]): Message<"user"> => ({ content, role: "user" })
const assistant = (content: Message<"assistant">["content"]): Message<"assistant"> => ({
  content,
  role: "assistant",
})
const tool = (content: Message<"tool">["content"]): Message<"tool"> => ({ content, role: "tool" })

describe("tokenStats", () => {
  test("estimates text, tool calls, tool results, attachments, meta, and errors", () => {
    const stats = tokenStats(
      [
        user([
          text("hello"),
          { mime: "image/png", source: { data: "abc", type: "base64" }, type: "image" },
          { data: { ok: true }, tag: "status", type: "meta" },
        ]),
        assistant([
          { text: "thinking", type: "reasoning" },
          { id: "call-1", name: "read", params: { path: "a.txt" }, type: "tool-call" },
        ]),
        tool([
          {
            content: [text("result"), { code: "BOOM", message: "boom", type: "error" }],
            id: "call-1",
            name: "read",
            type: "tool-result",
          },
        ]),
      ],
      {
        expand: () => true,
        prompt: ["system prompt", { name: "custom", text: "prompt text" }],
        tools: [{ name: "read", params: { type: "object" } } as unknown as Tool],
      }
    )

    expect(stats.count).toBe(4)
    expect(stats.tokens).toBeGreaterThan(1500)
    expect(stats.children?.get("user")?.children?.get("image")?.tokens).toBe(1500)
    expect(
      stats.children?.get("assistant")?.children?.get("tool-call")?.children?.get("read")
    ).toMatchObject({
      count: 1,
      key: "read",
    })
    expect(
      stats.children
        ?.get("tool")
        ?.children?.get("tool-result")
        ?.children?.get("read")
        ?.children?.get("error")
    ).toMatchObject({ count: 1 })
    expect(
      stats.children?.get("system-prompt")?.children?.get("tool-schema")?.children?.get("read")
    ).toMatchObject({ count: 1 })
  })

  test("formatTokenStats sorts top-level children by token count and includes totals", () => {
    const stats = tokenStats([
      user([text("small")]),
      user([{ mime: "application/pdf", source: { data: "x", type: "base64" }, type: "pdf" }]),
    ])
    const formatted = formatTokenStats(stats)

    expect(formatted).toContain("TOTAL")
    expect(formatted).toContain("user")
    expect(formatted).toContain("8_002")
  })

  test("estimatePart throws for unknown part types", () => {
    expect(() => estimatePart({ type: "mystery" } as never)).toThrow("Unknown part type")
  })
})

