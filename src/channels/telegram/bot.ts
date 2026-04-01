import { Bot, InputFile } from "grammy"
import { createReadStream } from "node:fs"
import { runAgentLoop } from "../../agent/loop.js"
import type { SessionManager } from "../../sessions/manager.js"
import type { MemoryStore } from "../../memory/store.js"
import { config } from "../../config.js"

export function startTelegramBot(sessions: SessionManager, memory: MemoryStore): void {
  if (!config.telegramBotToken) return

  const bot = new Bot(config.telegramBotToken)
  const running = new Set<string>()

  bot.on("message:text", async (ctx) => {
    const chatId   = String(ctx.chat.id)
    const username = ctx.from?.username ?? ""

    // Allowlist check
    if (config.telegramAllowFrom.length > 0 && !config.telegramAllowFrom.includes(username)) {
      await ctx.reply("Not authorized.")
      return
    }

    const sessionId = `telegram:${chatId}`

    if (running.has(sessionId)) {
      await ctx.reply("Still working on your last message — please wait.")
      return
    }

    running.add(sessionId)
    const session = sessions.getOrCreate(sessionId)
    let fullResponse = ""

    try {
      await runAgentLoop(session, ctx.message.text, memory, {
        onToken: (delta) => { fullResponse += delta },
        onDone: () => sessions.save(session),
        onError: async (err) => {
          await ctx.reply(`Error: ${err.message}`)
        },
        onImage: async (path) => {
          try {
            await bot.api.sendPhoto(chatId, new InputFile(createReadStream(path)))
          } catch (err) {
            console.error("[Telegram] Failed to send photo:", err)
          }
        },
      })

      if (fullResponse.trim()) {
        for (const chunk of chunkText(fullResponse.trim(), 4096)) {
          // Try Markdown first; fall back to plain text if parse fails
          await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => ctx.reply(chunk))
        }
      }
    } finally {
      running.delete(sessionId)
    }
  })

  bot.catch((err) => console.error("[Telegram]", err))
  bot.start()
  console.log("Telegram  →  bot running (long-poll)")
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}
