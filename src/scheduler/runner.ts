import type { CronStore, CronJob } from "./store.js"
import type { SessionManager } from "../sessions/manager.js"
import type { MemoryStore } from "../memory/store.js"
import type { Delivery } from "../delivery/index.js"
import { runAgentLoop } from "../agent/loop.js"

// ── Cron expression matching ──────────────────────────────────────────────────

function matchField(field: string, value: number): boolean {
  if (field === "*") return true
  if (field.includes(",")) return field.split(",").some((f) => matchField(f.trim(), value))
  if (field.includes("/")) {
    const [range, step] = field.split("/")
    const stepN = parseInt(step)
    if (isNaN(stepN) || stepN <= 0) return false
    const start = range === "*" ? 0 : parseInt(range)
    return value >= start && (value - start) % stepN === 0
  }
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map(Number)
    return value >= lo && value <= hi
  }
  return parseInt(field) === value
}

function matchesCron(expr: string, now: Date, tz?: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, mon, dow] = parts

  let d = now
  if (tz) {
    // Reinterpret the UTC instant in the target timezone by parsing locale string
    const localStr = now.toLocaleString("en-US", { timeZone: tz })
    d = new Date(localStr)
  }

  return (
    matchField(min, d.getMinutes()) &&
    matchField(hour, d.getHours()) &&
    matchField(dom, d.getDate()) &&
    matchField(mon, d.getMonth() + 1) &&
    matchField(dow, d.getDay())
  )
}

/** Returns true if the schedule string looks like an ISO datetime (one-shot). */
function isOneShot(schedule: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(schedule)
}

function shouldFire(job: CronJob, now: Date): boolean {
  if (isOneShot(job.schedule)) {
    if (job.lastRun) return false // already ran
    const target = new Date(job.schedule)
    const diffMs = now.getTime() - target.getTime()
    return diffMs >= 0 && diffMs < 60_000
  }
  // For recurring jobs check we haven't already fired this minute
  if (job.lastRun) {
    const lastRun = new Date(job.lastRun)
    if (
      lastRun.getFullYear() === now.getFullYear() &&
      lastRun.getMonth() === now.getMonth() &&
      lastRun.getDate() === now.getDate() &&
      lastRun.getHours() === now.getHours() &&
      lastRun.getMinutes() === now.getMinutes()
    ) {
      return false // already fired this minute
    }
  }
  return matchesCron(job.schedule, now, job.tz)
}

// ── Runner ────────────────────────────────────────────────────────────────────

export class CronRunner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private firing = new Set<string>()

  constructor(
    private store: CronStore,
    private sessions: SessionManager,
    private memory: MemoryStore,
    private delivery: Delivery
  ) {}

  start(): void {
    const tick = () => {
      this.check()
      const msToNext = 60_000 - (Date.now() % 60_000) + 50 // +50ms buffer
      this.timer = setTimeout(tick, msToNext)
    }
    const msToNext = 60_000 - (Date.now() % 60_000) + 50
    this.timer = setTimeout(tick, msToNext)
    console.log("Scheduler →  cron runner started")
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
  }

  /** Run a job immediately by id (useful for testing). */
  async runNow(jobId: string): Promise<string> {
    const job = this.store.get(jobId)
    if (!job) return `Job ${jobId} not found`
    await this.fire(job)
    return `Job "${job.name}" executed`
  }

  private check(): void {
    const now = new Date()
    for (const job of this.store.list()) {
      if (this.firing.has(job.id)) continue
      if (!shouldFire(job, now)) continue
      void this.fire(job)
    }
  }

  private async fire(job: CronJob): Promise<void> {
    this.firing.add(job.id)
    this.store.markRan(job.id)

    const sessionId = `cron:${job.id}`
    const session = this.sessions.getOrCreate(sessionId)
    let fullResponse = ""

    console.log(`[Cron] Firing job "${job.name}" (${job.id})`)

    try {
      await runAgentLoop(session, job.message, this.memory, {
        onToken: (delta) => { fullResponse += delta },
        onDone: () => this.sessions.save(session),
        onError: (err) => console.error(`[Cron] Job "${job.name}" error:`, err),
      })

      if (fullResponse.trim() && job.delivery) {
        const text = fullResponse.trim()
        if (job.delivery.channel === "telegram") {
          await this.delivery
            .sendTelegram(job.delivery.to, text)
            .catch((e) => console.error("[Cron] Telegram delivery failed:", e))
        } else if (job.delivery.channel === "imessage") {
          this.delivery.sendIMessage(job.delivery.to, job.delivery.serviceName ?? "iMessage", text)
        }
      }
    } catch (err) {
      console.error(`[Cron] Unexpected error in job "${job.name}":`, err)
    } finally {
      if (job.deleteAfterRun) this.store.remove(job.id)
      this.firing.delete(job.id)
    }
  }
}
