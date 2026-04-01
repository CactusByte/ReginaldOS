import { writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export function writeFile(input: {
  path: string
  content: string
  encoding?: string
}): string {
  try {
    mkdirSync(dirname(input.path), { recursive: true })
    const enc: BufferEncoding = input.encoding === "base64" ? "base64" : "utf-8"
    writeFileSync(input.path, input.content, enc)
    return `Written ${input.content.length} chars to ${input.path}`
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`
  }
}
