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
  anthropicApiKey: optional("ANTHROPIC_API_KEY", ""),
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

  // OpenAI image generation
  openaiApiKey: optional("OPENAI_API_KEY", ""),
  imageModel: optional("IMAGE_MODEL", "gpt-image-1"),

  // Solana / Pump.fun
  solanaRpcUrl: optional("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  solanaPrivateKey: optional("SOLANA_PRIVATE_KEY", ""),

  // Alternative provider config
  // Used when MODEL is set to "openai/..." or "ollama/..."
  openaiChatApiKey: optional("OPENAI_CHAT_API_KEY", process.env.OPENAI_API_KEY ?? ""),
  openaiBaseUrl:    optional("OPENAI_BASE_URL", ""),
  ollamaBaseUrl:    optional("OLLAMA_BASE_URL", "http://localhost:11434"),

  // MCP servers — JSON array of server configs, e.g.:
  // [{"type":"stdio","name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]
  // [{"type":"sse","name":"my-server","url":"http://localhost:3001/sse"}]
  mcpServers: JSON.parse(optional("MCP_SERVERS", "[]")),

  // X / Twitter
  xBearerToken: optional("X_BEARER_TOKEN", ""),
  xOAuth2UserToken: optional("X_OAUTH2_USER_TOKEN", ""),
  xUserId: optional("X_USER_ID", ""),

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
