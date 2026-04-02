import type Anthropic from "@anthropic-ai/sdk"
import { jsonSchema } from "ai"
import type { MemoryStore } from "../../memory/store.js"
import { join } from "node:path"
import { config } from "../../config.js"
import { bash } from "./bash.js"
import { readFile } from "./readFile.js"
import { writeFile } from "./writeFile.js"
import { webFetch } from "./webFetch.js"
import { createMemoryTool } from "./memorySearch.js"
import { browserUse } from "./browser.js"
import { tavilySearch, tavilyExtract } from "./tavily.js"
import { pumpfun } from "./pumpfun.js"
import { rugcheck } from "./rugcheck.js"
import { imageGenerate } from "./imageGenerate.js"
import { xGetUser, xGetUserTweets, xFollowUser } from "./x.js"

// Extra dispatchers registered at startup (cron, skill_read, etc.)
type ExtraDispatcher = (
  name: string,
  input: Record<string, unknown>
) => Promise<DispatchResult | null> | DispatchResult | null

const extraDispatchers: ExtraDispatcher[] = []
const extraToolDefs: Anthropic.Tool[] = []

export function registerExtraTools(
  tools: Anthropic.Tool[],
  dispatcher: ExtraDispatcher
): void {
  extraToolDefs.push(...tools)
  extraDispatchers.push(dispatcher)
}

