import { describe, expect, test } from "vitest"
import { Redundancy } from "../src/compaction/redundancy.ts"

/** Build a turn long enough to score and sharing `overlap` of its words
 *  with the text passed before it. */
function turn(overlap: string, novel: string): string {
  return `${overlap} ${novel}`.repeat(20)
}

describe("Redundancy", () => {
  test("stays clean while turns keep introducing new text", () => {
    const r = new Redundancy({ threshold: 0.4, window: 3 })
    for (let i = 0; i < 5; i++) r.feed(turn(`shared words here ${i}`, `novel ${i} content`))
    expect(r.degraded).toBe(false)
  })

  test("degrades once the same text repeats past the threshold", () => {
    const r = new Redundancy({ threshold: 0.4, window: 3 })
    for (let i = 0; i < 5; i++) r.feed(turn("", "identical repeated prose"))
    expect(r.degraded).toBe(true)
  })

  test("does not degrade when disabled", () => {
    const r = new Redundancy({ enabled: false, threshold: 0.4, window: 3 })
    for (let i = 0; i < 5; i++) r.feed(turn("", "identical repeated prose"))
    expect(r.degraded).toBe(false)
  })

  test("short turns break the streak", () => {
    const r = new Redundancy({ threshold: 0.9, window: 2 })
    for (let i = 0; i < 3; i++) r.feed(turn("", "identical repeated prose"))
    expect(r.degraded).toBe(true)
    r.feed("ok")
    expect(r.degraded).toBe(false)
  })

  test("reset clears the pool", () => {
    const r = new Redundancy({ threshold: 0.4, window: 3 })
    for (let i = 0; i < 5; i++) r.feed(turn("", "identical repeated prose"))
    r.reset()
    expect(r.degraded).toBe(false)
  })
})
