import type { BreakdownCategory, BreakdownItem } from "./rpc"

/**
 * Turns the request that OpenCode actually sent to the model into the
 * Claude-Code-style breakdown shown in the sidebar.
 *
 * Everything here is measured from real content: `system` and `tools` are the
 * exact payload the model received, `messages` is the exact transcript. Only the
 * character→token conversion is approximate; the TUI rescales the result to the
 * prompt size the provider reported, so the relative sizes are what matters.
 */

interface SystemPart {
  text?: string
}

interface ToolDefinition {
  description?: string
  input?: unknown
}

interface RequestMessage {
  role?: string
  content?: Array<Record<string, unknown>>
}

export interface RequestShape {
  system?: SystemPart[]
  tools?: Record<string, ToolDefinition>
  messages?: RequestMessage[]
}

/** Roughly four ASCII characters per token; non-latin scripts need about two. */
function estimateTokens(text: string): number {
  let ascii = 0
  let wide = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 128) ascii++
    else wide++
  }
  return Math.ceil(ascii / 4 + wide / 2)
}

const MAX_ITEMS = 32

/** Flat estimate for an image or file the model receives as an attachment. */
const MEDIA_TOKENS = 1_500
/** Providers downscale large images first (Anthropic: ~1.15 MP), so the cost tops out here. */
const MAX_MEDIA_TOKENS = 1_600

function mediaTokens(media: unknown): number {
  const info = (media as { info?: { width?: unknown; height?: unknown } } | undefined)?.info
  const width = info?.width
  const height = info?.height
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    return Math.min(Math.ceil((width * height) / 750), MAX_MEDIA_TOKENS)
  }
  return MEDIA_TOKENS
}

/** One category, accumulated from the labelled chunks that belong to it. */
class Bucket {
  readonly items: BreakdownItem[] = []

  constructor(
    readonly key: string,
    readonly label: string,
  ) {}

  addTokens(label: string, tokens: number) {
    if (tokens > 0) this.items.push({ label, tokens })
  }

  add(label: string, text: string) {
    if (!text) return
    this.addTokens(label, estimateTokens(text))
  }

  get tokens() {
    return this.items.reduce((sum, item) => sum + item.tokens, 0)
  }

  result(): BreakdownCategory {
    return {
      key: this.key,
      label: this.label,
      tokens: this.tokens,
      items: this.items.slice(0, MAX_ITEMS),
    }
  }
}

type Buckets = Record<
  "messages" | "systemTools" | "skills" | "systemPrompt" | "memory" | "mcpTools" | "mcpInstructions" | "agents",
  Bucket
>

/** Display order of the categories, top to bottom. */
const ORDER = ["messages", "systemTools", "skills", "systemPrompt", "memory", "mcpTools", "mcpInstructions", "agents"] as const

/**
 * Markers OpenCode uses when it assembles the system prompt. They are the only
 * way to tell the injected sections apart — system parts carry no metadata.
 */
const SKILLS_TAG = /<available_skills>[\s\S]*?<\/available_skills>/gi
const MCP_TAG = /<mcp_instructions>[\s\S]*?<\/mcp_instructions>/gi
const MEMORY_HEADER = /^Instructions from: /m
const MEMORY_HEADER_ONE = /^Instructions from: (.+)$/m
const MEMORY_SPLIT = /^(?=Instructions from: )/m
const AGENTS_MARKER = "Available subagents:"

/** Message sub-rows, in display order. */
const MESSAGE_KINDS = ["User", "Assistant", "Tool calls", "Tool results", "System notes"] as const

type MessageKind = (typeof MESSAGE_KINDS)[number]

function serialize(value: unknown, part: boolean): string {
  try {
    const result = JSON.stringify(value, (key, item) => {
      // Provider bookkeeping and raw bytes are never sent as text. `metadata` and
      // `cache` are only bookkeeping on a part itself — a tool input may legitimately
      // carry a field with that name, so values keep theirs.
      if (key === "providerMetadata") return undefined
      if (part && (key === "metadata" || key === "cache")) return undefined
      if (item instanceof Uint8Array) return undefined
      return item
    })
    return result ?? ""
  } catch {
    return ""
  }
}

/** Serializes a value the model reads: a tool input, a tool result. */
function stringifyValue(value: unknown): string {
  return serialize(value, false)
}

/** Serializes a whole part, whose metadata and cache hints are not content. */
function stringifyPart(part: unknown): string {
  return serialize(part, true)
}

