import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { config } from "../../config.js"

const IMAGES_DIR = join(config.dataDir, "images")

export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536" | "auto"

export interface ImageGenerateInput {
  prompt: string
  size?: ImageSize
  filename?: string   // optional base name (no extension)
}

export interface GeneratedImage {
  path: string        // absolute path on disk
  filename: string    // e.g. "my-token.png"
  url: string         // relative URL served by gateway: /images/filename.png
  canvasHtml: string  // ready-to-use <img> tag
}

export async function imageGenerate(
  input: ImageGenerateInput,
  onImage?: (path: string) => void
): Promise<string> {
  const apiKey = config.openaiApiKey
  if (!apiKey) return "Error: OPENAI_API_KEY is not set in environment"

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.imageModel,
      prompt: input.prompt,
      n: 1,
      size: input.size ?? "1024x1024",
      output_format: "png",
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    return `Error: OpenAI API ${res.status}: ${body}`
  }

  const data = await res.json() as {
    data: Array<{ b64_json?: string; url?: string }>
  }

  const item = data.data?.[0]
  if (!item) return "Error: No image returned from OpenAI"

  let base64: string

  if (item.b64_json) {
    base64 = item.b64_json
  } else if (item.url) {
    // Fetch the URL and convert to base64
    const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(30_000) })
    const buf = await imgRes.arrayBuffer()
    base64 = Buffer.from(buf).toString("base64")
  } else {
    return "Error: OpenAI returned neither b64_json nor url"
  }

  // Save to disk
  mkdirSync(IMAGES_DIR, { recursive: true })
  const filename = `${input.filename ?? randomUUID()}.png`
  const path = join(IMAGES_DIR, filename)
  writeFileSync(path, Buffer.from(base64, "base64"))

  // Notify channels (e.g. Telegram + canvas) — they get the file path directly
  onImage?.(path)

  // Return only metadata to Claude — never the raw base64 (it bloats session history)
  const url = `/images/${encodeURIComponent(filename)}`
  return JSON.stringify({
    path,
    filename,
    url,
    canvasHtml: `<img src="${url}" style="max-width:100%;border-radius:8px;" alt="${input.prompt}" />`,
  })
}
