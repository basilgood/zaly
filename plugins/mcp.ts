import type { AnyTool } from "@zaly/agent"
import type { McpServerConfig, PluginApi } from "@zaly/plugin"

import { AiError } from "@zaly/ai"
import { Spawn, TextStream } from "@zaly/shared/process"

/**
 * MCP adapter: connects to the servers listed under `mcp.servers` in zaly
 * config and exposes every tool they advertise as a regular zaly tool.
 *
 * Deliberately minimal — no proxy tool, no metadata cache, no OAuth, no
 * resource/prompt support. Servers are connected once at plugin load and
 * torn down with the plugin.
 *
 * Schemas are passed through untouched: MCP servers own argument
 * validation, zaly only needs the shape to describe the tool to the
 * model. This is why `params` is cast — the tool's schema type is
 * TypeBox, but a JSON Schema object is structurally what both the
 * provider and the validator consume.
 *
 * Permission gating comes for free: `Tasks.#preflight` checks the
 * generic `tool` scope for every dispatch, so `tool(mcp_*)` rules in a
 * preset gate these tools like any builtin.
 */

interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface McpContent {
  type: string
  text?: string
}

const PROTOCOL_VERSION = "2025-06-18"
const START_TIMEOUT = 60_000
const CALL_TIMEOUT = 300_000

class McpConnection {
  readonly name: string
  #server: McpServerConfig
  #api: PluginApi
  #proc!: Spawn<string, string>
  #out = new TextStream()
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  #nextId = 1
  #started?: Promise<void>

  constructor(name: string, server: McpServerConfig, api: PluginApi) {
    this.name = name
    this.#server = server
    this.#api = api
  }

  start(): Promise<void> {
    return (this.#started ??= this.#connect())
  }

  async #connect(): Promise<void> {
    this.#proc = new Spawn(this.#server.command, this.#server.args ?? [], {
      env: { ...process.env, ...this.#server.env },
      keepStdinOpen: true,
      signal: this.#api.signal,
      stderr: new TextStream(),
      stdout: this.#out,
    })
    this.#api.signal.addEventListener("abort", () => this.#proc.kill(), { once: true })
    void this.#read()
    await this.request(
      "initialize",
      {
        capabilities: {},
        clientInfo: { name: "zaly", version: "0.0.0" },
        protocolVersion: PROTOCOL_VERSION,
      },
      START_TIMEOUT
    )
    this.#write({ jsonrpc: "2.0", method: "notifications/initialized" })
  }

  async #read(): Promise<void> {
    for await (const line of this.#out.lines()) {
      if (!line.trim()) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        this.#api.log.debug(`mcp:${this.name} ignoring non-JSON stdout: ${line}`)
        continue
      }
      if (msg.id === undefined) continue
      const pending = this.#pending.get(msg.id)
      if (!pending) continue
      this.#pending.delete(msg.id)
      if (msg.error) pending.reject(new AiError({ code: "MCP_ERROR", message: msg.error.message ?? "request failed" }))
      else pending.resolve(msg.result)
    }
    // stdout closed — fail anything still waiting on the dead server.
    for (const [, pending] of this.#pending) {
      pending.reject(new AiError({ code: "MCP_ERROR", message: `MCP server \`${this.name}\` exited` }))
    }
    this.#pending.clear()
  }

  #write(msg: unknown): void {
    this.#proc.write(`${JSON.stringify(msg)}\n`)
  }

  request<T = unknown>(method: string, params?: unknown, timeout = CALL_TIMEOUT): Promise<T> {
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new AiError({ code: "TIMEOUT", message: `MCP \`${this.name}\`: ${method} timed out` }))
      }, timeout)
      this.#pending.set(id, {
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
      })
      this.#write({ id, jsonrpc: "2.0", method, params })
    })
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request<{ tools?: McpTool[] }>("tools/list", {})
    return result.tools ?? []
  }

  async call(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = await this.request<{ content?: McpContent[]; isError?: boolean }>("tools/call", {
      arguments: args,
      name: tool,
    })
    const text = (result.content ?? [])
      .map((part) => part.text ?? `[${part.type}]`)
      .join("\n")
    return { isError: result.isError === true, text: text || "(no output)" }
  }
}

/** Tool names go over the wire to the provider, so keep them to the
 *  conservative `[a-zA-Z0-9_-]{1,64}` shape every provider accepts. */
export function toolName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replaceAll(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

function loadConfig(api: PluginApi): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, server] of Object.entries(api.config.mcp?.servers ?? {})) {
    if (server.disabled) continue
    servers[name] = server
  }
  return servers
}

function register(api: PluginApi, conn: McpConnection, server: string, tool: McpTool): AnyTool {
  const name = toolName(server, tool.name)
  // oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
  api.tools.register({
    name,
    desc: `[MCP:${server}] ${tool.description ?? tool.name}`,
    // MCP servers own validation; the schema only describes the tool.
    params: (tool.inputSchema ?? { type: "object" }) as never,
    call: async (args) => {
      const result = await conn.call(tool.name, args as Record<string, unknown>)
      if (result.isError) {
        throw new AiError({ code: "MCP_ERROR", message: result.text, retryable: true })
      }
      return [
        { data: { server, tool: tool.name }, tag: "mcp", type: "meta" },
        { text: result.text, type: "text" },
      ]
    },
  })
  return name
}

export default async function McpPlugin(api: PluginApi): Promise<void> {
  const servers = loadConfig(api)
  const names: AnyTool[] = []
  await Promise.all(
    Object.entries(servers).map(async ([server, config]) => {
      const conn = new McpConnection(server, config, api)
      try {
        await conn.start()
        const tools = await conn.listTools()
        const want = config.tools
        const allowed = want ? new Set(want) : undefined
        const selected = allowed ? tools.filter((t) => allowed.has(t.name)) : tools
        if (want) {
          const known = new Set(tools.map((t) => t.name))
          const unknown = want.filter((t) => !known.has(t))
          if (unknown.length > 0)
            api.log.warn(`mcp:${server} ignoring unknown tools: ${unknown.join(", ")}`)
        }
        for (const tool of selected) names.push(register(api, conn, server, tool))
        api.log.info(`mcp:${server} connected with ${selected.length} tools`)
      } catch (error) {
        api.log.error(`mcp:${server} failed to start: ${(error as Error).message}`)
        api.ui.notify(`MCP server \`${server}\` failed to start.\n* ${(error as Error).message}`, {
          level: "error",
        })
      }
    })
  )
  // Registered tools only reach the agent when listed in `tools.active`,
  // so opt them in here instead of asking users to edit their config.
  api.tools.active = [...new Set([...api.tools.active, ...names])]
}
