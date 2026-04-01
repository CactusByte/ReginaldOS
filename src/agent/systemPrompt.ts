import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

export function getSystemPrompt(skillsXml?: string): string {
  const agentsMdPath = join(process.cwd(), "SOUL.md")
  const agentsMd = existsSync(agentsMdPath)
    ? readFileSync(agentsMdPath, "utf-8")
    : ""

  const skillsSection = skillsXml
    ? [
        "",
        "## Available Skills",
        "",
        "Use `skill_read` to load the full instructions for a skill before using it.",
        "",
        skillsXml,
      ].join("\n")
    : ""

  // System prompt is built once at startup and stays byte-identical across
  // requests, enabling Claude prompt cache hits. Do not inject live timestamps here.
  return [
    "You are ReginaldOS, a personal AI assistant daemon running on the user's own hardware.",
    "",
    agentsMd,
    skillsSection,
  ]
    .join("\n")
    .trim()
}
