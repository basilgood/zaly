import type { TokenCount, ToolCallPart } from "@zaly/ai"
import type { Emitter, Envelope } from "@zaly/shared"
import type { AgentEvents, AgentStopKind } from "./events.ts"

import { safeStringify } from "@zaly/shared"
import { addUsage } from "./utils/usage.ts"

/** Caps + heuristics that can end a run early. Wired into the
 *  `AgentSession` loop via a single `detect()` call after each step. */
export interface StopOptions {
  /** Hard ceiling on provider round-trips per `run()`. Default: 50. */
  maxSteps?: number
  /** Cumulative token cap across the whole `run()`
   *  (`totalUsage.input + totalUsage.output`). */
  tokenBudget?: number
  /** Bail after this many consecutive failing tool calls. A successful
   *  tool result resets the streak. */
  maxToolErrors?: number

  // ── Loop detection ──────────────────────────────────────────────────
  // Two cheap heuristics over the running tool-call history. A call is
  // hashed as `name + JSON.stringify(params)` plus the hash of its
  // result — so a "loop" is the same call *and* the same output repeated.
  // A call whose result is changing (e.g. `task_poll` watching a task
  // progress) is progress, not a loop. Property order matters (rare false
  // negative if the model alternates key order on the same logical call,
  // accepted in exchange for a much cheaper hash). Set either limit to
  // `Infinity` to disable that arm.

  /** Same `(name, params, result)` appearing N times in a row → loop.
   *  Catches the most common failure mode: re-calling `read_file` with
   *  the same path expecting different output, and getting the same.
   *  Default 3. */
  loopConsecutive?: number
  /** Bounded window for duplicate detection. Default 10. */
  loopWindow?: number
  /** Within the window, this many duplicates of one call → loop.
   *  Catches alternation patterns (`A B A B …`) the consecutive arm
   *  alone won't see. Default 4. */
  loopWindowRepeats?: number
  /** How many corrective nudges to inject before halting on a detected
   *  loop. Default 2. Set to 0 to halt immediately (current behavior). */
  loopNudges?: number
}

/**
 * Subscribes to an `AgentEvent` stream, accumulates the bookkeeping
 * the loop needs to make stop-or-continue decisions, and exposes a
 * single `detect()` to consult after each step.
 *
 * Lives outside `AgentSession` so concerns separate cleanly:
 *   - the session owns conversation, queues, status, and loop control;
 *   - the policy owns counters and the rules that act on them.
 *
 * Wire it up via `attach(session)` (returns an unsubscribe), or feed
 * events manually with `handle(event)` for custom drivers.
 */
export class StopPolicy {
  readonly #opts: StopOptions

  #steps = 0
  #consecutiveErrors = 0
  #calls: ToolCallPart[] = []
  /** The call that tripped loop detection, if any — the repeated one,
   *  not necessarily the most recent. Set by `#detectLoop()`. */
  #lastLoopCall?: ToolCallPart
  /** Result hash per call id — lets the loop detector tell "same call,
   *  same output" (a loop) from "same call, changing output" (progress). */
  #resultHashes = new Map<string, string>()
  #usage: TokenCount = { input: 0, output: 0 }
  #totalUsage: TokenCount = { input: 0, output: 0 }

  constructor(opts: StopOptions = {}) {
    this.#opts = opts
  }

  // ── Read ──────────────────────────────────────────────────────────────

