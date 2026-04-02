import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { registerExtraTools, type DispatchResult } from "../agent/tools/index.js"
import type Anthropic from "@anthropic-ai/sdk"

export interface StdioServerConfig {
  type: "stdio"
  name?: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface SseServerConfig {
  type: "sse"
  name?: string
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = StdioServerConfig | SseServerConfig

export async function connectMcpServers(servers: McpServerConfig[]): Promise<void> {
  for (const serverConfig of servers) {
    const label =
      serverConfig.name ??
      (serverConfig.type === "stdio" ? serverConfig.command : serverConfig.url)

    try {
      const client = new Client({ name: "reginaldos", version: "0.1.0" })

      let transport: StdioClientTransport | SSEClientTransport
      if (serverConfig.type === "stdio") {
        transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args ?? [],
          env: serverConfig.env,
        })
      } else {
        transport = new SSEClientTransport(new URL(serverConfig.url))
      }

      await client.connect(transport)
      const { tools } = await client.listTools()

      if (tools.length === 0) {
        console.log(`MCP (${label}): connected but no tools found`)
        continue
      }

      // Prefix every tool name with "{label}__" to avoid collisions with core tools
      // e.g. filesystem's "read_file" becomes "filesystem__read_file"
      const prefix = label.replace(/[^a-zA-Z0-9]/g, "_") + "__"

      const toolDefs: Anthropic.Tool[] = tools.map((tool) => ({
        name: prefix + tool.name,
        description: tool.description ?? "",
        input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
      }))

      // Dispatch lookup uses the prefixed names; strip prefix before calling the server
      const ownedNames = new Set(toolDefs.map((t) => t.name))

      registerExtraTools(toolDefs, async (name, input) => {
        if (!ownedNames.has(name)) return null
        const originalName = name.slice(prefix.length)
        const result = await client.callTool({ name: originalName, arguments: input })
        const content = result.content as Array<{ type: string; text?: string }>
        const text = content
          .map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
          .join("\n")
        return { content: text, isError: result.isError === true } satisfies DispatchResult
      })

      console.log(
        `MCP (${label}): registered ${tools.length} tool(s) — ${toolDefs.map((t) => t.name).join(", ")}`
      )
    } catch (err) {
      console.error(`MCP (${label}): failed to connect —`, (err as Error).message)
    }
  }
}
