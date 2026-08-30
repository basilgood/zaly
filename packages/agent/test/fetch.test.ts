import type { MetaPart, TextPart, ToolContext } from "@zaly/ai"

import { createServer } from "node:http"
import type { Server } from "node:http"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { fetchTool } from "../src/tools/fetch.ts"

const HTML = `<!DOCTYPE html>
<html><head><title>Pricing</title><style>.x{color:red}</style></head>
<body>
  <h1>Brave Search API</h1>
  <p>Search plan: $5 per 1,000 requests</p>
  <p>Answers plan: $4 per 1,000 requests</p>
  <p>Free credits every month</p>
  <script>var secret = "should be stripped";</script>
</body></html>`

let server: Server
let base = ""

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html")
    res.end(HTML)
  })
  await new Promise<void>((r) => server.listen(0, r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`
})

afterAll(() => server.close())

const ctx = {} as ToolContext

function parts(result: unknown) {
  return ((result ?? []) as Array<{ type: string; text?: string }>).filter(
    (p) => p.type === "text"
  ) as TextPart[]
}

describe("fetch tool filtering", () => {
  test("raw mode returns full HTML body", async () => {
    const result = await fetchTool.call({ url: base, mode: "raw" }, ctx)
    const text = parts(result)[0]?.text ?? ""
    expect(text).toContain("<h1>Brave Search API</h1>")
    expect(text).toContain("<script>")
  })

  test("default mode extracts article via Defuddle", async () => {
    const result = await fetchTool.call({ url: base }, ctx)
    const text = parts(result)[0]?.text ?? ""
    expect(text).toContain("Brave Search API")
    expect(text).toContain("$5 per 1,000 requests")
    expect(text).not.toContain("<h1>")
    expect(text).not.toContain("<script>")
    expect(text).not.toContain("should be stripped")
  })

  test("mode text extracts article via Defuddle", async () => {
    const result = await fetchTool.call({ url: base, mode: "text" }, ctx)
    const text = parts(result)[0]?.text ?? ""
    expect(text).toContain("Brave Search API")
    expect(text).toContain("$5 per 1,000 requests")
    expect(text).not.toContain("<h1>")
    expect(text).not.toContain("<script>")
    expect(text).not.toContain("should be stripped")
  })

  test("match filters to matching lines", async () => {
    const result = await fetchTool.call({ url: base, match: "per 1,000" }, ctx)
    const text = parts(result)[0]?.text ?? ""
    expect(text).toContain("$5 per 1,000 requests")
    expect(text).toContain("$4 per 1,000 requests")
    expect(text).not.toContain("Free credits")
  })

  test("match + head caps matching lines", async () => {
    const result = await fetchTool.call({ url: base, match: "plan", head: 1 }, ctx)
    const text = parts(result)[0]?.text ?? ""
    expect(text).toContain("matching line(s), showing first 1")
    expect(text).toContain("Search plan")
    expect(text).not.toContain("Answers plan")
  })

  test("invalid match returns error text", async () => {
    const result = await fetchTool.call({ url: base, match: "(" }, ctx)
    const text = parts(result)[0]?.text ?? ""
    expect(text).toContain("Invalid match regex")
  })

  test("meta still present", async () => {
    const result = await fetchTool.call({ url: base, match: "plan" }, ctx)
    const meta = ((result ?? []) as Array<{ type: string; data: unknown }>).find(
      (p) => p.type === "meta"
    ) as MetaPart
    expect(meta).toBeDefined()
    expect((meta.data as { status: number }).status).toBe(200)
  })
})
