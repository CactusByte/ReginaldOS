import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

export interface Skill {
  name: string
  content: string
}

export class SkillLoader {
  private skills: Map<string, Skill> = new Map()

  constructor(dirs: string[]) {
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      try {
        const entries = readdirSync(dir)
        for (const entry of entries) {
          const entryPath = join(dir, entry)
          if (!statSync(entryPath).isDirectory()) continue
          const skillFile = join(entryPath, "SKILL.md")
          if (!existsSync(skillFile)) continue
          const content = readFileSync(skillFile, "utf-8")
          this.skills.set(entry, { name: entry, content })
        }
      } catch {
        // skip unreadable directories
      }
    }
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values())
  }

  hasSkills(): boolean {
    return this.skills.size > 0
  }

  toXml(): string {
    const items = this.getAll()
      .map((s) => `  <skill name="${s.name}" />`)
      .join("\n")
    return `<available_skills>\n${items}\n</available_skills>`
  }
}
