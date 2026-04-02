import { anthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import { config } from "../config.js"

/**
 * Parse a model string and return the appropriate AI SDK LanguageModel.
 *
 * Formats:
 *   "claude-opus-4-6"              → Anthropic  (no prefix = backward compat)
 *   "anthropic/claude-opus-4-6"   → Anthropic
 *   "openai/gpt-4o"               → OpenAI
 *   "openai/gpt-4o-mini"          → OpenAI
 *   "ollama/llama3.2"             → Ollama  (requires Ollama running locally)
 *   "ollama/mistral"              → Ollama
 */
export function getModel(modelString: string): LanguageModel {
  const slash = modelString.indexOf("/")
  if (slash === -1) {
    // No prefix — treat as Anthropic for backward compatibility
    return anthropic(modelString)
  }

  const provider = modelString.slice(0, slash)
  const modelId  = modelString.slice(slash + 1)

  switch (provider) {
    case "anthropic":
      return anthropic(modelId)

    case "openai": {
      const openai = createOpenAI({
        apiKey: config.openaiChatApiKey,
        ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
        compatibility: "compatible",
      })
      // Always use .chat() to force Chat Completions (/v1/chat/completions).
      // The Responses API (/v1/responses) has stricter schema validation and
      // doesn't accept tool schemas with type: null from MCP servers.
      return openai.chat(modelId)
    }

    case "ollama": {
      // Ollama only supports Chat Completions, not the Responses API
      // Use .chat() accessor to force OpenAIChatLanguageModel instead of OpenAIResponsesLanguageModel
      const ollama = createOpenAI({
        baseURL: config.ollamaBaseUrl.replace(/\/$/, "") + "/v1",
        apiKey: "ollama",
        compatibility: "compatible",
      })
      return ollama.chat(modelId)
    }

    default: {
      // Unknown prefix — assume OpenAI-compatible (Chat Completions)
      const custom = createOpenAI({
        apiKey: config.openaiChatApiKey,
        ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
        compatibility: "compatible",
      })
      return custom.chat(modelId)
    }
  }
}

export function isAnthropicModel(modelString: string): boolean {
  return !modelString.includes("/") || modelString.startsWith("anthropic/")
}
