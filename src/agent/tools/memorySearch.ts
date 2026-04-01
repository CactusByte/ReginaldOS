import type { MemoryStore } from "../../memory/store.js"

export function createMemoryTool(memory: MemoryStore, sessionId: string) {
  return async function memorySearch(input: {
    action: "search" | "insert" | "delete"
    query?: string
    content?: string
    id?: number
    tags?: string
  }): Promise<string> {
    switch (input.action) {
      case "search": {
        if (!input.query) return "Error: query required for search"
        const rows = memory.search(input.query)
        if (!rows.length) return "No memories found."
        return rows
          .map((r) => `[id:${r.id}] (${r.created_at}) ${r.content}`)
          .join("\n")
      }
      case "insert": {
        if (!input.content) return "Error: content required for insert"
        const id = memory.insert(sessionId, input.content, input.tags)
        return `Stored memory id:${id}`
      }
      case "delete": {
        if (input.id == null) return "Error: id required for delete"
        memory.delete(input.id)
        return `Deleted memory id:${input.id}`
      }
      default:
        return "Error: unknown action"
    }
  }
}
