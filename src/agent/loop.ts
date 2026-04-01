import Anthropic from "@anthropic-ai/sdk"
import { config } from "../config.js"
import { getSystemPrompt } from "./systemPrompt.js"
import { getAllToolDefinitions, createDispatcher } from "./tools/index.js"
import type { MemoryStore } from "../memory/store.js"
import type { Session } from "../sessions/types.js"
import {
  HARD_TOKEN_LIMIT,
  applyCompaction,
  shouldInitSummary,
  shouldUpdateSummary,
  triggerBackgroundSummary,
} from "./compaction.js"

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })

const MAX_TURNS = 20
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 2000

export interface LoopCallbacks {
  onToken: (delta: string) => void
  onToolStart?: (toolCallId: string, name: string, input: unknown) => void
  onToolEnd?: (toolCallId: string, name: string, result: string, isError: boolean) => void
  onRetry?: (attempt: number) => void
  onCompaction?: () => void
  onDone?: () => void
  onError?: (err: Error) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isOverloadedError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) return err.status === 529
  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message)
      return parsed?.error?.type === "overloaded_error"
    } catch { /* not JSON */ }
  }
  return false
}

function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  try {
    const parsed = JSON.parse(err.message)
    if (parsed?.error?.message) return parsed.error.message
  } catch { /* not JSON */ }
  return err.message
}

/**
 * Mark the last message's last content block with cache_control so the growing
 * conversation history is incrementally cached on each turn.
 */
function markLastForCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages
  const last = messages[messages.length - 1]
  const cc: Anthropic.CacheControlEphemeral = { type: "ephemeral" }

  let newContent: Anthropic.MessageParam["content"]
  if (typeof last.content === "string") {
    newContent = [{ type: "text", text: last.content, cache_control: cc }]
  } else {
    const blocks = last.content as unknown as Array<Record<string, unknown>>
    newContent = [
      ...blocks.slice(0, -1),
      { ...blocks[blocks.length - 1], cache_control: cc },
    ] as unknown as Anthropic.MessageParam["content"]
  }
  return [...messages.slice(0, -1), { ...last, content: newContent }]
}

// System prompt + tools are built once via initLoop() before any requests are served.
// They stay byte-identical across requests to maximise prompt cache hits.
let SYSTEM_BLOCKS: Anthropic.TextBlockParam[] = [
  { type: "text", text: getSystemPrompt(), cache_control: { type: "ephemeral" } },
]
let TOOLS_WITH_CACHE: Anthropic.Tool[] = []

/**
 * Call once at startup (after registering extra tools and loading skills) to
 * freeze the system prompt and tool list for the lifetime of the process.
 */
export function initLoop(skillsXml?: string): void {
  SYSTEM_BLOCKS = [
    { type: "text", text: getSystemPrompt(skillsXml), cache_control: { type: "ephemeral" } },
  ]
  const defs = getAllToolDefinitions()
  TOOLS_WITH_CACHE = defs.map((tool, i) =>
    i === defs.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" } }
      : tool
  )
}

export async function runAgentLoop(
  session: Session,
  userText: string,
  memory: MemoryStore,
  callbacks: LoopCallbacks
): Promise<void> {
  const dispatch = createDispatcher(memory, session.id)

  // ── Instant compaction: if the context is full, swap in the pre-built summary ──
  if ((session.tokenCount ?? 0) >= HARD_TOKEN_LIMIT) {
    applyCompaction(session)
    callbacks.onCompaction?.()
  }

  let initialMessages: Anthropic.MessageParam[] = session.rawHistory
    ? (session.rawHistory as Anthropic.MessageParam[])
    : session.messages.map((m) => ({ role: m.role, content: m.content }))

  // Guard: if history starts with a tool_result user message (can happen after a
  // crash or bad truncation), drop leading messages until we reach clean text.
  while (initialMessages.length > 0) {
    const first = initialMessages[0]
    const content = first.content
    const startsWithToolResult =
      Array.isArray(content) &&
      (content as Array<{ type?: string }>)[0]?.type === "tool_result"
    if (!startsWithToolResult) break
    initialMessages = initialMessages.slice(1)
  }

  const messages: Anthropic.MessageParam[] = [
    ...initialMessages,
    { role: "user", content: userText },
  ]

  let accumulatedText = ""
  let lastTokenCount = session.tokenCount ?? 0
  let turns = 0

  try {
    while (turns < MAX_TURNS) {
      turns++

      // ── Stream with retry on overloaded ──────────────────────────────────────
      let response: Anthropic.Message | undefined
      const textBeforeTurn = accumulatedText

      for (let attempt = 0; ; attempt++) {
        try {
          const stream = anthropic.messages.stream({
            model: config.model,
            max_tokens: 8096,
            system: SYSTEM_BLOCKS,
            tools: TOOLS_WITH_CACHE,
            messages: markLastForCache(messages),
          })

          for await (const event of stream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              accumulatedText += event.delta.text
              callbacks.onToken(event.delta.text)
            }
          }

          response = await stream.finalMessage()
          break // success
        } catch (err) {
          if (attempt < MAX_RETRIES && isOverloadedError(err)) {
            accumulatedText = textBeforeTurn
            callbacks.onRetry?.(attempt + 1)
            await sleep(RETRY_DELAY_MS * (attempt + 1))
            continue
          }
          throw err
        }
      }

      // Track token usage for compaction decisions
      const cacheRead = (response!.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0
      lastTokenCount =
        response!.usage.input_tokens + cacheRead + response!.usage.output_tokens

      messages.push({ role: "assistant", content: response!.content })

      if (response!.stop_reason === "end_turn") break

      if (response!.stop_reason === "tool_use") {
        const toolUseBlocks = response!.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        )

        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const tu of toolUseBlocks) {
          callbacks.onToolStart?.(tu.id, tu.name, tu.input)
          const { content, isError } = await dispatch(
            tu.name,
            tu.input as Record<string, unknown>
          )
          const resultText = typeof content === "string" ? content : "[rich content]"
          callbacks.onToolEnd?.(tu.id, tu.name, resultText, isError)
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: content as Anthropic.ToolResultBlockParam["content"],
            is_error: isError,
          })
        }

        messages.push({ role: "user", content: toolResults })
        continue
      }

      break
    }

    // ── Persist the exchange ──────────────────────────────────────────────────
    session.messages.push({
      role: "user",
      content: userText,
      timestamp: new Date().toISOString(),
    })
    if (accumulatedText) {
      session.messages.push({
        role: "assistant",
        content: accumulatedText,
        timestamp: new Date().toISOString(),
      })
    }

    session.rawHistory = messages as Array<{ role: "user" | "assistant"; content: unknown }>
    session.tokenCount = lastTokenCount

    // ── Proactive background compaction ──────────────────────────────────────
    // Fire-and-forget: generates a summary in the background so the next
    // compaction (when hard limit is hit) is instant.
    if (shouldInitSummary(session) || shouldUpdateSummary(session)) {
      triggerBackgroundSummary(session, anthropic, SYSTEM_BLOCKS)
    }

    callbacks.onDone?.()
  } catch (err: unknown) {
    callbacks.onError?.(new Error(extractErrorMessage(err)))
  }
}
