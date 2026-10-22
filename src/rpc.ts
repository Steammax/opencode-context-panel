import { Rpc } from "@opencode/plugin/rpc"

/**
 * The contract between the two halves of the plugin:
 *
 * - `index.ts` runs on the server, inspects the request OpenCode is about to send
 *   and stores one snapshot per session;
 * - `tui.tsx` runs in the CLI, asks for the snapshot of the session it renders and
 *   draws the panel.
 *
 * `breakdown` is addressed by session id and dispatched to the location the TUI
 * passes along, so each project reads its own snapshot.
 */
export const ContextPanelRpc = Rpc.define({
  id: "context-panel",
  methods: {
    breakdown: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          categories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                tokens: { type: "number" },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      tokens: { type: "number" },
                    },
                    required: ["label", "tokens"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["key", "label", "tokens"],
              additionalProperties: false,
            },
          },
          compaction: {
            type: "string",
            enum: ["running", "done"],
          },
        },
        required: ["categories"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

/** A named chunk inside a category: a tool, a memory file, a message kind. */
export interface BreakdownItem {
  label: string
  tokens: number
}

export interface BreakdownCategory {
  key: string
  label: string
  tokens: number
  items?: BreakdownItem[]
}

/** Categories with a non-zero footprint; an empty list means "nothing recorded yet". */
export interface Breakdown {
  categories: BreakdownCategory[]
  /**
   * Set while a compaction is running, and kept after it ends until the next
   * request measures the result. A compaction never goes through the model
   * request the snapshot is taken from, so the panel needs to be told.
   */
  compaction?: "running" | "done"
}
