import type { AgentContext, PromptCollection, ToolCollection } from "@zaly/agent"
import type { ModelCollection } from "@zaly/ai"
import type { LogApi, Logger } from "@zaly/shared/logger"
import type { Renderer, Theme } from "@zaly/tui"
import type { Notifier } from "@zaly/tui/services/notifier"
import type { Picker } from "@zaly/tui/services/picker"

/** MCP server entry, mirroring the `mcp.servers` config shape. Declared here
 *  rather than imported so `@zaly/plugin` does not depend on `@zaly/config`.
 *  The CLI passes its resolved config in; a drift in that shape breaks the
 *  assignment at the host construction site. */
export type McpServerConfig = {
  /** Command that starts the server, e.g. `npx`. */
  command: string
  /** Arguments passed to the command. */
  args?: string[]
  /** Extra environment variables for the server process. */
  env?: Record<string, string>
  /** Only register these tools, by the server's own names. Unset means
   *  every tool the server advertises. */
  tools?: string[]
  /** Skip this server without removing its entry. */
  disabled?: boolean
}

/** The subset of the resolved zaly config that plugins may read. */
export type PluginConfig = {
  mcp?: {
    servers?: Record<string, McpServerConfig>
  }
}

/** Internal host capabilities used to implement PluginApi.
 *  Never exposed directly to plugin code.
 */
export type PluginHost = {
  ctx: AgentContext
  /** Effective zaly config, as resolved from user/workspace/project files. */
  config: PluginConfig
  logger: Logger
  log: LogApi
  renderer: Renderer
  pick: Picker["pick"]
  notify: Notifier["notify"]
  prompt: (msg: string) => Promise<string | undefined>
  loadTheme: (name: string) => Promise<Theme>
  tools: ToolCollection
  model: ModelCollection
  prompts: PromptCollection
}
