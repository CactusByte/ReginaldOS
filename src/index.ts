import { config } from "./config.js"
import { MemoryStore } from "./memory/store.js"
import { SessionManager } from "./sessions/manager.js"
import { AstroManager } from "./astro/manager.js"
import { createGateway } from "./gateway/server.js"
import { startTelegramBot } from "./channels/telegram/bot.js"
import { startIMessageBot } from "./channels/imessage/bot.js"
import { SkillLoader } from "./skills/loader.js"
import { CronStore } from "./scheduler/store.js"
import { CronRunner } from "./scheduler/runner.js"
import { Delivery } from "./delivery/index.js"
import { registerExtraTools } from "./agent/tools/index.js"
import { createCronDispatcher } from "./agent/tools/cron.js"
import { createSkillReadDispatcher } from "./agent/tools/skillRead.js"
import { initLoop } from "./agent/loop.js"
import { connectMcpServers } from "./mcp/client.js"
import type { McpServerConfig } from "./mcp/client.js"
import { join } from "node:path"

async function main(): Promise<void> {
  console.log("ReginaldOS starting…")

  const memory   = new MemoryStore(join(config.dataDir, "memory.db"))
  const sessions = new SessionManager(join(config.dataDir, "sessions"))
  const astro    = new AstroManager(config.projectsDir)
  const delivery = new Delivery()

  // ── Skills ────────────────────────────────────────────────────────────────
  const skills = new SkillLoader([config.skillsDir])

  registerExtraTools(
    [
      {
        name: "skill_read",
        description:
          "Load the full instructions for a skill by name. Call this when you identify a skill that is relevant to the current task.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Exact skill name as listed in the available_skills block" },
          },
          required: ["name"],
        },
      },
    ],
    createSkillReadDispatcher(skills)
  )

  // ── Cron scheduler ────────────────────────────────────────────────────────
  const cronStore  = new CronStore(config.cronFile)
  const cronRunner = new CronRunner(cronStore, sessions, memory, delivery)

  registerExtraTools(
    [
      {
        name: "cron_add",
        description:
          "Schedule a recurring or one-shot task. The agent will run `message` as a user turn at the specified time and optionally deliver the response via Telegram or iMessage.",
        input_schema: {
          type: "object",
          properties: {
            name:     { type: "string", description: "Human-readable job name" },
            schedule: {
              type: "string",
              description:
                "When to run. Three formats: " +
                "(1) Relative offset from now: +20m, +2h, +1d, +1h30m, +90s — auto-deleted after running. " +
                "(2) ISO 8601 one-shot datetime: '2026-04-01T08:00:00Z' — auto-deleted after running. " +
                "(3) 5-field cron expression for recurring jobs: '0 8 * * *' (8am daily). Supports *, numbers, ranges (1-5), step (*/2), lists (1,3,5).",
            },
            message:  { type: "string", description: "Prompt injected as the user turn when the job fires" },
            tz:       { type: "string", description: "IANA timezone for cron expression (e.g. 'America/Los_Angeles'). Default UTC." },
            delivery: {
              type: "object",
              description: "Where to send the agent's response. Omit for silent execution.",
              properties: {
                channel:     { type: "string", enum: ["telegram", "imessage"] },
                to:          { type: "string", description: "Telegram chat ID or iMessage handle" },
                serviceName: { type: "string", description: "iMessage service name (default: iMessage)" },
              },
              required: ["channel", "to"],
            },
            delete_after_run: {
              type: "boolean",
              description: "Delete this job after it runs once (useful for one-shot jobs). Default false.",
            },
          },
          required: ["name", "schedule", "message"],
        },
      },
      {
        name: "cron_list",
        description: "List all scheduled cron jobs.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "cron_remove",
        description: "Remove a scheduled cron job by its ID.",
        input_schema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Job ID (from cron_list)" },
          },
          required: ["id"],
        },
      },
      {
        name: "cron_run_now",
        description: "Immediately execute a cron job by ID, regardless of its schedule.",
        input_schema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Job ID (from cron_list)" },
          },
          required: ["id"],
        },
      },
    ],
    createCronDispatcher(cronStore, cronRunner)
  )

  // ── MCP servers ───────────────────────────────────────────────────────────
  if (config.mcpServers.length > 0) {
    await connectMcpServers(config.mcpServers as McpServerConfig[])
  }

  // ── Freeze system prompt + tool list (must happen after registerExtraTools) ─
  initLoop(skills.hasSkills() ? skills.toXml() : undefined)

  // ── Start cron runner ─────────────────────────────────────────────────────
  cronRunner.start()

  // ── Start channels ────────────────────────────────────────────────────────
  createGateway(sessions, memory, astro, config.port)

  if (config.telegramBotToken) {
    startTelegramBot(sessions, memory)
  } else {
    console.log("Telegram  →  disabled (set TELEGRAM_BOT_TOKEN to enable)")
  }

  startIMessageBot(sessions, memory)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
