import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Session } from "./types.js"

const HISTORY_LIMIT = 60

export class SessionManager {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private safeName(id: string): string {
    // Colons and dots are fine on Linux/macOS; replace anything else unsafe
    return id.replace(/[^a-zA-Z0-9_\-.:/]/g, "_")
  }

  private path(id: string): string {
    return join(this.dir, `${this.safeName(id)}.json`)
  }

  getOrCreate(id: string): Session {
    const p = this.path(id)
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")) as Session
    }
    return {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    }
  }

  save(session: Session): void {
    session.updatedAt = new Date().toISOString()
    if (session.messages.length > HISTORY_LIMIT) {
      session.messages = session.messages.slice(-HISTORY_LIMIT)
    }
    writeFileSync(this.path(session.id), JSON.stringify(session, null, 2))
  }
}
