import type { CatalogModel } from "../src/models/catalog.ts"

import { formatSize } from "@zaly/shared"
import { gzipSync } from "node:zlib"
import { downloadCatalog } from "../src/models/catalog.ts"

/**
 * Fetch the models.dev catalog, cache it locally, and print stats.
 *
 * Run:  bun packages/ai/scripts/fetch-models.ts
 */
const t0 = performance.now()
const catalog = await downloadCatalog()
const ms = Math.round(performance.now() - t0)
console.log(`✓ fetched + cached in ${ms}ms\n`)

// ── stats ────────────────────────────────────────────────────────────────

const providers = Object.values(catalog.$).filter((p) => !!p)
const allModels: (CatalogModel & { providerId: string })[] = []
for (const p of providers) {
  for (const m of Object.values(p.models)) allModels.push(Object.assign(m, { providerId: p.id }))
}

const cleaned = JSON.stringify(catalog.$)
const gzipped = gzipSync(Buffer.from(cleaned)).length

console.log("── size ─────────────────────────────────────────────────────")
console.log(`  cleaned JSON: ${formatSize(cleaned.length)}`)
console.log(`  gzipped:      ${formatSize(gzipped)}`)
console.log(`  providers:    ${providers.length}`)
console.log(`  models:       ${allModels.length}`)

console.log()
console.log("── adapter families (by npm) ────────────────────────────────")
const byNpm = new Map<string, number>()
for (const p of providers) byNpm.set(p.npm, (byNpm.get(p.npm) ?? 0) + 1)
for (const [npm, count] of [...byNpm.entries()].toSorted((a, b) => b[1] - a[1])) {
  console.log(`  ${count.toString().padStart(3)}  ${npm}`)
}

console.log()
console.log("── providers per adapter we support (openai family) ─────────")
const supported = providers.filter((p) => catalog.provider(p.id))
const skipped = providers.filter((p) => !catalog.provider(p.id))
const supportedModels = supported.reduce((n, p) => n + Object.keys(p.models).length, 0)
console.log(`  supported:   ${supported.length} providers · ${supportedModels} models`)
console.log(`  skipped:     ${skipped.length} providers · ${skipped.map((p) => p.id).join(", ")}`)

console.log()
console.log("── model capabilities ───────────────────────────────────────")
const reasoning = allModels.filter((m) => m.reasoning).length
const toolCall = allModels.filter((m) => m.tool_call).length
const multimodal = allModels.filter((m) => m.modalities.input.some((x) => x !== "text")).length
const responsesShape = allModels.filter((m) => m.provider?.shape === "responses").length
console.log(`  reasoning:        ${reasoning} / ${allModels.length}`)
console.log(`  tool_call:        ${toolCall} / ${allModels.length}`)
console.log(`  multimodal input: ${multimodal} / ${allModels.length}`)
console.log(`  "responses" API:  ${responsesShape} / ${allModels.length}`)
