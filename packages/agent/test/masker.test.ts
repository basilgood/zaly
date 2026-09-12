import type { Message } from "@zaly/ai"
import type { Agent } from "../src/agent.ts"

import { describe, expect, test, vi } from "vitest"
import { tokenStats } from "../src/context/tokens.ts"
import { Masker } from "../src/masker.ts"

const user = (id: string, content: Message<"user">["content"]): Message<"user"> => ({
  content,
  id,
  role: "user",
})
const assistant = (
  id: string,
  content: Message<"assistant">["content"] = "ok"
): Message<"assistant"> => ({
  content,
  id,
  role: "assistant",
})
const tool = (id: string, content: Message<"tool">["content"]): Message<"tool"> => ({
  content,
  id,
  role: "tool",
})

type FakeAgent = Agent & {
  $ctxOn: ReturnType<typeof vi.fn>
  $on: ReturnType<typeof vi.fn>
  session: {
    maskCheckpoint?: { messageId: string; threshold: number }
    addMaskCheckpoint: ReturnType<typeof vi.fn>
  }
}

function fakeAgent(lineOf?: (id: string) => number | undefined): FakeAgent {
  const session = {
    lineOf,
    maskCheckpoint: undefined as { messageId: string; threshold: number } | undefined,
    addMaskCheckpoint: vi.fn(async (checkpoint: { messageId: string; threshold: number }) => {
      session.maskCheckpoint = checkpoint
    }),
  }
  const on = vi.fn()
  const ctxOn = vi.fn()
  return {
    $ctxOn: ctxOn,
    $on: on,
    ctx: { on: ctxOn },
    on,
    pressure: { limit: 1000, ratio: 1 },
    prompt: [],
    session,
    tools: [],
  } as unknown as FakeAgent
}

const image = (): {
  mime: "image/png"
  source: { data: string; type: "base64" }
  type: "image"
} => ({
  mime: "image/png",
  source: { data: "abc", type: "base64" },
  type: "image",
})

