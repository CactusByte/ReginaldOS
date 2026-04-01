const MAX_BYTES = 100 * 1024 // 100 KB

export async function webFetch(input: {
  url: string
  headers?: Record<string, string>
}): Promise<string> {
  try {
    const res = await fetch(input.url, {
      headers: { "User-Agent": "ReginaldOS/0.1", ...(input.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    if (text.length > MAX_BYTES) {
      return text.slice(0, MAX_BYTES) + `\n...[truncated at ${MAX_BYTES} bytes]`
    }
    return text
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`
  }
}
