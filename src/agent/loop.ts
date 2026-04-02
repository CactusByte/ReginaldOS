import Anthropic from "@anthropic-ai/sdk"
import { streamText, stepCountIs } from "ai"
import type { ModelMessage } from "ai"
import { config } from "../config.js"
import { getSystemPrompt } from "./systemPrompt.js"
import { buildAiSdkTools } from "./tools/index.js"
import { getModel, isAnthropicModel } from "./provider.js"
import type { MemoryStore } from "../memory/store.js"
import type { Session } from "../sessions/types.js"
import {
  HARD_TOKEN_LIMIT,
  applyCompaction,
  shouldInitSummary,
  shouldUpdateSummary,
  triggerBackgroundSummary,
} from "./compaction.js"

// Anthropic client kept solely for background compaction on Anthropic models (optional)
const anthropic = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null

const MAX_STEPS = 50

export interface LoopCallbacks {
  onToken: (delta: string) => void
  onToolStart?: (toolCallId: string, name: string, input: unknown) => void
  onToolEnd?: (toolCallId: string, name: string, result: string, isError: boolean) => void
  onRetry?: (attempt: number) => void
  onCompaction?: () => void
  onDone?: () => void
  onError?: (err: Error) => void
  /** Called when a tool generates an image file on disk. Path is absolute. */
  onImage?: (path: string) => void
}

let SYSTEM_PROMPT = getSystemPrompt()
// Kept for Anthropic-only background compaction
let SYSTEM_BLOCKS: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
]

/** Call once at startup after registering extra tools and loading skills. */
export function initLoop(skillsXml?: string): void {
  SYSTEM_PROMPT = getSystemPrompt(skillsXml)
  SYSTEM_BLOCKS = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]
}

/**
 * Load session history as ModelMessage[], falling back to plain text messages
 * when the stored rawHistory is in the old Anthropic tool-block format.
 */
function toModelMessages(session: Session): ModelMessage[] {
  if (!session.rawHistory || session.rawHistory.length === 0) {
    return session.messages.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }))
  }

  // Detect old Anthropic tool format (tool_use / tool_result content blocks)
  const hasLegacyToolBlocks = (session.rawHistory as unknown[]).some(msg => {
    const m = msg as { content?: unknown }
    return Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some(b => b.type === "tool_use" || b.type === "tool_result")
  })

  if (hasLegacyToolBlocks) {
    // Can't reuse old Anthropic tool history in AI SDK format — rebuild from text
    return session.messages.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }))
  }

  return session.rawHistory as ModelMessage[]
}

export async function runAgentLoop(
  session: Session,
  userText: string,
  memory: MemoryStore,
  callbacks: LoopCallbacks
): Promise<void> {
  // ── Compaction / truncation ───────────────────────────────────────────────
  if (isAnthropicModel(config.model)) {
    if (anthropic && (session.tokenCount ?? 0) >= HARD_TOKEN_LIMIT) {
      applyCompaction(session)
      callbacks.onCompaction?.()
    }
  } else {
    // Non-Anthropic models: sliding window to stay within context limits.
    // Always truncate to a clean boundary (start of a user turn) so we never
    // send an orphaned tool-result message without its preceding tool_calls.
    const MAX_NON_ANTHROPIC_HISTORY = 30
    if (session.rawHistory && session.rawHistory.length > MAX_NON_ANTHROPIC_HISTORY) {
      const sliced = session.rawHistory.slice(-MAX_NON_ANTHROPIC_HISTORY)
      // Walk forward until we find a user message to avoid starting mid-tool-call
      const firstUserIdx = sliced.findIndex((m) => (m as { role: string }).role === "user")
      session.rawHistory = firstUserIdx > 0 ? sliced.slice(firstUserIdx) : sliced
    } else if (!session.rawHistory && session.messages.length > MAX_NON_ANTHROPIC_HISTORY) {
      session.messages = session.messages.slice(-MAX_NON_ANTHROPIC_HISTORY)
    }
  }

  const history = toModelMessages(session)
  const messages: ModelMessage[] = [...history, { role: "user", content: userText }]

  let accumulatedText = ""

  try {
    const result = streamText({
      model: getModel(config.model),
      system: SYSTEM_PROMPT,
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: buildAiSdkTools(memory, session.id, callbacks.onImage) as any,
      stopWhen: stepCountIs(MAX_STEPS),
    })

    for await (const chunk of result.fullStream) {
      switch (chunk.type) {

        case "text-delta":
          accumulatedText += chunk.text
          callbacks.onToken(chunk.text)
          break

        case "tool-call": {
          // Cast to avoid complex union narrowing — fields are always present
          const tc = chunk as unknown as { toolCallId: string; toolName: string; input: unknown }
          callbacks.onToolStart?.(tc.toolCallId, tc.toolName, tc.input)
          break
        }

        case "tool-result": {
          const tr = chunk as unknown as { toolCallId: string; toolName: string; output: unknown }
          const text = typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output)
          callbacks.onToolEnd?.(tr.toolCallId, tr.toolName, text, text.startsWith("Error:"))
          break
        }

        case "tool-error": {
          const te = chunk as unknown as { toolCallId: string; toolName: string; error: unknown }
          const msg = te.error instanceof Error ? te.error.message : String(te.error)
          callbacks.onToolEnd?.(te.toolCallId, te.toolName, msg, true)
          break
        }
      }
    }

    // ── Persist ───────────────────────────────────────────────────────────────
    const { messages: responseMessages } = await result.response

    session.messages.push({ role: "user", content: userText, timestamp: new Date().toISOString() })
    if (accumulatedText) {
      session.messages.push({ role: "assistant", content: accumulatedText, timestamp: new Date().toISOString() })
    }
    session.rawHistory = [...messages, ...responseMessages] as Session["rawHistory"]

    // Track token count (Anthropic returns accurate values; other providers may return 0)
    const usage = await result.usage
    session.tokenCount = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)

    // ── Background compaction (Anthropic only) ────────────────────────────────
    if (anthropic && isAnthropicModel(config.model)) {
      if (shouldInitSummary(session) || shouldUpdateSummary(session)) {
        triggerBackgroundSummary(session, anthropic, SYSTEM_BLOCKS)
      }
    }

    callbacks.onDone?.()
  } catch (err: unknown) {
    callbacks.onError?.(new Error(err instanceof Error ? err.message : String(err)))
  }
}
