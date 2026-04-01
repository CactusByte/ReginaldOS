import { spawn, type ChildProcess } from "node:child_process"
import { cpSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createServer, type AddressInfo } from "node:net"

const ASTRO_BIN = join(process.cwd(), "node_modules", ".bin", "astro")
const TEMPLATE_DIR = join(process.cwd(), "src", "astro", "template")
const BACKOFF_CAP_MS = 30_000
const IDLE_TIMEOUT_MS = 30 * 60 * 1_000  // stop server after 30 min of no activity
const REAP_INTERVAL_MS = 5 * 60 * 1_000  // check every 5 min

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
    srv.on("error", reject)
  })
}

interface Entry {
  proc: ChildProcess | null
  port: number
  projectDir: string
  backoff: number
  lastActivity: number
  readyPromise: Promise<void>
  resolveReady: () => void
  rejectReady: (e: Error) => void
}

export class AstroManager {
  private entries = new Map<string, Entry>()

  constructor(private projectsDir: string) {
    mkdirSync(projectsDir, { recursive: true })
    const shutdown = () => this.killAll()
    process.once("SIGTERM", shutdown)
    process.once("SIGINT", shutdown)
    // Periodically stop servers that have been idle too long
    setInterval(() => this.reapIdle(), REAP_INTERVAL_MS).unref()
  }

  /** Starts (or returns existing) Astro dev server for a session. Resolves once ready. */
  async getOrStart(sessionId: string): Promise<{ port: number; projectDir: string }> {
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = await this.createEntry(sessionId)
      this.entries.set(sessionId, entry)
      this.launch(sessionId, entry)
    }
    entry.lastActivity = Date.now()
    await entry.readyPromise
    return { port: entry.port, projectDir: entry.projectDir }
  }

  /** Stop the Astro dev server for a session and remove it from the registry. */
  stop(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.entries.delete(sessionId) // remove first so the exit handler won't restart it
    try { entry.proc?.kill() } catch { /* ignore */ }
  }

  /** Returns the project directory path for a session (synchronous, no startup). */
  projectDir(sessionId: string): string {
    return join(this.projectsDir, sessionId)
  }

  private async createEntry(sessionId: string): Promise<Entry> {
    const port = await pickFreePort()
    const projectDir = join(this.projectsDir, sessionId)
    if (!existsSync(projectDir)) {
      cpSync(TEMPLATE_DIR, projectDir, { recursive: true })
    }
    const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } =
      Promise.withResolvers<void>()
    return { proc: null, port, projectDir, backoff: 1000, lastActivity: Date.now(), readyPromise, resolveReady, rejectReady }
  }

  private launch(sessionId: string, entry: Entry): void {
    const proc = spawn(
      ASTRO_BIN,
      ["dev", "--root", entry.projectDir, "--port", String(entry.port), "--host", "127.0.0.1"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } }
    )
    entry.proc = proc

    // Capture the resolve/reject at launch time so the exit handler can
    // reject the *current* promise even after entry fields are replaced.
    const { resolveReady, rejectReady } = entry

    const portStr = String(entry.port)
    const onOutput = (chunk: Buffer) => {
      const text = chunk.toString()
      // Astro 5 prints the bound address when ready, e.g.:
      //   ┃ Local    http://127.0.0.1:PORT/
      // Match on the port number since --host may print 127.0.0.1, not localhost.
      if (text.includes(portStr)) {
        resolveReady()
        proc.stdout?.off("data", onOutput)
        proc.stderr?.off("data", onOutput)
      }
    }
    proc.stdout?.on("data", onOutput)
    proc.stderr?.on("data", onOutput)
    proc.on("error", (err) => rejectReady(err))

    proc.on("exit", (code) => {
      // Always reject the current promise so any pending `await entry.readyPromise`
      // doesn't hang forever when Astro crashes before printing ready.
      if (code !== 0 && code !== null) {
        rejectReady(new Error(`Astro exited with code ${code}`))
      }

      if (this.entries.has(sessionId)) {
        // Prepare a fresh promise for the next launch attempt
        const { promise, resolve, reject } = Promise.withResolvers<void>()
        entry.readyPromise = promise
        entry.resolveReady = resolve
        entry.rejectReady = reject
        entry.backoff = Math.min(entry.backoff * 2, BACKOFF_CAP_MS)
        setTimeout(() => {
          if (this.entries.has(sessionId)) this.launch(sessionId, entry)
        }, entry.backoff)
      }
    })
  }

  private reapIdle(): void {
    const now = Date.now()
    for (const [sessionId, entry] of this.entries) {
      if (now - entry.lastActivity > IDLE_TIMEOUT_MS) {
        console.log(`[astro] stopping idle server for session ${sessionId}`)
        this.stop(sessionId)
      }
    }
  }

  private killAll(): void {
    for (const entry of this.entries.values()) {
      try { entry.proc?.kill() } catch { /* ignore */ }
    }
  }
}
