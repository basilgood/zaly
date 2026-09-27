/**
 * Redundancy-based degradation detector — the handoff trigger.
 *
 * As context dilutes, the model writes around facts it can no longer
 * retrieve: prose gets longer, more hedged, more repetitive. Novelty —
 * the fraction of n-grams in the latest assistant turn that already
 * appeared in recent turns — captures that curve directly. When the
 * sliding mean of novelty over the last `window` turns drops below
 * `threshold`, the session is past the onset of the degradation curve
 * and the handoff should fire — before the pressure trigger, at the
 * moment the behavior is actually visible.
 */
export type RedundancyOptions = {
  enabled: boolean
  /** Sliding-mean novelty below this marks the session as degraded. */
  threshold: number
  /** How many recent assistant turns the sliding mean averages over. */
  window: number
  /** n-gram size for overlap detection. */
  n: number
  /** Turns shorter than this (chars of final text) break the streak —
   *  terse replies are naturally repetitive and must not count. */
  minTextLen: number
}

export const defaults: RedundancyOptions = {
  enabled: true,
  minTextLen: 120,
  n: 4,
  threshold: 0.4,
  window: 5,
}

export class Redundancy {
  #opts: RedundancyOptions
  /** All scored turns, capped at 2×window (the overlap pool). */
  #history: string[] = []
  /** Novelty score per turn, capped at `window`. */
  #recent: number[] = []

  constructor(opts: Partial<RedundancyOptions> = {}) {
    this.#opts = { ...defaults, ...opts }
  }

  /** Score one committed assistant text. Call once per committed turn,
   *  with only the final text (reasoning and tool calls excluded). */
  feed(text: string): void {
    const { n, minTextLen } = this.#opts
    this.#history.push(text)
    if (this.#history.length > 2 * this.#opts.window) this.#history.shift()

    if (text.length < minTextLen) {
      // Short turns break the streak — a terse exchange between long
      // rambling turns is not recovery.
      this.#recent.length = 0
      return
    }
    const grams = ngrams(text, n)
    if (grams.length === 0) return
    const seen = new Set(this.#history.slice(0, -1).flatMap((t) => ngrams(t, n)))
    const novel = grams.filter((g) => !seen.has(g)).length / grams.length
    this.#recent.push(novel)
    if (this.#recent.length > this.#opts.window) this.#recent.shift()
  }

  /** True once `window` turns accumulated and the mean novelty has
   *  dropped below the threshold. */
  get degraded(): boolean {
    const { window, threshold } = this.#opts
    if (this.#recent.length < window) return false
    const mean = this.#recent.reduce((a, b) => a + b, 0) / this.#recent.length
    return mean < threshold
  }

  reset(): void {
    this.#history = []
    this.#recent = []
  }
}

function ngrams(text: string, n: number): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length < n) return []
  const out: string[] = []
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "))
  return out
}
