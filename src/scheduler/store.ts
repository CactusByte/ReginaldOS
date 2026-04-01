import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

export interface CronDelivery {
  channel: "telegram" | "imessage"
  /** Telegram chatId (string) or iMessage handle (e.g. "+15551234567") */
  to: string
  /** iMessage service name, defaults to "iMessage" */
  serviceName?: string
}

export interface CronJob {
  id: string
  name: string
  /**
   * Either a 5-field cron expression ("0 8 * * *") or an ISO 8601 datetime for a one-shot run.
   * Supported cron fields: minute hour dom month dow
   * Supports: *, numbers, ranges (1-5), step (*\/2), lists (1,3,5)
   */
  schedule: string
  /** IANA timezone for cron expression evaluation (default UTC) */
  tz?: string
  /** Message injected as the user turn in the agent session */
  message: string
  /** Where to deliver output. Omit for silent/logged-only execution. */
  delivery?: CronDelivery
  /** Auto-delete this job after it runs once (useful for one-shot `at:` jobs) */
  deleteAfterRun?: boolean
  createdAt: string
  lastRun?: string
}

/**
 * Resolve a relative time expression like "+20m", "+2h", "+1d", "+1h30m"
 * to an absolute ISO 8601 datetime. Returns the input unchanged if it doesn't
 * look like a relative expression.
 */
export function resolveSchedule(schedule: string): string {
  const rel = schedule.trim()
  if (!rel.startsWith("+")) return rel

  // Parse: +<number><unit> combinations, e.g. +20m  +2h  +1d  +1h30m  +90s
  const pattern = /\+(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/
  const m = rel.match(pattern)
  if (!m || rel === "+") {
    throw new Error(
      `Invalid relative schedule "${schedule}". Examples: +20m, +2h, +1d, +1h30m`
    )
  }
  const [, d, h, min, s] = m
  const totalMs =
    (parseInt(d ?? "0") * 86_400 +
      parseInt(h ?? "0") * 3_600 +
      parseInt(min ?? "0") * 60 +
      parseInt(s ?? "0")) *
    1_000
  if (totalMs <= 0) {
    throw new Error(`Relative schedule "${schedule}" resolves to zero duration`)
  }
  return new Date(Date.now() + totalMs).toISOString()
}

export class CronStore {
  private jobs = new Map<string, CronJob>()

  constructor(private filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.load()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const arr = JSON.parse(readFileSync(this.filePath, "utf-8")) as CronJob[]
      for (const job of arr) this.jobs.set(job.id, job)
      console.log(`Scheduler →  loaded ${this.jobs.size} cron job(s)`)
    } catch {
      console.warn("[CronStore] Could not load jobs file — starting fresh")
    }
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify([...this.jobs.values()], null, 2))
  }

  add(job: Omit<CronJob, "id" | "createdAt">): CronJob {
    // Resolve relative schedules (+20m, +2h …) to absolute ISO datetimes at creation time
    const resolvedSchedule = resolveSchedule(job.schedule)
    // One-shot relative jobs should auto-delete unless the caller said otherwise
    const deleteAfterRun =
      job.deleteAfterRun ?? job.schedule.startsWith("+") ? true : false
    const full: CronJob = {
      ...job,
      schedule: resolvedSchedule,
      deleteAfterRun,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    this.jobs.set(full.id, full)
    this.persist()
    return full
  }

  list(): CronJob[] {
    return [...this.jobs.values()]
  }

  remove(id: string): boolean {
    const deleted = this.jobs.delete(id)
    if (deleted) this.persist()
    return deleted
  }

  markRan(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.lastRun = new Date().toISOString()
    this.persist()
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id)
  }
}
