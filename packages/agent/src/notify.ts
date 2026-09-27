import type { Agent } from "./agent.ts"

import { formatDuration } from "@zaly/shared"

export type NotifyContext = {
  agent: Agent
}

export type NotifyOptions = {
  idle?: number // seconds of idle time (1800 = 30m)
  periodic?: number // seconds of periodic time notifications (3600 = 1h)
}

export class Notifier {
  #opts: Required<NotifyOptions>
  #lastTime?: number
  #lastStep?: number
  #ac?: AbortController

  constructor(opts: NotifyOptions = {}) {
    this.#opts = { idle: 30 * 60, periodic: 60 * 60, ...opts }
  }

  attach(agent: Agent) {
    agent.on("step-start", () => this.check(agent))
    agent.ctx.on("session", () => this.attachSession(agent))
    this.attachSession(agent)
  }

  attachSession(agent: Agent) {
    this.#ac?.abort()
    this.#ac = new AbortController()
    const opts = { signal: this.#ac.signal }
    agent.session
      .on(
        "compact",
        ({ node }) => {
          agent.notify("handoff", {
            ...this.time(),
            messages_preserved: node.tail,
            trigger: node.trigger,
          })
        },
        opts
      )
      .on(
        "session-resume",
        () => {
          agent.notify("session-resume", this.time())
        },
        opts
      )
      .on(
        "session-start",
        () => {
          agent.notify("session-start", this.time())
        },
        opts
      )
      .on(
        "cwd",
        ({ cwd }) => {
          agent.notify("cwd-changed", { cwd })
        },
        opts
      )
      .on(
        "model",
        ({ model, prev }) => {
          agent.notify("model-changed", { current: model, prev })
        },
        opts
      )
  }

  time(now = Date.now()) {
    this.#lastTime = now
    return timeInfo(now)
  }

  check(agent: Agent) {
    const now = Date.now()
    const lastInfo = this.#lastTime ? timeInfo(this.#lastTime) : undefined

    this.#lastStep ??= now
    this.#lastTime ??= now

    if (lastInfo && timeInfo(now).date !== lastInfo.date) {
      agent.notify("new-day", this.time(now))
    } else if (now - this.#lastStep > this.#opts.idle * 1000) {
      agent.notify("user-returned", {
        idle: formatDuration(this.#lastStep, { to: now }),
        ...this.time(now),
      })
    } else if (now - this.#lastTime > this.#opts.periodic * 1000) {
      agent.notify("time", this.time(now))
    }
    this.#lastStep = now

    // NOTE: context-pressure notification removed. The pct snapshot was
    // stale-by-design (chars/4 estimate vs provider usage), read-only,
    // and contradicted the redundancy handoff — the model can't act on
    // it, and injecting it biased outputs. Pressure now stays internal
    // (the 0.95 overflow fallback + statusline). The handoff is the
    // model-relevant degradation path.
  }
}

function timeInfo(t = Date.now()): {
  day: string
  date: string
  time: string
  tz: string
} {
  const now = new Date(t)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    date: now.toLocaleDateString("sv-SE", { timeZone: tz }),
    day: now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" }),
    time: now.toLocaleTimeString("sv-SE", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz,
    }),
    tz,
  }
}
