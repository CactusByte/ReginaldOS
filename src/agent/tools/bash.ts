import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

export async function bash(input: {
  command: string
  timeout_ms?: number
}): Promise<string> {
  const timeout = input.timeout_ms ?? 30_000
  try {
    const { stdout, stderr } = await execAsync(input.command, {
      timeout,
      maxBuffer: 5 * 1024 * 1024, // 5 MB
    })
    const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
    return out || "(no output)"
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number }
    if (e.code === "ETIMEDOUT") return `Error: command timed out after ${timeout}ms`
    return `Error (exit ${e.code ?? "?"}): ${e.stderr?.trim() || (e as Error).message}`
  }
}
