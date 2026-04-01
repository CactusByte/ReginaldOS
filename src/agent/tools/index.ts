import type Anthropic from "@anthropic-ai/sdk"
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

export function createDispatcher(memory: MemoryStore, sessionId: string) {
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
