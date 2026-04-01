import Anthropic from "@anthropic-ai/sdk"
import type { Session } from "../sessions/types.js"

// Token thresholds
export const SOFT_TOKEN_THRESHOLD = 7_500    // start building summary in background
export const HARD_TOKEN_LIMIT     = 12_000   // force compaction before next turn
export const MIN_UPDATE_INTERVAL  = 2_000    // min new tokens before re-summarising

// Max characters of history to send for summarisation.
// Budget: 200k token limit − ~15k for system prompt + tools + summary prompt = ~185k safe.
// At a conservative 3 chars/token (JSON-heavy content tokenises worse than prose): 185k × 3 = 555k.
// We use 350k to stay well clear of the ceiling.
const MAX_SUMMARY_CHARS = 350_000
// Max chars kept per individual tool result to prevent one large response from
// consuming the whole budget (e.g. browser_use get_html, Astro build output).
const MAX_TOOL_RESULT_CHARS = 4_000
// How many recent message pairs to keep when no summary is available (hard fallback).
const FALLBACK_TRIM_MESSAGES = 20

/**
 * Prompt injected as the final user message to generate a structured summary.
 * Mirrors the Anthropic "instant compaction" cookbook pattern.
 */
export const SESSION_MEMORY_PROMPT = `
Compress the conversation into a structured summary that preserves all information
needed to continue work seamlessly. Optimise for the assistant's ability to continue
working, not human readability.

<summary-format>
## User Intent
The user's original request and any refinements. Use direct quotes for key requirements.

## Completed Work
Actions successfully performed — what was created/modified/deleted, exact identifiers,
values, and configurations.

## Errors & Corrections
Problems encountered, failed approaches, and verbatim user corrections ("don't do X",
"actually I meant Y"). These represent learned preferences and must be preserved exactly.

## Active Work
What was in progress when the session ended, including direct quotes showing where work
left off and any partial results.

## Pending Tasks
Remaining items explicitly requested that haven't been started.

## Key References
Identifiers, paths, URLs, values, credentials (redacted), constraints, and technical
details needed to continue the work.
</summary-format>

<rules>
- Weight recent messages heavily — the end of the transcript is the active context
- Omit pleasantries, acknowledgments, and filler
- Preserve: user corrections > errors > active work > completed work
- Keep each section under 500 words
</rules>
`.trim()

// Track sessions that have an in-flight background summary job
const runningJobs = new Set<string>()

export function shouldInitSummary(session: Session): boolean {
  return (
    session.compactionSummary === undefined &&
    (session.tokenCount ?? 0) >= SOFT_TOKEN_THRESHOLD
  )
}

export function shouldUpdateSummary(session: Session): boolean {
  if (session.compactionSummary === undefined) return false
  // Re-summarise once enough new tokens have been added since last summary
  // We use tokenCount as a proxy — if it's still above SOFT_THRESHOLD after
  // the last compaction was applied, an update may be warranted.
  return (session.tokenCount ?? 0) >= SOFT_TOKEN_THRESHOLD + MIN_UPDATE_INTERVAL
}

/**
 * Swap in the pre-built compaction summary. Replaces rawHistory with a single
 * system-context user message containing the summary, then resets token tracking.
 * Falls back to direct tail-truncation when no summary is ready yet.
 * Returns true if compaction was applied.
 */
export function applyCompaction(session: Session): boolean {
  if (session.compactionSummary) {
    session.rawHistory = [
      {
        role: "user",
        content:
          "This session is being continued from a previous conversation. " +
          "Here is the session memory:\n\n" +
          session.compactionSummary +
          "\n\nContinue from where we left off.",
      },
    ]
    session.compactionSummary = undefined
    session.tokenCount = 0
    return true
  }

  // Fallback: background summary not ready — truncate to the most recent messages
  // so the next API call doesn't exceed the context limit.
  if ((session.rawHistory?.length ?? 0) > FALLBACK_TRIM_MESSAGES) {
    let trimmed = session.rawHistory!.slice(-FALLBACK_TRIM_MESSAGES)
    // A tool_result user-message without a preceding tool_use causes a 400.
    // Walk forward until we find a user message that is plain text (not tool results).
    while (trimmed.length > 0) {
      const first = trimmed[0]
      const content = first.content
      const startsWithToolResult =
        Array.isArray(content) &&
        (content as Array<{ type?: string }>)[0]?.type === "tool_result"
      if (!startsWithToolResult) break
      // Drop this tool_result message AND the assistant message before it (already gone),
      // then skip ahead to the next user message.
      trimmed = trimmed.slice(1)
    }
    session.rawHistory = trimmed
    session.tokenCount = 0
    return true
  }

  return false
}

