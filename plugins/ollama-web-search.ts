import type { MetaPart, TextPart } from "@zaly/ai"
import type { PluginApi } from "@zaly/plugin"

import { AiError } from "@zaly/ai"

/**
 * Ollama's hosted web search API (https://ollama.com/api/web_search) as a
 * regular zaly tool.
 *
 * Companion to `ollama.ts`, which only registers the local model provider.
 * This one is provider-agnostic: it works with any active model, since the
 * search happens server-side at Ollama, not inside the model.
 *
 * Authentication: reads `OLLAMA_API_KEY` from the environment, same
 * convention `search.ts` uses for `BRAVE_API_KEY`. Without it the plugin
 * registers nothing and the tool simply isn't available.
 *
 * Docs: https://docs.ollama.com/capabilities/web-search
 */

const ENDPOINT = "https://ollama.com/api/web_search"

interface WebSearchResult {
  title?: string
  url?: string
  content?: string
}

interface WebSearchResponse {
  results?: WebSearchResult[]
}

export default async function OllamaWebSearchPlugin(api: PluginApi) {
  if (!process.env.OLLAMA_API_KEY) {
    api.log.warn("ollama web search disabled: set OLLAMA_API_KEY to enable the `web_search` tool.")
    return
  }

  // oxlint-disable-next-line sort-keys -- semantic field order: name, desc, params, call
  api.tools.register({
    name: "web_search",
    desc:
      "Web search via Ollama's hosted API. Returns ranked results with " +
      "title, URL and a content snippet from each page.",
    parallel: true,
    // Plain JSON Schema: the plugin package doesn't depend on typebox, and
    // the validator only consumes the runtime shape.
    params: {
      properties: {
        max_results: {
          default: 5,
          description: "Maximum number of results to return.",
          maximum: 10,
          minimum: 1,
          type: "integer",
        },
        query: {
          description: "The search query.",
          type: "string",
        },
      },
      required: ["query"],
      type: "object",
    } as never,

    async call(args): Promise<(MetaPart | TextPart)[]> {
      const { query, max_results } = args as { query: string; max_results?: number }
      const apiKey = process.env.OLLAMA_API_KEY
      if (!apiKey) {
        throw new AiError({
          code: "MISSING_API_KEY",
          message:
            "web_search requires OLLAMA_API_KEY in the environment. Get a key at " +
            "https://ollama.com/settings/keys.",
        })
      }

      const t0 = Date.now()
      const res = await fetch(ENDPOINT, {
        body: JSON.stringify({
          max_results: max_results ?? 5,
          query,
        }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        method: "POST",
      })

      if (!res.ok) {
        const body = await res.text().catch(() => "")
        throw new AiError({
          code: "WEB_SEARCH_FAILED",
          data: { status: res.status, statusText: res.statusText },
          message: `Ollama web search failed (${res.status} ${res.statusText}): ${body.slice(0, 200)}`,
          retryable: res.status >= 500 || res.status === 429,
        })
      }

      const json = (await res.json()) as WebSearchResponse
      const results = json.results ?? []

      const parts: (MetaPart | TextPart)[] = [
        {
          data: { count: results.length, durationMs: Date.now() - t0, query },
          tag: "web_search",
          type: "meta",
        },
      ]

      if (results.length === 0) {
        parts.push({ text: "No results found.", type: "text" })
        return parts
      }

      for (const r of results) {
        parts.push({ data: { title: r.title, url: r.url }, tag: "source", type: "meta" })
        const body: string[] = []
        if (r.title) body.push(`# ${r.title}`)
        if (r.content) body.push(r.content)
        if (body.length > 0) parts.push({ text: body.join("\n\n"), type: "text" })
      }

      return parts
    },
  })

  // Registered tools only reach the agent when listed in `tools.active`,
  // so opt in here instead of asking users to edit their config.
  api.tools.active = [...new Set([...api.tools.active, "web_search"])]
  api.log.info("ollama web search enabled")
}
