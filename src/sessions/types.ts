export interface StoredMessage {
  role: "user" | "assistant"
  content: string
  timestamp: string
}

export interface Session {
  id: string
  createdAt: string
  updatedAt: string
  messages: StoredMessage[]
  /** Full Anthropic MessageParam history. Takes precedence over `messages` for API calls. */
  rawHistory?: Array<{ role: "user" | "assistant"; content: unknown }>
  /** Last known context-window token count (input + output from the most recent API call). */
  tokenCount?: number
  /** Pre-built compaction summary — ready to swap in instantly when the hard limit is hit. */
  compactionSummary?: string
}
