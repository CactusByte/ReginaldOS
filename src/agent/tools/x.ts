import { config } from "../../config.js"

const BASE = "https://api.x.com/2"
const TIMEOUT_MS = 15_000

async function xGet(path: string, params: Record<string, string | string[]> = {}): Promise<unknown> {
  if (!config.xBearerToken) throw new Error("X_BEARER_TOKEN is not set")

  const url = new URL(`${BASE}${path}`)
  for (const [key, val] of Object.entries(params)) {
    if (Array.isArray(val)) {
      if (val.length > 0) url.searchParams.set(key, val.join(","))
    } else if (val) {
      url.searchParams.set(key, val)
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${config.xBearerToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const json = await res.json()
  if (!res.ok) {
    const detail = (json as { detail?: string; title?: string })
    throw new Error(`X API ${res.status}: ${detail.detail ?? detail.title ?? res.statusText}`)
  }
  return json
}

// Write operations require the OAuth2 user token
async function xPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  if (!config.xOAuth2UserToken) throw new Error("X_OAUTH2_USER_TOKEN is not set — run the auth script in skills/x/scripts/")

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.xOAuth2UserToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const json = await res.json()
  if (!res.ok) {
    const detail = (json as { detail?: string; title?: string })
    throw new Error(`X API ${res.status}: ${detail.detail ?? detail.title ?? res.statusText}`)
  }
  return json
}

export async function xGetUser(input: {
  username: string
  user_fields?: string[]
}): Promise<string> {
  try {
    const data = await xGet(`/users/by/username/${encodeURIComponent(input.username)}`, {
      "user.fields": input.user_fields ?? [
        "id", "name", "username", "description", "created_at",
        "public_metrics", "profile_image_url", "verified", "location", "url",
      ],
    })
    return JSON.stringify(data, null, 2)
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`
  }
}

export async function xFollowUser(input: {
  source_user_id: string
  target_user_id: string
}): Promise<string> {
  try {
    const data = await xPost(`/users/${encodeURIComponent(input.source_user_id)}/following`, {
      target_user_id: input.target_user_id,
    })
    return JSON.stringify(data, null, 2)
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`
  }
}

export async function xGetUserTweets(input: {
  id: string
  max_results?: number
  exclude?: ("replies" | "retweets")[]
  since_id?: string
  until_id?: string
  tweet_fields?: string[]
}): Promise<string> {
  try {
    const data = await xGet(`/users/${encodeURIComponent(input.id)}/tweets`, {
      max_results: String(Math.min(input.max_results ?? 10, 100)),
      ...(input.exclude?.length ? { exclude: input.exclude } : {}),
      ...(input.since_id ? { since_id: input.since_id } : {}),
      ...(input.until_id ? { until_id: input.until_id } : {}),
      "tweet.fields": input.tweet_fields ?? [
        "id", "text", "created_at", "public_metrics", "author_id",
      ],
    })
    return JSON.stringify(data, null, 2)
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`
  }
}
