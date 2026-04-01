import type { SkillLoader } from "../../skills/loader.js"

export function createSkillReadDispatcher(loader: SkillLoader) {
  return function dispatchSkillRead(
    name: string,
    input: Record<string, unknown>
  ): { content: string; isError: boolean } | null {
    if (name !== "skill_read") return null

    const skillName = String(input.name ?? "")
    const skill = loader.get(skillName)
    if (!skill) {
      const available = loader.getAll().map((s) => s.name)
      const hint = available.length > 0
        ? ` Available: ${available.join(", ")}`
        : " No skills are currently installed."
      return {
        content: `Error: skill "${skillName}" not found.${hint}`,
        isError: true,
      }
    }
    return { content: skill.content, isError: false }
  }
}
