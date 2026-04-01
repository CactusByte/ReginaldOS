import { execFileSync } from "node:child_process"
import { writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { config } from "../config.js"

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

export class Delivery {
  async sendTelegram(chatId: string, text: string): Promise<void> {
    if (!config.telegramBotToken) {
      console.warn("[Delivery] Telegram not configured — cannot deliver cron output")
      return
    }
    for (const chunk of chunkText(text, 4096)) {
      const res = await fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        }
      )
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        throw new Error(`Telegram API error ${res.status}: ${body}`)
      }
    }
  }

  sendIMessage(handle: string, serviceName: string, text: string): void {
    const safe = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    const isIMsg = !serviceName.toLowerCase().includes("sms")
    const service = isIMsg
      ? `1st service whose service type = iMessage`
      : `service "SMS"`

    const script = `tell application "Messages"
  set theService to ${service}
  set theBuddy to buddy "${handle}" of theService
  send "${safe}" to theBuddy
end tell`

    const tmp = join(tmpdir(), `reginaldos-cron-${Date.now()}.applescript`)
    try {
      writeFileSync(tmp, script, "utf8")
      execFileSync("osascript", [tmp])
    } catch (err) {
      console.error("[Delivery] iMessage send failed:", err)
    } finally {
      try { unlinkSync(tmp) } catch { /* ignore */ }
    }
  }
}
