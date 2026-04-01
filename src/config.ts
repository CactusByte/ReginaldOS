import dotenv from "dotenv"
dotenv.config()

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback
}

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  model: optional("MODEL", "claude-opus-4-6"),
  telegramBotToken: optional("TELEGRAM_BOT_TOKEN", ""),
  telegramAllowFrom: (process.env.TELEGRAM_ALLOW_FROM || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  port: parseInt(optional("PORT", "18080")),
  dataDir: optional("DATA_DIR", "./data"),
  projectsDir: optional("PROJECTS_DIR", "./data/projects"),
  tavilyApiKey: optional("TAVILY_API_KEY", ""),

  // Skills — directories scanned for SKILL.md folders
  skillsDir: optional("SKILLS_DIR", "./skills"),

  // Cron — persisted job store
  cronFile: optional("CRON_FILE", "./data/cron/jobs.json"),

  // iMessage (macOS only — requires Full Disk Access)
  iMessageChatDb: optional(
    "IMESSAGE_CHAT_DB",
    `${process.env.HOME}/Library/Messages/chat.db`
  ),
  iMessageAllowFrom: (process.env.IMESSAGE_ALLOW_FROM || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  iMessagePollMs: parseInt(optional("IMESSAGE_POLL_MS", "3000")),
}
