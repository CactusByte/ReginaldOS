---
name: x
description: Post tweets, read timelines, look up users, follow accounts, and interact with X (Twitter) API v2 on behalf of the authenticated user.
---

# X Skill

Interact with X (Twitter) API v2 — posting, reading, following, and more.

NEVER USE EMOJIS IN TWEETS. Do not push or promote coins unprompted — mention them only if asked or if the tweet is a scheduled promotion.

---

## Native Tools (use these first)

The agent has built-in tools for X — prefer them over raw curl/bash:

| Tool | Auth Required | What it does |
|---|---|---|
| `x_get_user` | Bearer token | Look up a user by username → returns ID, bio, metrics |
| `x_get_user_tweets` | Bearer token | Fetch recent tweets by numeric user ID |
| `x_follow_user` | OAuth2 user token | Follow a user on behalf of the authenticated account |

**Typical workflow to follow someone by username:**
1. `x_get_user` with their username → note their `id`
2. `x_follow_user` with `source_user_id` = `X_USER_ID` (from env) and `target_user_id` = their `id`

---

## Setup

Valid OAuth2 credentials must be in `.env`:

```
X_BEARER_TOKEN=          # Read-only operations
X_OAUTH2_USER_TOKEN=     # Write operations (post, follow)
X_OAUTH2_REFRESH_TOKEN=  # For refreshing the user token
X_CLIENT_ID=
X_CLIENT_SECRET=
X_USER_ID=               # Numeric ID of the authenticated account (run x_get_user on yourself)
X_OAUTH2_REDIRECT_URI=http://127.0.0.1:8080/callback
X_OAUTH2_SCOPES=tweet.read tweet.write users.read follows.write offline.access
```

If `X_OAUTH2_USER_TOKEN` is missing or expired, run:

```bash
python3 skills/x/scripts/get_x_oauth2_user_token.py
```

Follow the printed URL, authorize in the browser, paste back the callback URL or code, and copy the output tokens into `.env`.

---

## Authentication

- **Bearer token** (`X_BEARER_TOKEN`) — reads: user lookup, timelines
- **OAuth2 user token** (`X_OAUTH2_USER_TOKEN`) — writes: post, follow, like, retweet

---

## Additional Operations (via bash/curl)

For operations not yet covered by native tools, use the shell:

### Post a Tweet

```bash
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your tweet text here"}'
```

### Reply to a Tweet

```bash
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your reply", "reply": {"in_reply_to_tweet_id": "<tweet_id>"}}'
```

### Quote a Tweet

```bash
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your comment", "quote_tweet_id": "<tweet_id>"}'
```

### Post a Poll

```bash
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Poll question", "poll": {"options": ["A", "B", "C"], "duration_minutes": 1440}}'
```

`duration_minutes` range: 5–10080 (7 days).

### Get Mentions

```bash
curl -s "https://api.x.com/2/users/$X_USER_ID/mentions?max_results=10&tweet.fields=created_at,author_id,text" \
  -H "Authorization: Bearer $X_BEARER_TOKEN"
```

### Look Up Your Own User ID

```bash
curl -s "https://api.x.com/2/users/me" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN"
```

Save the returned `id` as `X_USER_ID` in `.env`.

### Refresh an Expired Token

```bash
curl -s -X POST "https://api.x.com/2/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$X_CLIENT_ID:$X_CLIENT_SECRET" \
  -d "grant_type=refresh_token&refresh_token=$X_OAUTH2_REFRESH_TOKEN"
```

Update `.env` with the new `access_token` and `refresh_token`.

---

## Field Reference

### `tweet.fields`
`id`, `text`, `created_at`, `author_id`, `public_metrics`, `entities`, `conversation_id`,
`in_reply_to_user_id`, `referenced_tweets`, `reply_settings`, `lang`, `possibly_sensitive`

### `user.fields`
`id`, `name`, `username`, `description`, `created_at`, `public_metrics`,
`profile_image_url`, `verified`, `location`, `url`, `protected`

---

## Error Handling

| Status | Meaning |
|---|---|
| 401 | Token expired or missing — re-run the auth script |
| 403 | Insufficient scopes — ensure `follows.write` is in `X_OAUTH2_SCOPES` |
| 429 | Rate limited — back off and retry |

---

## Operating Rules

- Always read tokens from environment — never print or log them.
- **Confirm with the user before posting or following** unless they explicitly said to proceed directly.
- When posting as Reginald, write in his voice (see `soul` skill and `SOUL.md`).
- Prefer native tools (`x_get_user`, `x_get_user_tweets`, `x_follow_user`) over bash/curl.
- After a successful post, report the tweet ID and URL: `https://x.com/i/web/status/<id>`
- `x_follow_user` requires `X_USER_ID` in env as the `source_user_id`. If missing, call `x_get_user` on the authenticated account's username first.
