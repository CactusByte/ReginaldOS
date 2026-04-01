import Database from "better-sqlite3"
import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgentLoop } from "../../agent/loop.js"
import type { SessionManager } from "../../sessions/manager.js"
import type { MemoryStore } from "../../memory/store.js"
import { config } from "../../config.js"

interface MessageRow {
  rowid:           number
  text:            string
  handle:          string
  service_name:    string
}

const QUERY = `
  SELECT
    m.ROWID       AS rowid,
    m.text,
    h.id          AS handle,
    c.service_name
  FROM message m
  JOIN handle h             ON m.handle_id   = h.ROWID
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c               ON c.ROWID        = cmj.chat_id
  WHERE m.is_from_me  = 0
    AND m.ROWID       > ?
    AND m.text IS NOT NULL
    AND m.text != ''
  ORDER BY m.ROWID ASC
`

export function startIMessageBot(sessions: SessionManager, memory: MemoryStore): void {
  if (!config.iMessageChatDb) return

  if (!existsSync(config.iMessageChatDb)) {
    console.log(`iMessage  →  disabled (chat.db not found at ${config.iMessageChatDb})`)
    return
  }

  let db: Database.Database
  try {
    db = new Database(config.iMessageChatDb, { readonly: true, fileMustExist: true })
  } catch (err) {
    console.error("[iMessage] Cannot open chat.db (check Full Disk Access):", err)
    return
  }

  const stmt = db.prepare<[number], MessageRow>(QUERY)

  // Start from the current max ROWID so we only reply to messages arriving after startup
  const lastRow = db.prepare("SELECT MAX(ROWID) AS maxid FROM message").get() as { maxid: number | null }
  let lastRowId = lastRow.maxid ?? 0

  console.log(`iMessage  →  polling ${config.iMessageChatDb} (last ROWID: ${lastRowId})`)

  const running = new Set<string>()

  setInterval(() => {
    let rows: MessageRow[]
    try {
      rows = stmt.all(lastRowId)
    } catch (err) {
      console.error("[iMessage] DB read error:", err)
      return
    }

    for (const row of rows) {
      lastRowId = Math.max(lastRowId, row.rowid)

      if (config.iMessageAllowFrom.length > 0 && !config.iMessageAllowFrom.includes(row.handle)) {
        continue
      }

      const sessionId = `imessage:${row.handle}`
      if (running.has(sessionId)) continue

      running.add(sessionId)
      const session = sessions.getOrCreate(sessionId)
      let fullResponse = ""

      runAgentLoop(session, row.text, memory, {
        onToken: (delta) => { fullResponse += delta },
        onDone:  () => sessions.save(session),
        onError: (err)  => { console.error("[iMessage] Agent error:", err) },
      })
        .then(() => {
          if (fullResponse.trim()) {
            sendIMessage(row.handle, row.service_name, fullResponse.trim())
          }
        })
        .catch((err) => console.error("[iMessage] Unexpected error:", err))
        .finally(() => running.delete(sessionId))
    }
  }, config.iMessagePollMs)
}

function sendIMessage(handle: string, serviceName: string, text: string): void {
  const safe    = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const isIMsg  = !serviceName.toLowerCase().includes("sms")
  const service = isIMsg
    ? `1st service whose service type = iMessage`
    : `service "SMS"`

  const script = `tell application "Messages"
  set theService to ${service}
  set theBuddy to buddy "${handle}" of theService
  send "${safe}" to theBuddy
end tell`

  const tmp = join(tmpdir(), `reginaldos-imsg-${Date.now()}.applescript`)
  try {
    writeFileSync(tmp, script, "utf8")
    execFileSync("osascript", [tmp])
  } catch (err) {
    console.error("[iMessage] Send failed:", err)
  } finally {
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}
