const BASE = "https://api.rugcheck.xyz/v1"
const TIMEOUT_MS = 15_000

interface RiskItem {
  name: string
  description: string
  level: string   // "danger" | "warn" | "info"
  score: number
  value?: string
}

interface SummaryResponse {
  mint: string
  score: number
  score_normalised: number
  rugged: boolean
  tokenType: string
  risks: RiskItem[]
  markets?: Array<{
    lp?: {
      lpLockedPct: number
      lpLockedUSD?: number
    }
  }>
  token?: {
    name: string
    symbol: string
    decimals: number
    supply: number
  }
  creator?: string
  topHolders?: Array<{
    address: string
    pct: number
  }>
}

function riskLabel(score: number): string {
  if (score <= 500)  return "GOOD ✓"
  if (score <= 2000) return "WARN ⚠️"
  return "DANGER 🚨"
}

function levelEmoji(level: string): string {
  switch (level.toLowerCase()) {
    case "danger": return "🚨"
    case "warn":   return "⚠️"
    default:       return "ℹ️"
  }
}

async function fetchSummary(mint: string): Promise<SummaryResponse> {
  const res = await fetch(`${BASE}/tokens/${mint}/report/summary`, {
    headers: { "User-Agent": "ReginaldOS/0.1", "Accept": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`RugCheck API error ${res.status}: ${body}`)
  }
  return res.json() as Promise<SummaryResponse>
}

async function fetchFullReport(mint: string): Promise<unknown> {
  const res = await fetch(`${BASE}/tokens/${mint}/report`, {
    headers: { "User-Agent": "ReginaldOS/0.1", "Accept": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`RugCheck API error ${res.status}: ${body}`)
  }
  return res.json()
}

export async function rugcheck(input: {
  mint: string
  full?: boolean
}): Promise<string> {
  const { mint, full = false } = input

  if (full) {
    const report = await fetchFullReport(mint)
    return JSON.stringify(report, null, 2)
  }

  const data = await fetchSummary(mint)

  const lines: string[] = []

  // Header
  const name = data.token ? `${data.token.name} (${data.token.symbol})` : mint
  lines.push(`Token: ${name}`)
  lines.push(`Mint: ${mint}`)
  lines.push(`Type: ${data.tokenType ?? "unknown"}`)
  lines.push("")

  // Overall score
  const score = data.score ?? data.score_normalised ?? 0
  lines.push(`Risk Score: ${score} — ${riskLabel(score)}`)
  if (data.rugged) lines.push(`⛔ MARKED AS RUGGED`)
  lines.push("")

  // Risks
  if (data.risks && data.risks.length > 0) {
    const dangers = data.risks.filter(r => r.level?.toLowerCase() === "danger")
    const warns   = data.risks.filter(r => r.level?.toLowerCase() === "warn")
    const infos   = data.risks.filter(r => !["danger","warn"].includes(r.level?.toLowerCase()))

    if (dangers.length > 0) {
      lines.push("🚨 Danger flags:")
      for (const r of dangers) {
        lines.push(`  • ${r.name}: ${r.description}${r.value ? ` (${r.value})` : ""}`)
      }
      lines.push("")
    }
    if (warns.length > 0) {
      lines.push("⚠️ Warnings:")
      for (const r of warns) {
        lines.push(`  • ${r.name}: ${r.description}${r.value ? ` (${r.value})` : ""}`)
      }
      lines.push("")
    }
    if (infos.length > 0) {
      lines.push("ℹ️ Info:")
      for (const r of infos) {
        lines.push(`  • ${r.name}: ${r.description}${r.value ? ` (${r.value})` : ""}`)
      }
      lines.push("")
    }
  } else {
    lines.push("No risk flags detected.")
    lines.push("")
  }

  // LP lock
  const lpPct = data.markets?.[0]?.lp?.lpLockedPct
  const lpUsd = data.markets?.[0]?.lp?.lpLockedUSD
  if (lpPct !== undefined) {
    lines.push(`LP Locked: ${lpPct.toFixed(2)}%${lpUsd ? ` ($${lpUsd.toLocaleString()})` : ""}`)
  }

  // Top holders
  if (data.topHolders && data.topHolders.length > 0) {
    lines.push(`Top holders:`)
    for (const h of data.topHolders.slice(0, 5)) {
      lines.push(`  ${h.address.slice(0, 8)}…  ${h.pct.toFixed(2)}%`)
    }
    lines.push("")
  }

  // Creator
  if (data.creator) {
    lines.push(`Creator: ${data.creator}`)
  }

  lines.push(`Full report: https://rugcheck.xyz/tokens/${mint}`)

  return lines.filter(l => l !== undefined).join("\n")
}
