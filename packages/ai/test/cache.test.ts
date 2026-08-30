import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { MODELS_CACHE_TTL_MS, readModelsCache, writeModelsCache } from "../src/models/cache.ts"

let dirs: string[] = []
let envRestore: Record<string, string | undefined> = {}

afterEach(() => {
  for (const [key, value] of Object.entries(envRestore)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  envRestore = {}
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
  dirs = []
})

function cachePath() {
  const dir = mkdtempSync(join(tmpdir(), "zaly-ai-cache-"))
  dirs.push(dir)
  const path = join(dir, "models.json")
  process.env.ZALY_MODELS_CACHE = path
  return path
}

describe("models cache", () => {
  test("write then read round-trips the data", async () => {
    cachePath()
    const data = { openai: { id: "openai", name: "OpenAI" } }
    await writeModelsCache(data)
    await expect(readModelsCache()).resolves.toEqual(data)
  })

  test("expired cache returns undefined", async () => {
    const path = cachePath()
    writeFileSync(
      path,
      JSON.stringify({
        data: { openai: { id: "openai" } },
        expiresAt: Date.now() - 1,
        fetchedAt: Date.now() - MODELS_CACHE_TTL_MS,
      })
    )
    await expect(readModelsCache()).resolves.toBeUndefined()
  })

  test("missing file returns undefined", async () => {
    cachePath()
    await expect(readModelsCache()).resolves.toBeUndefined()
  })

  test("corrupt cache returns undefined", async () => {
    const path = cachePath()
    writeFileSync(path, "not-json{{{")
    await expect(readModelsCache()).resolves.toBeUndefined()
  })
})
