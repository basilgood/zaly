import type { TokenCount, TokenStats } from "@zaly/agent"
import type { TreeItem } from "@zaly/tui/widgets/tree"
import type { App } from "./app.ts"

import { tokenStats } from "@zaly/agent"
import { formatNumber } from "@zaly/shared"
import { stringWidth } from "@zaly/shared/ansi"
import { memo } from "@zaly/tui"

type TokenItem = TreeItem & Omit<TokenStats, "children"> & { children?: TokenItem[] }

function toItem(stats: TokenStats): TokenItem {
  const { children, ...rest } = stats
  return {
    ...rest,
    children: children
      ? [...children.values()].map(toItem).toSorted((a, b) => b.tokens - a.tokens)
      : undefined,
    text: rest.key,
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US").replace(/,/g, "_")
}

export async function contextTree(app: App) {
  const model = app.agent.ctx.model
  if (!model) {
    return app.notify("No model selected. Please select a model first.", { level: "error" })
  }
  const prompt = await app.ctx.prompts().then((p) => p.render({ cwd: app.agent.ctx.cwd, model }))
  const tools = await app.ctx.tools().then((t) => t.load())

  const collapsed = new Set<string>(["tool-result", "compaction-summary", "user-tool-use", "task"])
  const expand = (c: TokenCount) => !collapsed.has(c.type) && !(c.kind && collapsed.has(c.kind))

  const all = tokenStats(app.agent.messages, { expand, prompt, tools })
  const allItems = toItem(all)

  await app.pick({
    details:
      `The tree shows the token usage of the current context, including prompts, messages, and tools.

> [!NOTE]
> Token counts are **estimated** and may not be exact.

- **messages:** \`${formatNumber(all.count)}\`
- **tokens:** \`${formatNumber(all.tokens)}\`
`.replace(/\n+$/, "\n"),
    maxHeight: app.config.$.ui.treeHeight,
    render: (item, ctx) => {
      const s = ctx.style
      const pw = ctx.prefixWidth ?? 0
      const kw = stringWidth(item.key)
      const count = fmt(item.count).padStart(Math.max(0, 30 - pw - kw), " ")
      const tokens = fmt(item.tokens).padStart(14)
      return `${s.delim("○")} ${s.primary(item.key)} ${s.syntaxNumber(count)}${s.syntaxDelimiter("x")} ${s.syntaxNumber(tokens)}${s.muted(" tokens")}`
    },
    root: false,
    title: memo(() => `Context Token Usage (raw)`),
    tree: allItems,
    whichKey: true,
  })
}