export const CORE_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "bash",
    description:
      "Execute a bash command in a shell. Returns stdout and stderr combined. Default timeout: 30s.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        timeout_ms: { type: "number", description: "Timeout in ms (default 30000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file at an absolute path.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates parent directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return the response body as text. Max 100 KB returned.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        headers: {
          type: "object",
          description: "Optional HTTP headers",
          additionalProperties: { type: "string" },
        },
      },
      required: ["url"],
    },
  },
  {
    name: "memory_search",
    description:
      "Search, insert, or delete long-term memories stored in SQLite. Use search before answering questions that may benefit from prior context.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "insert", "delete"] },
        query: { type: "string", description: "FTS5 search query (for action=search)" },
        content: { type: "string", description: "Fact to remember (for action=insert)" },
        tags: { type: "string", description: "Comma-separated tags (for action=insert)" },
        id: { type: "number", description: "Memory id to delete (for action=delete)" },
      },
      required: ["action"],
    },
  },
  {
    name: "tavily_search",
    description:
      "Fast web search across multiple sources. Use for research, news, market context, and any question answerable from the web. Much faster than navigating sites with browser_use.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Number of results to return (default 5, max 10)" },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "basic is faster; advanced is more thorough (default: basic)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "tavily_extract",
    description:
      "Extract clean text content from one or more URLs. Use for reading articles, news, and static pages. Faster and cheaper than browser_use for content that doesn't require JS interaction.",
    input_schema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "URLs to extract content from (max 5)",
        },
      },
      required: ["urls"],
    },
  },
  {
    name: "image_generate",
    description:
      "Generate an image using OpenAI. Returns the image as base64, a data URL, a local file path, and ready-to-use canvas HTML. Use the canvasHtml field with canvas_update to display it.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
          description: "Image dimensions. Default: 1024x1024",
        },
        filename: {
          type: "string",
          description: "Optional base filename without extension (e.g. 'my-token'). Defaults to a UUID.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "rugcheck",
    description:
      "Check if a Solana token is a rug pull using RugCheck.xyz. Returns risk score, danger flags, warnings, LP lock %, and top holder concentration. Use this before any buy recommendation.",
    input_schema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "Token mint address to analyse",
        },
        full: {
          type: "boolean",
          description: "Return the full raw report instead of the summary (default: false)",
        },
      },
      required: ["mint"],
    },
  },
  {
    name: "pumpfun",
    description:
      "Interact with Pump.fun on Solana. Buy tokens, sell tokens, create new tokens, or get price quotes from bonding curves. Requires SOLANA_RPC_URL and SOLANA_PRIVATE_KEY in environment. For buy/sell/create, always confirm with the user before executing.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["buy", "sell", "create", "quote", "price"],
          description: "Operation to perform",
        },
        mint: {
          type: "string",
          description: "Token mint address (required for buy, sell, quote)",
        },
        sol_amount: {
          type: "number",
          description: "SOL amount to spend (buy) or quote. In SOL, not lamports.",
        },
        token_amount: {
          type: "number",
          description: "Token amount to sell or quote (raw u64 units)",
        },
        slippage: {
          type: "number",
          description: "Slippage tolerance as decimal (0.05 = 5%). Default: 0.05",
        },
        name: {
          type: "string",
          description: "Token name (create only)",
        },
        symbol: {
          type: "string",
          description: "Token symbol/ticker (create only)",
        },
        uri: {
          type: "string",
          description: "Metadata URI — Arweave or IPFS URL to a JSON metadata file with image (create only)",
        },
        buy_sol: {
          type: "number",
          description: "Optional initial buy in SOL at token creation (create only)",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "x_get_user",
    description:
      "Look up an X (Twitter) user by username. Returns profile info including ID, name, bio, follower counts, and more.",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", description: "X username without the @ symbol" },
        user_fields: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of extra fields to include (e.g. location, url, verified)",
        },
      },
      required: ["username"],
    },
  },
  {
    name: "x_follow_user",
    description:
      "Follow an X (Twitter) user on behalf of the authenticated account. Requires X_OAUTH2_USER_TOKEN and X_USER_ID in env. Always confirm with the user before following.",
    input_schema: {
      type: "object",
      properties: {
        source_user_id: {
          type: "string",
          description: "Numeric ID of the authenticated user doing the following. Use X_USER_ID from env or x_get_user to look it up.",
        },
        target_user_id: {
          type: "string",
          description: "Numeric ID of the user to follow.",
        },
      },
      required: ["source_user_id", "target_user_id"],
    },
  },
  {
    name: "x_get_user_tweets",
    description:
      "Retrieve recent posts from an X (Twitter) user by their numeric user ID. Use x_get_user first to look up the ID from a username.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Numeric X user ID (e.g. '2244994945')" },
        max_results: { type: "number", description: "Number of tweets to return (5–100, default 10)" },
        exclude: {
          type: "array",
          items: { type: "string", enum: ["replies", "retweets"] },
          description: "Types of tweets to exclude",
        },
        since_id: { type: "string", description: "Only return tweets newer than this tweet ID" },
        until_id: { type: "string", description: "Only return tweets older than this tweet ID" },
        tweet_fields: {
          type: "array",
          items: { type: "string" },
          description: "Extra tweet fields to include (e.g. public_metrics, created_at)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "project_info",
    description:
      "Returns the Astro project directory paths for this session. Call this before writing any website files to know exactly where to put them.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "browser_use",
    description:
      "Control a Chromium browser. Use screenshot to see the page visually. The browser persists across calls (cookies, sessions, tabs). Use this for any task requiring real browser interaction: logging in, clicking, filling forms, scraping JS-rendered content, etc.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "navigate",
            "screenshot",
            "click",
            "type",
            "fill",
            "select",
            "hover",
            "scroll",
            "press",
            "wait_for",
            "evaluate",
            "get_text",
            "get_html",
            "go_back",
            "go_forward",
            "new_page",
            "close_page",
            "list_pages",
            "switch_page",
            "close_browser",
          ],
          description: "Action to perform",
        },
        url: { type: "string", description: "URL to navigate to (navigate, new_page)" },
        selector: {
          type: "string",
          description: "CSS selector or text selector (e.g. 'text=Submit') for the target element",
        },
        text: { type: "string", description: "Text to type or wait for (type, wait_for)" },
        value: { type: "string", description: "Value to fill or select (fill, select)" },
        key: {
          type: "string",
          description: "Key to press, e.g. 'Enter', 'Tab', 'Control+a' (press)",
        },
        script: { type: "string", description: "JavaScript expression to evaluate in page context (evaluate)" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (click)" },
        double: { type: "boolean", description: "Double-click (click)" },
        delay: { type: "number", description: "Delay between keystrokes in ms (type)" },
        x: { type: "number", description: "Horizontal scroll delta (scroll)" },
        y: { type: "number", description: "Vertical scroll delta (scroll)" },
        full_page: { type: "boolean", description: "Capture full scrollable page (screenshot)" },
        outer: { type: "boolean", description: "Return outerHTML instead of innerHTML (get_html)" },
        state: {
          type: "string",
          enum: ["visible", "hidden", "attached", "detached"],
          description: "Element state to wait for (wait_for)",
        },
        timeout: { type: "number", description: "Timeout in ms (wait_for)" },
        wait_until: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
          description: "Navigation wait condition (navigate)",
        },
        page: {
          type: "string",
          description: "Page id to target (default: active page). See list_pages.",
        },
      },
      required: ["action"],
    },
  },
]

