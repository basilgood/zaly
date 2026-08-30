import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll } from "vitest"

// Seed a minimal cached catalog so `loadCatalog()` / `getModel()` don't
// hit the network during tests. Pointed at a temp dir via ZALY_MODELS_CACHE.
const dir = mkdtempSync(join(tmpdir(), "zaly-ai-models-"))
const cachePath = join(dir, "models.json")

beforeAll(() => {
  process.env.ZALY_MODELS_CACHE = cachePath
  writeFileSync(
    cachePath,
    JSON.stringify({
      data: {},
      expiresAt: Date.now() + 60_000,
      fetchedAt: Date.now(),
    })
  )
})

afterAll(() => {
  delete process.env.ZALY_MODELS_CACHE
  rmSync(dir, { force: true, recursive: true })
})
