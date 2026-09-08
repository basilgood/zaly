import type { AnyTool, ToolCollection } from "@zaly/agent"
import type { Tool, ToolDef } from "@zaly/ai"
import type { Collection } from "@zaly/shared/collection"
import type { LoadedPlugin } from "../plugin.ts"

import { defineTool } from "@zaly/ai"

export class ToolsApi implements Collection<AnyTool[], AnyTool[], ToolDef> {
  #plugin: LoadedPlugin

  constructor(plugin: LoadedPlugin) {
    this.#plugin = plugin
  }

  get #tools(): ToolCollection {
    return this.#plugin.host.tools
  }

  get active(): AnyTool[] {
    return this.#tools.active
  }

  set active(tools: AnyTool[]) {
    this.#tools.active = tools
  }

  async load(tools?: AnyTool[]): Promise<Tool[]> {
    return this.#tools.load(tools)
  }

  list(): AnyTool[] {
    return this.#tools.list()
  }

  register(def: ToolDef): Tool {
    const ret = defineTool(def)
    this.#plugin.cleanup(this.#tools.register(ret))
    return ret
  }
}
