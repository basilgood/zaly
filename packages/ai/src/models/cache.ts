import type { JsonObject } from "@zaly/shared/json"
import type { Catalog } from "./catalog.ts"

import { zalyPaths } from "@zaly/shared/paths"
import { safeReadJson, safeWriteJson } from "@zaly/shared/json"

/** How long a cached models.dev catalog is considered fresh. */
export const MODELS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

type CachedModels = JsonObject & {
  data: JsonObject
  fetchedAt: number
  expiresAt: number
}

/** Path to the cached models.dev catalog. Overridable via `ZALY_MODELS_CACHE`
 *  so tests can keep the real cache untouched. */
export function modelsCachePath(): string {
  return process.env.ZALY_MODELS_CACHE ?? zalyPaths.modelsCache
}

/** Read the cached catalog. Returns `undefined` when the file is missing,
 *  expired, or unparseable — any of which triggers a fresh fetch.
 *
 *  The return type is the honest contract, not a guarantee: the file is
 *  untrusted disk data. `Catalog` describes the shape a *valid* payload
 *  has; validation of individual providers happens downstream in
 *  `ModelCatalog.#load`. The cast is load-bearing precisely because the
 *  JSON could be anything — that's what the cache layer is for. */
export async function readModelsCache(): Promise<Catalog | undefined> {
  const cached = await readCachedModels()
  if (!cached || Date.now() > cached.expiresAt) return
  return cached.data as unknown as Catalog
}

/** Read the cached catalog even when expired, so a failed fetch can fall
 *  back to stale data. Returns `undefined` only when the file is missing
 *  or unparseable. */
export async function readStaleModelsCache(): Promise<Catalog | undefined> {
  const cached = await readCachedModels()
  return (cached?.data ?? undefined) as Catalog | undefined
}

async function readCachedModels(): Promise<CachedModels | undefined> {
  return await safeReadJson<CachedModels>(modelsCachePath())
}

/** Write the catalog to the cache with a fresh expiry. Non-fatal: a failed
 *  write shouldn't break model loading. */
export async function writeModelsCache(data: JsonObject): Promise<void> {
  const cached: CachedModels = {
    data,
    expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
    fetchedAt: Date.now(),
  }
  await safeWriteJson(modelsCachePath(), cached)
}