describe("Masker", () => {
  test("registers agent hooks and resets masks on session events", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { keepTurns: 0 })
    expect(agent.$on).toHaveBeenCalledWith("context", expect.any(Function))
    expect(agent.$ctxOn).toHaveBeenCalledWith("session", expect.any(Function))
    expect(masker.enabled).toBe(true)
  })

  test("disabled masker returns an unmodified copy and reports no masks", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { enabled: false })
    const messages = [user("u1", "hello")]

    const projected = await masker.mask(messages, { force: true })
    expect(projected).toEqual(messages)
    expect(projected).not.toBe(messages)
    expect(masker.enabled).toBe(false)
    expect(masker.masked).toBe(0)
    expect(masker.isMasked("u1")).toBe(false)
  })

  test("force masking replaces old attachments with digest stubs and records a checkpoint", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { keepTurns: 0, minTokens: 1, target: 0.1 })
    const messages: Message[] = [user("u1", [image()]), assistant("a1")]

    const projected = await masker.mask(messages, { force: true, limit: 10, ratio: 1 })

    expect(agent.session.addMaskCheckpoint).toHaveBeenCalledWith({
      messageId: "a1",
      threshold: 0.35,
    })
    expect(masker.masked).toBe(1)
    expect(masker.isMasked("u1")).toBe(true)
    expect(masker.isMasked("u1", 0)).toBe(true)
    expect(masker.stats.get("user")).toEqual({ image: 1 })
    expect(projected[0]).not.toBe(messages[0])
    expect(projected[0].content).toEqual([
      {
        data: { mime: "image/png", tokens: 1500, tool: "image" },
        tag: "elided",
        type: "meta",
      },
    ])
    expect(projected[1]).toBe(messages[1])
  })

  test("stubs embed the transcript line number when the session provides lineOf", async () => {
    const agent = fakeAgent((id) => (id === "u1" ? 42 : undefined))
    const masker = new Masker(agent, { keepTurns: 0, minTokens: 1, target: 0.1 })
    const messages: Message[] = [user("u1", [image()]), assistant("a1")]

    const projected = await masker.mask(messages, { force: true, limit: 10, ratio: 1 })

    expect(projected[0].content).toEqual([
      {
        data: { mime: "image/png", tokens: 1500, tool: "image", transcriptLine: 42 },
        tag: "elided",
        type: "meta",
      },
    ])
  })

  test("file tool stubs carry path, range, mtime, and a freshness miss", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { keepTurns: 0, minTokens: 1, target: 0.1 })
    const path = "/zaly-nonexistent/a.txt"
    const messages: Message[] = [
      assistant("a1", [{ id: "call", name: "read", params: { path }, type: "tool-call" }]),
      tool("t1", [
        {
          content: "     1\tcontent",
          id: "call",
          meta: { full: true, kind: "read", limit: 10, mtime: 123, offset: 1, path },
          name: "read",
          type: "tool-result",
        },
      ]),
      assistant("a2"),
    ]

    const projected = await masker.mask(messages, { force: true, limit: 10, ratio: 1 })

    const result = projected[1].content as { content: unknown }[]
    expect(result[0].content).toEqual([
      {
        data: {
          firstLine: "1\tcontent",
          full: true,
          kind: "read",
          missing: true,
          mtime: 123,
          path,
          range: { from: 1, to: 10, total: 10 },
          tokens: 5,
          tool: "read",
        },
        tag: "elided",
        type: "meta",
      },
    ])
    // File tool-call params shrink to the masked fingerprint, keeping the path.
    expect(projected[0].content).toMatchObject([
      { id: "call", name: "read", params: { masked: true, path }, type: "tool-call" },
    ])
    expect(masker.masked).toBe(2)
  })

  test("bash stubs merge embedded meta facts with a first-line preview", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { keepTurns: 0, minTokens: 1, target: 0.1 })
    const messages: Message[] = [
      assistant("a1", [
        { id: "call", name: "bash", params: { command: "echo hi" }, type: "tool-call" },
      ]),
      tool("t1", [
        {
          content: [
            { data: { code: 0, status: "exited" }, tag: "bash", type: "meta" },
            { text: "hi", type: "text" },
          ],
          id: "call",
          name: "bash",
          type: "tool-result",
        },
      ]),
      assistant("a2"),
    ]

    const projected = await masker.mask(messages, { force: true, limit: 10, ratio: 1 })

    const result = projected[1].content as { content: { data?: unknown; tag?: string }[] }[]
    expect(result[0].content[0]).toMatchObject({
      data: { code: 0, firstLine: "hi", status: "exited", tool: "bash" },
      tag: "elided",
      type: "meta",
    })
  })

  test("does not mask recent turns protected by keepTurns", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { keepTurns: 20, minTokens: 1, target: 0.1 })
    const messages: Message[] = [user("u1", [image()]), assistant("a1")]

    const projected = await masker.mask(messages, { force: true, limit: 10, ratio: 1 })

    expect(masker.masked).toBe(0)
    expect(masker.isMasked("u1")).toBe(false)
    expect(projected).toEqual(messages)
  })

  test("skips tiny tool results under minTokens", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { keepTurns: 0, minTokens: 50, target: 0.1 })
    const messages: Message[] = [
      assistant("a1", [
        { id: "call", name: "bash", params: { command: "true" }, type: "tool-call" },
      ]),
      tool("t1", [{ content: "ok", id: "call", name: "bash", type: "tool-result" }]),
      assistant("a2"),
    ]

    await masker.mask(messages, { force: true, limit: 10, ratio: 1 })

    expect(masker.masked).toBe(0)
    expect(masker.stats.size).toBe(0)
  })

  test("restores masking decisions from a previous checkpoint", async () => {
    const agent = fakeAgent()
    agent.session.maskCheckpoint = { messageId: "a1", threshold: 0.4 }
    const masker = new Masker(agent, { keepTurns: 0, minTokens: 1, target: 0.1 })
    const messages: Message[] = [
      user("u1", [image()]),
      assistant("a1"),
      user("u2", [image()]),
      assistant("a2"),
    ]

    const projected = await masker.mask(messages, { limit: 1000, ratio: 0.2 })

    expect(agent.session.addMaskCheckpoint).not.toHaveBeenCalled()
    expect(masker.isMasked("u1", 0)).toBe(true)
    expect(masker.isMasked("u2", 0)).toBe(false)
    expect(projected[0].content).toMatchObject([{ tag: "elided", type: "meta" }])
    expect(projected[2]).toBe(messages[2])
  })

  test("throws when a masking pass has no latest message id", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { keepTurns: 0, minTokens: 1 })
    await expect(
      masker.mask([user("u1", "old"), { content: "latest", role: "assistant" }], { force: true })
    ).rejects.toThrow("Message in masker without ID")
  })

  test("hysteresis: a pass raises the threshold so later requests reuse the projection", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { keepTurns: 0, minTokens: 1, target: 0.1 })
    const messages: Message[] = [user("u1", [image()]), assistant("a1")]

    const first = await masker.mask(messages, { limit: 1000, ratio: 0.4 })
    expect(agent.session.addMaskCheckpoint).toHaveBeenCalledTimes(1)
    expect(masker.masked).toBe(1)
    // Masking actually shrank the projection below the raw history.
    expect(tokenStats(first).tokens).toBeLessThan(tokenStats(messages).tokens)

    // After a pass the threshold is `target + delta` (0.35), not the
    // target (0.1). A request above target but below that floor reuses the
    // cached projection instead of rebuilding.
    const again = await masker.mask(messages, { limit: 1000, ratio: 0.3 })
    expect(agent.session.addMaskCheckpoint).toHaveBeenCalledTimes(1)
    expect(again).toEqual(first)

    // Crossing the threshold triggers a fresh pass.
    await masker.mask(messages, { limit: 1000, ratio: 0.4 })
    expect(agent.session.addMaskCheckpoint).toHaveBeenCalledTimes(2)
  })

  test("a no-op pass raises the threshold to avoid repeated cache-busting rebuilds", async () => {
    const agent = fakeAgent()
    const masker = new Masker(agent, { keepTurns: 0, target: 0.1 })
    // A big plain user text is neither a tool result nor an attachment, so
    // a triggered pass has no candidates and masks nothing.
    const messages: Message[] = [user("u1", "x".repeat(4000)), assistant("a1")]

    await masker.mask(messages, { limit: 1000, ratio: 0.4 })
    expect(agent.session.addMaskCheckpoint).toHaveBeenCalledTimes(1)
    expect(masker.masked).toBe(0)

    // Threshold rose to raw ratio + delta (~1.25), above the same ratio, so
    // the next request skips the no-op rebuild.
    await masker.mask(messages, { limit: 1000, ratio: 0.4 })
    expect(agent.session.addMaskCheckpoint).toHaveBeenCalledTimes(1)
  })
})
