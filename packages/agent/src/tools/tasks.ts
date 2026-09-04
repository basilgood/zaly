import type { ToolContext } from "@zaly/ai"
import type { Tasks } from "../tasks.ts"

import { defineTool, AiError } from "@zaly/ai"
import { Type } from "typebox"
import { taskInfoPart } from "../tasks.ts"

/**
 * Generic task management surface for the model.
 *
 *  - `task_list`: enumerate running and recently-finished tasks.
 *  - `task_stop`: abort a running task. Idempotent.
 *
 * "Wait for a task" is intentionally absent — heartbeats keep the loop
 * alive while tasks run, and `task-done` injects the final result as a
 * system message automatically. If the model wants explicit polling
 * cadence on something specific, it schedules a `wakeup` instead.
 *
 * Permission gating, when wired up, is the harness's concern; these
 * tools are intentionally thin so the policy lives one layer up.
 */

// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const taskListTool = defineTool({
  name: "task_list",
  desc:
    "List active and recently-finished tasks (running shells, subagents, " +
    "other long-running work).",
  parallel: true,
  params: Type.Object({
    includeFinished: Type.Optional(
      Type.Boolean({
        default: false,
        description: "When true, also include tasks that have already completed in this session.",
      })
    ),
  }),

  call(args, ctx) {
    const tasks = requireTasks(ctx)
    // Routes through `taskInfoPart` so the `result` strip + line-per-task
    // JSON format stays consistent with heartbeat output. Done tasks
    // surface only their identity / timing, not their (potentially huge)
    // captured body.
    const info = tasks
      .info()
      .filter((task) => (args.includeFinished ?? false) || task.status !== "done")
    return taskInfoPart(info)
  },
})

// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const taskPollTool = defineTool({
  name: "task_poll",
  desc:
    "Read the latest incremental output from a running task. Returns " +
    "only what's arrived since the previous `task_poll`. Errors if the " +
    "task is already done or has no streaming output.",
  parallel: true,
  params: Type.Object({
    id: Type.String({ description: "Task id to poll." }),
  }),

  call(args, ctx) {
    const tasks = requireTasks(ctx)
    const snap = tasks.pollOutput(args.id)
    // The snapshot's `content` already carries any streamable-emitted
    // MetaParts (bash's `<shell>`, etc.), so the model sees status +
    // incremental output in one go. Returning content directly avoids
    // the JSON-stringify path normalize would take on a ToolResult shape.
    return snap.content
  },
})

// oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
export const taskStopTool = defineTool({
  name: "task_stop",
  desc:
    "Stop a running task. Aborts the underlying work; pending tasks " +
    "chained behind it get auto-cancelled. Idempotent.",
  params: Type.Object({
    id: Type.String({ description: "Task id to stop." }),
  }),

  call(args, ctx) {
    const tasks = requireTasks(ctx)
    const task = tasks.get(args.id)
    if (!task) {
      throw new AiError({
        code: "NOT_FOUND",
        data: { id: args.id },
        message: `no task with id "${args.id}"`,
      })
    }
    tasks.abort(args.id, "stopped via task_stop")
    return `task ${args.id} stopped`
  },
})

// ── Internals ──────────────────────────────────────────────────────────

function requireTasks(ctx: ToolContext): Tasks {
  if (!ctx.tasks) {
    throw new AiError({
      code: "MISSING_TOOL_CONTEXT",
      message: "task tools require a Tasks registry on the context (set up by the agent harness).",
    })
  }
  return ctx.tasks
}
