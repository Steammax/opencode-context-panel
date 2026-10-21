/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { ContextPanelRpc, type Breakdown, type BreakdownCategory } from "./rpc"

/** Display order of the categories, top to bottom. */
const ORDER = ["messages", "systemTools", "skills", "systemPrompt", "memory", "mcpTools", "mcpInstructions", "agents"]

/** Fixed numeric columns keep every row's values right-aligned. */
const TOKENS_WIDTH = 7
const PERCENT_WIDTH = 6

/** The breakdown is refetched when a step finishes, and re-read while streaming. */
const REFRESH_DEBOUNCE_MS = 400
const TICK_THROTTLE_MS = 250

type SessionEvent = "session.step.ended" | "session.idle" | "session.model.selected" | "session.usage.updated"

interface Usage {
  /** Tokens the model read: fresh input plus both cache counters. */
  prompt: number
  /** Everything the request occupies in the window: the prompt plus its answer. */
  used: number
}

interface Row {
  label: string
  tokens: number
  color: RGBA
  /** 0 = category, 1 = its breakdown (only Messages has one). */
  depth: number
}

/** Shapes the client hands back; only the fields the panel reads are listed. */
interface TokenUsage {
  input?: number
  output?: number
  cache?: { read?: number; write?: number }
}

interface AssistantMessage {
  type?: string
  tokens?: TokenUsage
  time?: { created?: number }
  model?: { id?: string; providerID?: string }
}

interface ModelEntry {
  modelID?: string
  providerID?: string
  limit?: { context?: number }
}

interface SessionEventPayload {
  data?: { sessionID?: string }
}

