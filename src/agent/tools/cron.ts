import type { CronStore } from "../../scheduler/store.js"
import type { CronRunner } from "../../scheduler/runner.js"

export function createCronDispatcher(store: CronStore, runner: CronRunner) {
  return async function dispatchCron(
    name: string,
    input: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean } | null> {
    switch (name) {
      case "cron_add": {
        try {
          const job = store.add({
            name:           String(input.name ?? "untitled"),
            schedule:       String(input.schedule),
            tz:             input.tz ? String(input.tz) : undefined,
            message:        String(input.message),
            delivery:       input.delivery as import("../../scheduler/store.js").CronDelivery | undefined,
            deleteAfterRun: Boolean(input.delete_after_run),
          })
          return { content: JSON.stringify({ ok: true, job }, null, 2), isError: false }
        } catch (err) {
          return { content: `Error: ${(err as Error).message}`, isError: true }
        }
      }

      case "cron_list": {
        const jobs = store.list()
        if (jobs.length === 0) return { content: "No scheduled jobs.", isError: false }
        return { content: JSON.stringify(jobs, null, 2), isError: false }
      }

      case "cron_remove": {
        const id = String(input.id)
        const deleted = store.remove(id)
        return deleted
          ? { content: `Job ${id} removed.`, isError: false }
          : { content: `Error: Job ${id} not found.`, isError: true }
      }

      case "cron_run_now": {
        const id = String(input.id)
        const result = await runner.runNow(id)
        return { content: result, isError: result.startsWith("Job") && !result.includes("executed") }
      }

      default:
        return null // not a cron tool
    }
  }
}
