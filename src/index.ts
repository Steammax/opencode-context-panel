import { Plugin } from "@opencode/plugin"
import { buildCategories, type RequestShape } from "./categories"
import { ContextPanelRpc, type Breakdown } from "./rpc"

/** Keep the most recent sessions only; the TUI asks for the session it shows. */
const MAX_SESSIONS = 200
/** MCP server names barely change, so they are cached instead of fetched per request. */
const MCP_CACHE_MS = 30_000

const EMPTY: Breakdown = { categories: [] }

export default Plugin.define({
  id: "context-panel",
  async setup(ctx) {
    const snapshots = new Map<string, Breakdown>()

    let mcpServers: Promise<string[]> | undefined
    let mcpLoadedAt = 0

    const fetchMcpServers = async (): Promise<string[]> => {
      const response: unknown = await ctx.mcp.list()
      const list = Array.isArray(response) ? response : ((response as { data?: unknown[] })?.data ?? [])
      return list
        .map((server) => (server as { name?: unknown })?.name)
        .filter((name): name is string => typeof name === "string")
    }

    /** Concurrent requests share one lookup; a failed lookup is retried on the next request. */
    const loadMcpServers = () => {
      if (mcpServers && Date.now() - mcpLoadedAt < MCP_CACHE_MS) return mcpServers
      mcpLoadedAt = Date.now()
      const pending: Promise<string[]> = fetchMcpServers().catch(() => {
        if (mcpServers === pending) mcpServers = undefined
        return []
      })
      mcpServers = pending
      return pending
    }

    // Runs on every model call with the assembled request, so the panel always
    // reflects what the model is about to read.
    await ctx.session.hook("context", async (event) => {
      try {
        const servers = await loadMcpServers()
        const snapshot: Breakdown = {
          categories: buildCategories(event as unknown as RequestShape, servers),
        }

        snapshots.delete(event.sessionID)
        snapshots.set(event.sessionID, snapshot)
        while (snapshots.size > MAX_SESSIONS) {
          const oldest = snapshots.keys().next().value
          if (oldest === undefined) break
          snapshots.delete(oldest)
        }
      } catch (error) {
        console.error("[context-panel] could not inspect the request", error)
      }
    })

    await ctx.rpc.register(ContextPanelRpc, {
      breakdown: async (input) => {
        // The JSON-schema input decodes to `unknown`, so narrow it here.
        const sessionID = (input as { sessionID?: string } | undefined)?.sessionID
        return (sessionID && snapshots.get(sessionID)) || EMPTY
      },
    })
  },
})
