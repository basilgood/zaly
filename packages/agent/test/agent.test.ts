import type { Content, Message } from "@zaly/ai"

import { defineTool, stringifyContent } from "@zaly/ai"
import { Type } from "typebox"
import { describe, expect, test } from "vitest"
import { loadAgent, mockModel, runAgent, throwingModel } from "./helpers.ts"

const Add = defineTool({
  call: ({ a, b }) => a + b,
  name: "add",
  params: Type.Object({ a: Type.Number(), b: Type.Number() }),
})

describe("Agent — no tool calls", () => {
  test("completes in one step when the model stops", async () => {
    const model = mockModel([
      [
        { delta: "Hello!", type: "text-delta" },
        { finishReason: "stop", type: "finish", usage: { input: 10, output: 2 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "hi", role: "user" }],
      model,
    })
    expect(result.steps).toBe(1)
    expect(result.stopReason).toBe("natural")
    expect(result.messages.at(-1)?.role).toBe("assistant")
  })
})

describe("Agent — tool-calls loop", () => {
  test("executes a tool call and continues until natural stop", async () => {
    const model = mockModel([
      [
        { params: { a: 2, b: 3 }, id: "call_1", name: "add", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 10, output: 5 } },
      ],
      [
        { delta: "The answer is 5.", type: "text-delta" },
        { finishReason: "stop", type: "finish", usage: { input: 15, output: 8 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "what is 2+3?", role: "user" }],
      model,
      tools: [Add],
    })
    expect(result.steps).toBe(2)
    expect(result.stopReason).toBe("natural")
    const roles = result.messages.map((m) => m.role)
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"])
    const toolMsg = result.messages[2] as Message<"tool">
    expect(toolMsg.content[0].content).toEqual([{ format: "json", text: "5", type: "text" }])
    expect(toolMsg.content[0].isError).toBe(false)
  })

  test("surfaces an unknown-tool error to the model and keeps going", async () => {
    const model = mockModel([
      [
        { params: {}, id: "c1", name: "mystery", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 5, output: 3 } },
      ],
      [
        { delta: "sorry", type: "text-delta" },
        { finishReason: "stop", type: "finish", usage: { input: 8, output: 1 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model,
      tools: [Add],
    })
    const toolMsg = result.messages[2] as Message<"tool">
    expect(toolMsg.content[0].isError).toBe(true)
    expect(stringifyContent(toolMsg.content[0].content)).toMatch(/UNKNOWN_TOOL|mystery/)
  })

  test("stops after maxSteps even if the model keeps calling tools", async () => {
    const model = mockModel([
      [
        { params: { a: 1, b: 1 }, id: "c1", name: "add", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
      [
        { params: { a: 1, b: 1 }, id: "c2", name: "add", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "loop", role: "user" }],
      model,
      stop: { maxSteps: 2 },
      tools: [Add],
    })
    expect(result.steps).toBe(2)
    expect(result.stopReason).toBe("max-steps")
  })
})

describe("Agent — usage accumulation", () => {
  test("totalUsage sums across all streams; usage is the last step's", async () => {
    const model = mockModel([
      [
        { params: { a: 1, b: 1 }, id: "c1", name: "add", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 10, output: 5 } },
      ],
      [
        { delta: "ok", type: "text-delta" },
        { finishReason: "stop", type: "finish", usage: { input: 20, output: 3 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model,
      tools: [Add],
    })
    expect(result.totalUsage).toEqual({ input: 30, output: 8 })
    expect(result.usage.input).toEqual(20)
    expect(result.usage.output).toEqual(3)
  })
})

describe("Agent — token budget", () => {
  test("stops with token-budget when summed usage exceeds the cap", async () => {
    const model = mockModel([
      [
        { params: { a: 1, b: 1 }, id: "c1", name: "add", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 60, output: 30 } },
      ],
      [
        { params: { a: 1, b: 1 }, id: "c2", name: "add", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 80, output: 40 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model,
      stop: { tokenBudget: 80 },
      tools: [Add],
    })
    expect(result.stopReason).toBe("token-budget")
    expect(result.steps).toBe(1)
  })
})

describe("Agent — max tool errors", () => {
  test("stops after N consecutive failing tool calls", async () => {
    const model = mockModel([
      [
        { params: {}, id: "c1", name: "missing", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
      [
        { params: {}, id: "c2", name: "missing", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
      [
        { params: {}, id: "c3", name: "missing", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model,
      stop: {
        // Disable loop detection so repeated identical failing calls
        // don't trip "loop-detected" before the error cap fires.
        loopConsecutive: Infinity,
        loopWindowRepeats: Infinity,
        maxToolErrors: 3,
      },
      tools: [Add],
    })
    expect(result.stopReason).toBe("max-tool-errors")
    expect(result.steps).toBe(3)
  })

  test("a successful tool call resets the consecutive counter", async () => {
    const model = mockModel([
      [
        { params: {}, id: "c1", name: "missing", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
      [
        { params: { a: 1, b: 2 }, id: "c2", name: "add", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
      [
        { params: {}, id: "c3", name: "missing", type: "tool-call" },
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
      [
        { delta: "ok", type: "text-delta" },
        { finishReason: "stop", type: "finish", usage: { input: 1, output: 1 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model,
      stop: { maxToolErrors: 2 },
      tools: [Add],
    })
    expect(result.stopReason).toBe("natural")
  })
})

describe("Agent — context overflow", () => {
  test("detects overflow from a thrown stream error", async () => {
    // `compaction.auto: false` opts out of the auto-recovery path so the
    // test focuses on detection — that the overflow pattern is matched
    // and surfaces as `context-overflow` rather than `error`.
    const result = await runAgent({
      compaction: { enabled: false },
      messages: [{ content: "go", role: "user" }],
      model: throwingModel("This model's maximum context length is 8192 tokens."),
    })
    expect(result.stopReason).toBe("context-overflow")
  })

  test("detects silent overflow against contextLimit", async () => {
    const model = mockModel([
      [{ finishReason: "stop", type: "finish", usage: { input: 9000, output: 5 } }],
    ])
    const result = await runAgent({
      compaction: { enabled: false },
      contextLimit: 8000,
      messages: [{ content: "go", role: "user" }],
      model,
    })
    expect(result.stopReason).toBe("context-overflow")
  })

  test("genuine errors surface as stopReason: error", async () => {
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model: throwingModel("network down"),
    })
    expect(result.stopReason).toBe("error")
  })
})

describe("Agent — compaction summarizer model", () => {
  test("uses the configured compaction.model instead of the session model", async () => {
    // Session model errors if used for the summary; the configured
    // summarizer succeeds. If compaction picked the wrong model, the
    // run surfaces the throw instead of a completed summary.
    const sessionModel = throwingModel("session model must not summarize")
    const summaryModel = mockModel([
      [
        { delta: "## 1. Goal\ntest goal", type: "text-delta" },
        { finishReason: "stop", type: "finish", usage: { input: 10, output: 5 } },
      ],
    ])
    const agent = await loadAgent({
      compaction: { model: "mock/summary" },
      loadModel: async (id) => {
        if (id === "mock/summary") return summaryModel
        throw new Error(`unexpected model load: ${id}`)
      },
      messages: [{ content: "hi", role: "user" }],
      model: sessionModel,
    })
    // Assert before compact: no `compact` node exists yet.
    await agent.compact()
    // session.messages flattens the compact node into a system summary
    // message; check it landed (proves #summarize ran on the summaryModel
    // — the session model throws if called).
    const kinds = agent.session.messages.map((m) => m.role)
    expect(kinds[0]).toBe("system")
  })
})

function sameAddCall(id: string): {
  id: string
  name: "add"
  params: { a: number; b: number }
  type: "tool-call"
} {
  return { id, name: "add", params: { a: 1, b: 1 }, type: "tool-call" }
}

describe("Agent — loop detection", () => {
  test("stops with loop-detected after N identical consecutive calls", async () => {
    // Three iterations, each calling add(1,1) — trips loopConsecutive=3.
    const sameCall = sameAddCall
    const model = mockModel([
      [
        sameCall("c1"),
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
      [
        sameCall("c2"),
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
      [
        sameCall("c3"),
        { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model,
      stop: { loopConsecutive: 3, loopNudges: 0 },
      tools: [Add],
    })
    expect(result.stopReason).toBe("loop-detected")
  })

  test("identical calls with changing results are not a loop", async () => {
    // A poll-like tool whose output changes each call (e.g. task_poll
    // watching a task progress) — same call, different result → progress,
    // not a loop. The loop detector must not flag it.
    let n = 0
    const Poll = defineTool({
      call: () => `progress ${++n}`,
      name: "poll",
      params: Type.Object({}),
    })
    const sameCall = (id: string) => ({ id, name: "poll" as const, params: {}, type: "tool-call" as const })
    const model = mockModel([
      [sameCall("c1"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
      [sameCall("c2"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
      [sameCall("c3"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
      [
        { delta: "done", type: "text-delta" },
        { finishReason: "stop", type: "finish", usage: { input: 1, output: 1 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model,
      stop: { loopConsecutive: 3 },
      tools: [Poll],
    })
    expect(result.stopReason).toBe("natural")
  })

  test("injects a corrective nudge and lets the model break the loop", async () => {
    // Three identical add(1,1) calls trip loopConsecutive=3 → the agent
    // injects a loop-nudge system message and continues; the model then
    // answers naturally instead of halting.
    const model = mockModel([
      [sameAddCall("c1"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
      [sameAddCall("c2"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
      [sameAddCall("c3"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
      [
        { delta: "2", type: "text-delta" },
        { finishReason: "stop", type: "finish", usage: { input: 1, output: 1 } },
      ],
    ])
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model,
      stop: { loopConsecutive: 3 },
      tools: [Add],
    })
    expect(result.stopReason).toBe("natural")
    const nudges = result.messages.filter((m) => m.role === "system" && m.meta?.kind === "loop-nudge")
    expect(nudges).toHaveLength(1)
    expect(stringifyContent(nudges[0].content as Content)).toMatch(/loop nudge 1/)
    expect(stringifyContent(nudges[0].content as Content)).toMatch(/add/)
  })

  test("halts with loop-detected once the nudge budget is exhausted", async () => {
    // loopNudges: 1 → one corrective nudge, then a repeat still trips
    // detection and the run halts.
    const model = mockModel([
      [sameAddCall("c1"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
      [sameAddCall("c2"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
      [sameAddCall("c3"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
      [sameAddCall("c4"), { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } }],
    ])
    const result = await runAgent({
      messages: [{ content: "go", role: "user" }],
      model,
      stop: { loopConsecutive: 3, loopNudges: 1 },
      tools: [Add],
    })
    expect(result.stopReason).toBe("loop-detected")
    const nudges = result.messages.filter((m) => m.role === "system" && m.meta?.kind === "loop-nudge")
    expect(nudges).toHaveLength(1)
  })
})
