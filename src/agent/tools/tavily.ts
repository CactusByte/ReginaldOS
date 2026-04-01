import { config } from "../../config.js"

const BASE = "https://api.tavily.com"
const TIMEOUT_MS = 20_000

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: config.tavilyApiKey, ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Tavily ${res.status}: ${text}`)
  }
  return res.json()
}

export async function tavilySearch(input: {
  query: string
  max_results?: number
  search_depth?: "basic" | "advanced"
}): Promise<string> {
  try {
    const data = await post("/search", {
      query: input.query,
      max_results: input.max_results ?? 5,
      search_depth: input.search_depth ?? "basic",
      include_answer: true,
    }) as {
      answer?: string
      results: Array<{ title: string; url: string; content: string; score: number }>
    }

    const lines: string[] = []
    if (data.answer) lines.push(`Answer: ${data.answer}\n`)
    for (const r of data.results) {
      lines.push(`[${r.title}](${r.url})\n${r.content}`)
    }
    return lines.join("\n\n")
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`
  }
}

export async function tavilyExtract(input: {
  urls: string[]
}): Promise<string> {
  try {
    const data = await post("/extract", {
      urls: input.urls.slice(0, 5), // API max
    }) as {
      results: Array<{ url: string; raw_content: string }>
      failed_results: Array<{ url: string; error: string }>
    }

    const lines: string[] = []
    for (const r of data.results) {
      const content = r.raw_content.length > 8000
        ? r.raw_content.slice(0, 8000) + "\n...[truncated]"
        : r.raw_content
      lines.push(`## ${r.url}\n${content}`)
    }
    for (const f of data.failed_results ?? []) {
      lines.push(`## ${f.url}\nError: ${f.error}`)
    }
    return lines.join("\n\n---\n\n")
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`
  }
}
