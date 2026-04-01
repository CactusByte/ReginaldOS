import { readFileSync, existsSync } from "node:fs"

export function readFile(input: { path: string; encoding?: string }): string {
  if (!existsSync(input.path)) return `Error: file not found: ${input.path}`
  try {
    const enc: BufferEncoding = input.encoding === "base64" ? "base64" : "utf-8"
    return readFileSync(input.path, enc)
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`
  }
}