  /** Token usage from the most recent step's response. */
  get usage(): TokenCount {
    return this.#usage
  }
  /** Cumulative token usage across every step in the current run. */
  get totalUsage(): TokenCount {
    return this.#totalUsage
  }
  get steps(): number {
    return this.#steps
  }
  get consecutiveErrors(): number {
    return this.#consecutiveErrors
  }
  /** Tool-call history fed to the loop detector. Read-only. */
  get calls(): readonly ToolCallPart[] {
    return this.#calls
  }
  /** The tool call that tripped loop detection — used to build a
   *  corrective nudge. For the consecutive arm this is the repeated
   *  call; for the window arm, the call that hit `loopWindowRepeats`
   *  (which may not be the most recent call). */
  get lastLoopCall(): ToolCallPart | undefined {
    return this.#lastLoopCall
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  /** Subscribe to an emitter. To detach later, register the listener
   *  yourself and pass the same fn to `emitter.off(fn)`:
   *
   *    const handler = (e) => policy.handle(e)
   *    emitter.all(handler)
   *    // later:
   *    emitter.off(handler) */
  attach(emitter: Emitter<AgentEvents>): void {
    emitter.onAny((event) => this.handle(event))
  }

  /** Feed a single event into the policy. Public so custom drivers
   *  can drive it without going through `attach`. */
  handle(event: Envelope<AgentEvents>): void {
    switch (event.type) {
      case "step-end": {
        this.#steps++
        break
      }
      case "tool-call": {
        this.#calls.push(event.call)
        break
      }
      case "tool-result": {
        this.#consecutiveErrors = event.result.isError ? this.#consecutiveErrors + 1 : 0
        this.#resultHashes.set(event.call.id, safeStringify(event.result.content))
        break
      }
      case "stream-event": {
        if (event.event.type === "finish") {
          this.#usage = event.event.usage
          this.#totalUsage = addUsage(this.#totalUsage, event.event.usage)
        }
        break
      }
      // status / stop — no policy state to update.
    }
  }

  /** Reset per-run counters. Token totals (`usage` / `totalUsage`)
   *  persist unless `keepUsage: false` is passed — billing-style
   *  displays usually want them sticky across resets. */
  reset(opts: { keepUsage?: boolean } = {}): void {
    this.#steps = 0
    this.#consecutiveErrors = 0
    this.#calls = []
    this.#lastLoopCall = undefined
    this.#resultHashes.clear()
    if (opts.keepUsage === false) {
      this.#usage = { input: 0, output: 0 }
      this.#totalUsage = { input: 0, output: 0 }
    }
  }

  /** Decide whether the loop should stop. Returns the stop reason or
   *  `undefined` to continue. Order matters — `loop-detected` wins
   *  over `max-tool-errors` if both fire, since a model in a tight
   *  loop is the more pressing thing to surface. */
  detect(): AgentStopKind | undefined {
    if (this.#opts.maxSteps !== undefined && this.#steps >= this.#opts.maxSteps) {
      return "max-steps"
    }
    if (this.#detectLoop()) {
      return "loop-detected"
    }
    if (
      this.#opts.maxToolErrors !== undefined &&
      this.#consecutiveErrors >= this.#opts.maxToolErrors
    ) {
      return "max-tool-errors"
    }
    if (
      this.#opts.tokenBudget !== undefined &&
      this.#totalUsage.input + this.#totalUsage.output > this.#opts.tokenBudget
    ) {
      return "token-budget"
    }
    return undefined
  }

  // ── Loop detection internals ─────────────────────────────────────────

  #detectLoop(): boolean {
    const calls = this.#calls
    if (calls.length === 0) return false

    const consecutive = this.#opts.loopConsecutive ?? 3
    if (Number.isFinite(consecutive) && calls.length >= consecutive) {
      const last = this.#hash(calls[calls.length - 1])
      let run = 1
      for (let i = calls.length - 2; i >= 0 && run < consecutive; i--) {
        if (this.#hash(calls[i]) === last) run++
        else break
      }
      if (run >= consecutive) {
        this.#lastLoopCall = calls[calls.length - 1]
        return true
      }
    }

    const window = this.#opts.loopWindow ?? 10
    const windowRepeats = this.#opts.loopWindowRepeats ?? 4
    if (Number.isFinite(windowRepeats) && calls.length >= windowRepeats) {
      const slice = calls.slice(Math.max(0, calls.length - window))
      const counts = new Map<string, number>()
      for (const call of slice) {
        const h = this.#hash(call)
        const next = (counts.get(h) ?? 0) + 1
        if (next >= windowRepeats) {
          this.#lastLoopCall = call
          return true
        }
        counts.set(h, next)
      }
    }

    return false
  }

  /** Combined identity of a call: its `(name, params)` plus the hash of
   *  the result it produced. Two calls only count as a repeat if both the
   *  call and its output match — a poller whose result is changing is
   *  making progress, not looping. Falls back to the call alone when no
   *  result has been recorded yet. */
  #hash(call: ToolCallPart): string {
    const result = this.#resultHashes.get(call.id)
    return result === undefined ? hashCall(call) : `${hashCall(call)}\0${result}`
  }
}

function hashCall(call: ToolCallPart): string {
  return `${call.name}\0${safeStringify(call.params)}`
}

/** Cap on how much of a call's params the nudge reproduces. The full
 *  call is already in the conversation; the nudge only needs the
 *  identifying head (command, URL, path, task). */
const NUDGE_PARAMS_MAX = 200

/** Build a corrective system message for a detected loop. `n` is the
 *  nudge ordinal (1-based). Names the repeated call so the model can
 *  see exactly what it's stuck on. */
export function loopNudgeMessage(call: ToolCallPart | undefined, n: number): string {
  const what = call ? `\`${call.name}\` (${truncate(safeStringify(call.params))})` : "the same action"
  return (
    `You've run ${what} repeatedly with the same result — the call you keep repeating. ` +
    `Repeating it won't produce new information. ` +
    `Answer the user from what you already have, or try a different command/approach. ` +
    `Do not re-run the same call. (loop nudge ${n})`
  )
}

function truncate(s: string, max = NUDGE_PARAMS_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
