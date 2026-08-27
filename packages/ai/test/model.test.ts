import type { Message } from "../src/types.ts"
import type { Provider, StreamEvent } from "../src/provider.ts"

import { describe, expect, test } from "vitest"
import { modelCollection } from "../src/model.ts"
import { providerRegistry } from "../src/providers/index.ts"

// ── Local mock provider (registered once for the whole file) ───────────

let scriptedEvents: StreamEvent[] = []

providerRegistry.register(
  "mock-cost-test",
  (): Promise<Provider<"mock-cost-test">> =>
    Promise.resolve({
      id: "mock-cost-test",
      async *stream() {
        for (const ev of scriptedEvents) yield ev
      },
    })
)

const models = modelCollection()

models.register({
  name: "Mock Cost Test",
  api: "mock-api",
  id: "mock-cost-test",
  models: [
    {
      id: "cheap",
      cost: { cache_read: 0.5, cache_write: 5, input: 1, output: 4, reasoning: 8 },
      contextSize: 100_000,
      maxTokens: 4096,
      input: ["text"],
      name: "Cheap",
      api: "mock-cost-test" as never,
      reasoning: false,
    },
    {
      id: "freebie",
      // No cost field — augmentation should be a no-op.
      contextSize: 100_000,
      maxTokens: 4096,
      input: ["text"],
      name: "Freebie",
      api: "mock-cost-test" as never,
      reasoning: false,
    },
  ],
})

describe("loadModel — error paths", () => {
  test("throws a helpful error for unknown ids", async () => {
    await expect(models.load("not-a-real-provider/not-a-real-model")).rejects.toThrow(
      /Model.*not found/s
    )
  })
})

describe("Model.stream — attachment demotion", () => {
  let captured: Message[] = []

  providerRegistry.register(
    "mock-demote",
    (): Promise<Provider<"mock-demote">> =>
      Promise.resolve({
        id: "mock-demote",
        async *stream(req) {
          captured = req.ctx.messages
          yield { finishReason: "stop", type: "finish", usage: { input: 1, output: 1 } }
        },
      })
  )

  const demoteModels = modelCollection()
  demoteModels.register({
    name: "Demote",
    api: "mock-api",
    id: "mock-demote",
    models: [
      {
        id: "text-only",
        contextSize: 100_000,
        maxTokens: 4096,
        input: ["text"],
        name: "Text Only",
        api: "mock-demote" as never,
        reasoning: false,
      },
    ],
  })

  test("demotes a nested tool-result image for a text-only model", async () => {
    const model = await demoteModels.load("mock-demote/text-only")
    await model.stream({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", id: "call_1", name: "read", params: { path: "x.png" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call_1",
              name: "read",
              content: [
                { type: "image", mime: "image/png", source: { type: "base64", data: "AAAA" } },
              ],
            },
          ],
        },
      ],
    })
    const toolMsg = captured.find((m) => m.role === "tool")
    const result = toolMsg!.content[0] as { content: unknown }
    // The nested image must be demoted to a `<image>` MetaPart, not left
    // as an ImagePart that the provider would inline to base64.
    expect(result.content).toEqual([
      { data: { mime: "image/png" }, tag: "image", type: "meta" },
    ])
  })
})

describe("Model.stream — cost augmentation", () => {
  test("populates usage.cost from the catalog price table", async () => {
    scriptedEvents = [
      {
        finishReason: "stop",
        type: "finish",
        usage: { cacheRead: 200, cacheWrite: 100, input: 1000, output: 50, reasoning: 20 },
      },
    ]
    const model = await models.load("mock-cost-test/cheap")
    const message = await model.stream({ messages: [{ content: "hi", role: "user" }] })
    const cost = message.meta.usage.cost!
    // Uncached input = 1000 - 200 - 100 = 700
    // Prices per million: input=1, output=4, cache_read=0.5, cache_write=5, reasoning=8
    expect(cost.input).toBeCloseTo((700 * 1) / 1_000_000)
    expect(cost.output).toBeCloseTo((50 * 4) / 1_000_000)
    expect(cost.cacheRead).toBeCloseTo((200 * 0.5) / 1_000_000)
    expect(cost.cacheWrite).toBeCloseTo((100 * 5) / 1_000_000)
    expect(cost.reasoning).toBeCloseTo((20 * 8) / 1_000_000)
  })

  test("models without a price table get usage but no cost", async () => {
    scriptedEvents = [{ finishReason: "stop", type: "finish", usage: { input: 100, output: 10 } }]
    const model = await models.load("mock-cost-test/freebie")
    const message = await model.stream({ messages: [{ content: "hi", role: "user" }] })
    expect(message.meta.usage.input).toBe(100)
    expect(message.meta.usage.output).toBe(10)
    expect(message.meta.usage.cost).toBeUndefined()
  })
})