function partTokens(part: Record<string, unknown> | undefined): number {
  if (!part) return 0
  if (part.type === "media") return mediaTokens(part.media)
  if (part.type === "tool-call") return estimateTokens(`${part.name}\n${stringifyValue(part.input)}`)
  if (part.type === "tool-result") {
    const result = part.result as { type?: unknown; value?: unknown } | undefined
    const value = result?.value
    if (result?.type === "content" && Array.isArray(value)) {
      let tokens = 0
      for (const item of value as Array<Record<string, unknown>>) {
        if (item?.type === "text" && typeof item.text === "string") tokens += estimateTokens(item.text)
        else if (item?.type === "file") tokens += MEDIA_TOKENS
      }
      return tokens
    }
    return estimateTokens(typeof value === "string" ? value : stringifyValue(value))
  }
  if (typeof part.text === "string") return estimateTokens(part.text)
  if (typeof part.content === "string") return estimateTokens(part.content)
  return estimateTokens(stringifyPart(part))
}

function takeTag(bucket: Bucket, text: string, pattern: RegExp, label: string): string {
  return text.replace(pattern, (match) => {
    bucket.add(label, match)
    return ""
  })
}

function categorizeSystem(parts: SystemPart[], buckets: Buckets) {
  for (const part of parts) {
    let rest = part?.text ?? ""
    if (!rest) continue

    rest = takeTag(buckets.skills, rest, SKILLS_TAG, "skills")
    rest = takeTag(buckets.mcpInstructions, rest, MCP_TAG, "mcp instructions")

    const start = rest.search(MEMORY_HEADER)
    if (start < 0) {
      buckets.systemPrompt.add("system", rest)
      continue
    }

    const head = rest.slice(0, start)
    if (head.trim()) buckets.systemPrompt.add("system", head)

    const blocks = rest.slice(start).split(MEMORY_SPLIT)
    for (const block of blocks) {
      if (!block.trim()) continue
      const name = MEMORY_HEADER_ONE.exec(block)?.[1]?.trim() || "instructions"
      buckets.memory.add(name, block)
    }
  }
}

function categorizeTools(tools: Record<string, ToolDefinition>, mcpServers: string[], buckets: Buckets) {
  for (const [name, tool] of Object.entries(tools ?? {})) {
    let body = `${name}\n${tool?.description ?? ""}\n${JSON.stringify(tool?.input ?? {})}`

    // The subagent tool advertises the configured agents inside its description.
    const agentsAt = body.indexOf(AGENTS_MARKER)
    if (agentsAt >= 0) {
      buckets.agents.add("custom agents", body.slice(agentsAt))
      body = body.slice(0, agentsAt)
    }

    const isMcp = mcpServers.some(
      (server) => server && (name === server || name.startsWith(`${server}_`) || name.startsWith(`${server}__`)),
    )
    const bucket = isMcp ? buckets.mcpTools : buckets.systemTools
    bucket.add(name, body)
  }
}

function categorizeMessages(messages: RequestMessage[], buckets: Buckets) {
  const kinds: Record<MessageKind, number> = {
    User: 0,
    Assistant: 0,
    "Tool calls": 0,
    "Tool results": 0,
    "System notes": 0,
  }

  for (const message of messages ?? []) {
    const role = message?.role
    for (const part of message?.content ?? []) {
      const tokens = partTokens(part)
      if (!tokens) continue
      const type = typeof part?.type === "string" ? part.type : undefined

      // Bucket by what the part is, not by who carries it: a provider-executed
      // tool can return its result inside an assistant message.
      if (type === "tool-call") kinds["Tool calls"] += tokens
      else if (type === "tool-result") kinds["Tool results"] += tokens
      else if (role === "user") kinds.User += tokens
      else if (role === "system") kinds["System notes"] += tokens
      else kinds.Assistant += tokens
    }
  }

  for (const kind of MESSAGE_KINDS) {
    buckets.messages.addTokens(kind, kinds[kind])
  }
}

/** Categories with a non-zero footprint, in display order. */
export function buildCategories(request: RequestShape, mcpServers: string[]): BreakdownCategory[] {
  const buckets: Buckets = {
    messages: new Bucket("messages", "Messages"),
    systemTools: new Bucket("systemTools", "System tools"),
    skills: new Bucket("skills", "Skills"),
    systemPrompt: new Bucket("systemPrompt", "System prompt"),
    memory: new Bucket("memory", "Memory files"),
    mcpTools: new Bucket("mcpTools", "MCP tools"),
    mcpInstructions: new Bucket("mcpInstructions", "MCP instructions"),
    agents: new Bucket("agents", "Custom agents"),
  }

  categorizeMessages(request.messages ?? [], buckets)
  categorizeTools(request.tools ?? {}, mcpServers, buckets)
  categorizeSystem(request.system ?? [], buckets)

  return ORDER.filter((key) => buckets[key].tokens > 0).map((key) => buckets[key].result())
}