/** All tool definitions — core + any registered extras. Used to build the API call. */
export function getAllToolDefinitions(): Anthropic.Tool[] {
  return [...CORE_TOOL_DEFINITIONS, ...extraToolDefs]
}

/**
 * Build tools in Vercel AI SDK format, with execute functions wired to the
 * existing dispatcher. Used by loop.ts when running with any provider.
 */
export function buildAiSdkTools(
  memory: MemoryStore,
  sessionId: string,
  onImage?: (path: string) => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  const dispatch = createDispatcher(memory, sessionId, onImage)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {}

  for (const def of getAllToolDefinitions()) {
    const name = def.name
    const rawSchema = def.input_schema as Record<string, unknown>
    // Ensure type is always "object" — MCP servers (especially Python-based) may send type: null
    if (rawSchema.type !== "object") {
      rawSchema.type = "object"
    }
    tools[name] = {
      description: def.description ?? "",
      // AI SDK v6 reads tool.inputSchema internally (not tool.parameters).
      // Passing a Schema object (from jsonSchema()) ensures asSchema() detects
      // it as a Schema via Symbol and uses .jsonSchema directly.
      inputSchema: jsonSchema(rawSchema),
      execute: async (input: Record<string, unknown>) => {
        const { content, isError } = await dispatch(name, input)
        // Return rich content as text; keep Error: prefix so callers can detect failures
        if (typeof content !== "string") return JSON.stringify(content)
        return isError ? `Error: ${content}` : content
      },
    }
  }

  return tools
}

// Keep TOOL_DEFINITIONS as an alias for backwards compat within this file
const TOOL_DEFINITIONS = CORE_TOOL_DEFINITIONS

type RichContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png"; data: string } }
    >

export interface DispatchResult {
  content: RichContent
  isError: boolean
}

export function createDispatcher(memory: MemoryStore, sessionId: string, onImage?: (path: string) => void) {
  const memoryTool = createMemoryTool(memory, sessionId)

  return async function dispatch(
    name: string,
    input: Record<string, unknown>
  ): Promise<DispatchResult> {
    try {
      switch (name) {
        case "bash": {
          const result = await bash(input as Parameters<typeof bash>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "read_file": {
          const result = readFile(input as Parameters<typeof readFile>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "write_file": {
          const result = writeFile(input as Parameters<typeof writeFile>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "web_fetch": {
          const result = await webFetch(input as Parameters<typeof webFetch>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "memory_search": {
          const result = await memoryTool(input as Parameters<typeof memoryTool>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "tavily_search": {
          const result = await tavilySearch(input as Parameters<typeof tavilySearch>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "tavily_extract": {
          const result = await tavilyExtract(input as Parameters<typeof tavilyExtract>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "image_generate": {
          const result = await imageGenerate(
            input as Parameters<typeof imageGenerate>[0],
            onImage
          )
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "rugcheck": {
          const result = await rugcheck(input as Parameters<typeof rugcheck>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "pumpfun": {
          const result = await pumpfun(input as Parameters<typeof pumpfun>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "x_follow_user": {
          const result = await xFollowUser(input as Parameters<typeof xFollowUser>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "x_get_user": {
          const result = await xGetUser(input as Parameters<typeof xGetUser>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "x_get_user_tweets": {
          const result = await xGetUserTweets(input as Parameters<typeof xGetUserTweets>[0])
          return { content: result, isError: result.startsWith("Error:") }
        }
        case "project_info": {
          const dir = join(config.projectsDir, sessionId)
          const info = {
            projectDir: dir,
            pagesDir: join(dir, "src", "pages"),
            layoutsDir: join(dir, "src", "layouts"),
            componentsDir: join(dir, "src", "components"),
            publicDir: join(dir, "public"),
          }
          return { content: JSON.stringify(info, null, 2), isError: false }
        }
        case "browser_use": {
          const br = await browserUse(input)
          if (br.kind === "screenshot") {
            return {
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: br.base64 },
                },
                { type: "text", text: br.caption },
              ],
              isError: false,
            }
          }
          return { content: br.text, isError: br.text.startsWith("Error:") }
        }
        default: {
          // Try registered extra dispatchers (cron, skill_read, etc.)
          for (const extra of extraDispatchers) {
            const result = await extra(name, input)
            if (result !== null) return result
          }
          return { content: `Error: unknown tool "${name}"`, isError: true }
        }
      }
    } catch (err: unknown) {
      return { content: `Error: ${(err as Error).message}`, isError: true }
    }
  }
}