function fmt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`
  }
  return String(Math.round(value))
}

function percent(value: number, total: number): string {
  if (!total) return ""
  return `${((value / total) * 100).toFixed(1)}%`
}

/** A right-aligned numeric column, so values line up across every row. */
function Cell(props: { width: number; fg: RGBA; children: string }) {
  return (
    <box flexDirection="row" width={props.width} justifyContent="flex-end" marginLeft={1}>
      <text fg={props.fg} selectable={false}>
        {props.children}
      </text>
    </box>
  )
}

function RowLine(props: { row: Row; limit: number }) {
  const ctx = usePlugin()
  const top = () => props.row.depth === 0

  return (
    <box flexDirection="row" height={1}>
      <text fg={props.row.color} selectable={false}>
        {top() ? "\u25a0 " : "  "}
      </text>
      <text
        fg={top() ? ctx.theme.text.muted : ctx.theme.text.faint}
        wrapMode="none"
        flexShrink={1}
        marginRight={1}
        selectable={false}
      >
        {props.row.label}
      </text>
      <box flexGrow={1} />
      <Cell width={TOKENS_WIDTH} fg={top() ? ctx.theme.text.base : ctx.theme.text.muted}>
        {fmt(props.row.tokens)}
      </Cell>
      <Show when={props.limit > 0}>
        <Cell width={PERCENT_WIDTH} fg={ctx.theme.text.faint}>
          {percent(props.row.tokens, props.limit)}
        </Cell>
      </Show>
    </box>
  )
}

function Panel(props: { sessionID: string }) {
  const ctx = usePlugin()
  const [snapshot, setSnapshot] = createSignal<Breakdown>()
  const [failed, setFailed] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let tickTimer: ReturnType<typeof setTimeout> | undefined
  let requestSeq = 0

  const refresh = async () => {
    const seq = ++requestSeq
    try {
      const result = await ctx.client
        .rpc(ContextPanelRpc)
        .breakdown({ sessionID: props.sessionID }, { location: ctx.location })
      if (seq !== requestSeq) return
      setSnapshot(result as Breakdown)
      setFailed(false)
    } catch {
      if (seq !== requestSeq) return
      setFailed(true)
    }
  }

  /** The slot reuses this panel when another session is opened, so start over. */
  createEffect(
    on(
      () => props.sessionID,
      () => {
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = undefined
        setSnapshot(undefined)
        setFailed(false)
        void refresh()
      },
    ),
  )

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, REFRESH_DEBOUNCE_MS)
  }

  /** Re-reads the transcript while a response streams in, at a sane rate. */
  const scheduleTick = () => {
    if (tickTimer) return
    tickTimer = setTimeout(() => {
      tickTimer = undefined
      setTick((value) => value + 1)
    }, TICK_THROTTLE_MS)
  }

  const onSession = (type: SessionEvent, handler: () => void) =>
    ctx.data.on(type, (event: SessionEventPayload) => {
      if (event?.data?.sessionID === props.sessionID) handler()
    })

  /** The newest assistant message that carries usage. */
  const latest = createMemo<AssistantMessage | undefined>(() => {
    tick()
    const messages = (ctx.data.session.message.list(props.sessionID) ?? []) as AssistantMessage[]
    let newest: AssistantMessage | undefined
    for (const message of messages) {
      if (message?.type !== "assistant" || !message.tokens) continue
      const created = message.time?.created ?? 0
      if (!newest || created >= (newest.time?.created ?? 0)) newest = message
    }
    return newest
  })

  const usage = createMemo<Usage | undefined>(() => {
    const tokens = latest()?.tokens
    if (!tokens) return undefined
    const prompt = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
    return { prompt, used: prompt + (tokens.output ?? 0) }
  })

  const limit = createMemo<number>(() => {
    tick()
    const model = latest()?.model
    if (!model) return 0
    const models = (ctx.data.location.model.list(ctx.location) ?? []) as ModelEntry[]
    const entry = models.find((item) => item?.modelID === model.id && item?.providerID === model.providerID)
    return entry?.limit?.context ?? 0
  })

  /**
   * Category sizes are measured in characters, so they are rescaled to the exact
   * prompt size from the provider's usage. Ratios between rows stay as measured.
   */
  const rows = createMemo<Row[]>(() => {
    const snap = snapshot()
    const sizes = usage()
    if (!snap || !sizes) return []

    const measured = snap.categories.reduce((sum, category) => sum + category.tokens, 0)
    const scale = measured > 0 && sizes.prompt > 0 ? sizes.prompt / measured : 1
    const palette = ctx.theme.categorical

    const ordered: Array<{ category: BreakdownCategory; tokens: number }> = snap.categories
      .map((category) => ({ category, tokens: category.tokens * scale }))
      .sort((a, b) => ORDER.indexOf(a.category.key) - ORDER.indexOf(b.category.key))

    const rows: Row[] = []
    ordered.forEach((entry, index) => {
      const color = palette[index % palette.length]?.[400] ?? ctx.theme.text.base
      rows.push({ label: entry.category.label, tokens: entry.tokens, color, depth: 0 })

      const items = entry.category.items ?? []
      if (entry.category.key !== "messages" || items.length < 2) return
      for (const item of items) {
        rows.push({ label: item.label, tokens: item.tokens * scale, color, depth: 1 })
      }
    })
    return rows
  })

  const free = createMemo<number | undefined>(() => {
    const sizes = usage()
    const max = limit()
    if (!sizes || !max) return undefined
    return Math.max(0, max - sizes.used)
  })

  const bar = createMemo(() => {
    const segments = rows()
      .filter((row) => row.depth === 0)
      .map((row) => ({ tokens: row.tokens, color: row.color }))
    const rest = free()
    if (rest !== undefined && rest > 0) segments.push({ tokens: rest, color: ctx.theme.text.faint })
    return segments.filter((segment) => segment.tokens > 0)
  })

  /** Explains an empty panel: no request yet, no snapshot, or a failed RPC. */
  const hint = createMemo<string | undefined>(() => {
    if (failed()) return "unavailable"
    if (!usage()) return "waiting for first request"
    if (!rows().length) return "no snapshot for this session yet"
    return undefined
  })

  const header = createMemo(() => {
    const sizes = usage()
    const max = limit()
    if (!sizes) return undefined
    return {
      percent: max ? percent(sizes.used, max) : "",
      total: max ? `${fmt(sizes.used)} / ${fmt(max)}` : `${fmt(sizes.used)} tokens`,
    }
  })

  const subscriptions = [
    onSession("session.step.ended", () => {
      void refresh()
      setTick((value) => value + 1)
    }),
    onSession("session.idle", scheduleRefresh),
    onSession("session.model.selected", scheduleRefresh),
    onSession("session.usage.updated", scheduleTick),
  ]

  onCleanup(() => {
    for (const off of subscriptions) off()
    if (refreshTimer) clearTimeout(refreshTimer)
    if (tickTimer) clearTimeout(tickTimer)
  })

  onMount(() => {
    void ctx.data.location.model.sync(ctx.location)
  })

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={ctx.theme.text.base} selectable={false}>
          Context
        </text>
        <box flexGrow={1} />
        <Show when={header()}>
          {(value) => (
            <Cell width={PERCENT_WIDTH} fg={ctx.theme.text.muted}>
              {value().percent}
            </Cell>
          )}
        </Show>
      </box>

      <Show when={bar().length > 0}>
        <box flexDirection="row" height={1}>
          <For each={bar()}>
            {(segment) => (
              <box flexGrow={Math.max(segment.tokens, 1)} height={1} backgroundColor={segment.color} />
            )}
          </For>
          <Show when={header()}>
            {(value) => (
              <text fg={ctx.theme.text.muted} bg={ctx.theme.background.base} flexShrink={0} height={1} selectable={false}>
                {` ${value().total} `}
              </text>
            )}
          </Show>
        </box>
      </Show>

      <For each={rows()}>{(row) => <RowLine row={row} limit={limit()} />}</For>

      <Show when={free() !== undefined}>
        <box flexDirection="row" height={1}>
          <text fg={ctx.theme.text.faint} selectable={false}>
            {"\u25a1 "}
          </text>
          <text fg={ctx.theme.text.faint} wrapMode="none" flexShrink={1} selectable={false}>
            Free space
          </text>
          <box flexGrow={1} />
          <Cell width={TOKENS_WIDTH} fg={ctx.theme.text.muted}>
            {fmt(free() ?? 0)}
          </Cell>
          <Show when={limit() > 0}>
            <Cell width={PERCENT_WIDTH} fg={ctx.theme.text.faint}>
              {percent(free() ?? 0, limit())}
            </Cell>
          </Show>
        </box>
      </Show>

      <Show when={hint()}>
        {(message) => (
          <text fg={ctx.theme.text.faint} wrapMode="none" selectable={false}>
            {message()}
          </text>
        )}
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "context-panel",
  setup(ctx) {
    ctx.ui.slot({
      prepend: "sidebar.content",
      render: (input) => <Panel sessionID={input.sessionID} />,
    })
  },
})