/**
 * Scrub a raw Anthropic message content value before serialising for summarisation:
 * - Replace base64 image source data with a placeholder (screenshots can be MBs)
 * - Truncate tool_result content that exceeds MAX_TOOL_RESULT_CHARS
 */
function scrubContent(content: unknown): string {
  if (typeof content === "string") return content

  if (Array.isArray(content)) {
    const scrubbed = content.map((block) => {
      if (!block || typeof block !== "object") return block
      const b = block as Record<string, unknown>

      // Strip base64 image data from assistant image blocks
      if (b.type === "image" && b.source && typeof b.source === "object") {
        const src = b.source as Record<string, unknown>
        if (src.type === "base64") {
          return { type: "image", source: { type: "base64", media_type: src.media_type, data: "[base64 image omitted]" } }
        }
      }

      // Truncate large tool_result content
      if (b.type === "tool_result") {
        const c = b.content
        if (typeof c === "string" && c.length > MAX_TOOL_RESULT_CHARS) {
          return { ...b, content: c.slice(0, MAX_TOOL_RESULT_CHARS) + `… [truncated ${c.length - MAX_TOOL_RESULT_CHARS} chars]` }
        }
        if (Array.isArray(c)) {
          return {
            ...b,
            content: c.map((item) => {
              if (!item || typeof item !== "object") return item
              const it = item as Record<string, unknown>
              // Strip base64 inside tool results
              if (it.type === "image" && it.source && typeof it.source === "object") {
                const src = it.source as Record<string, unknown>
                return { type: "image", source: { type: "base64", media_type: src.media_type, data: "[base64 image omitted]" } }
              }
              if (it.type === "text" && typeof it.text === "string" && it.text.length > MAX_TOOL_RESULT_CHARS) {
                return { ...it, text: it.text.slice(0, MAX_TOOL_RESULT_CHARS) + `… [truncated]` }
              }
              return it
            }),
          }
        }
      }

      return b
    })
    return JSON.stringify(scrubbed)
  }

  return JSON.stringify(content)
}

/**
 * Truncate a serialised history array to fit within MAX_SUMMARY_CHARS.
 * Keeps the most recent messages; prepends a note if any were dropped.
 */
function truncateHistoryForSummary(
  history: Array<{ role: "user" | "assistant"; content: string }>
): Array<{ role: "user" | "assistant"; content: string }> {
  let totalChars = 0
  const kept: typeof history = []

  for (let i = history.length - 1; i >= 0; i--) {
    const chars = history[i].content.length
    if (totalChars + chars > MAX_SUMMARY_CHARS && kept.length > 0) break
    kept.unshift(history[i])
    totalChars += chars
  }

  if (kept.length < history.length) {
    const dropped = history.length - kept.length
    kept.unshift({
      role: "user",
      content: `[${dropped} earlier message(s) omitted — history truncated to fit context window]`,
    })
  }

  return kept
}

/**
 * Fire a background summary generation. Non-blocking — the summary is stored on
 * `session.compactionSummary` when ready and will be picked up on the next turn.
 * Node's event loop handles the concurrency; no threads needed.
 */
export function triggerBackgroundSummary(
  session: Session,
  anthropic: Anthropic,
  systemBlocks: Anthropic.TextBlockParam[]
): void {
  if (runningJobs.has(session.id)) return
  runningJobs.add(session.id)

  const rawHistory = (session.rawHistory ?? []).map((m) => ({
    role: m.role as "user" | "assistant",
    content: scrubContent(m.content),
  }))

  const history = truncateHistoryForSummary(rawHistory)

  if (history.length === 0) {
    runningJobs.delete(session.id)
    return
  }

  // Build the messages to send: existing history + summarisation instruction
  const summaryMessages: Anthropic.MessageParam[] = [
    ...history.map((m, i) => {
      const isLast = i === history.length - 1
      const contentBlock: Anthropic.TextBlockParam = {
        type: "text",
        text: m.content,
        ...(isLast ? { cache_control: { type: "ephemeral" } } : {}),
      }
      return { role: m.role, content: [contentBlock] } as Anthropic.MessageParam
    }),
    { role: "user", content: SESSION_MEMORY_PROMPT },
  ]

  // Run async without awaiting — fires and forgets into the event loop
  ;(async () => {
    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001", // cheap model for summarisation
        max_tokens: 3_000,
        system: systemBlocks,
        messages: summaryMessages,
      })
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
      session.compactionSummary = text
    } catch (err) {
      console.error("[compaction] background summary failed:", (err as Error).message)
    } finally {
      runningJobs.delete(session.id)
    }
  })()
}
