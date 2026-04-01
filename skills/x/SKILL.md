---
name: x
description: Post tweets, read mentions, and interact with the X (Twitter) API v2 on behalf of the authenticated user.
---

# X Skill

This skill lets you interact with the X API v2 — posting tweets, reading mentions, and more — using OAuth2 user tokens stored in the environment. NEVER USE EMOJIS IN TWEETS and DONT BE PUSHI PROMOTING COINS, mention them if asked or mentioned in the tweet or if it is a cron scheduled promotion

## Setup

Before using this skill, the user must have valid OAuth2 credentials in `.env`:

```
X_BEARER_TOKEN=
X_CLIENT_ID=
X_CLIENT_SECRET=
X_OAUTH2_USER_TOKEN=
X_OAUTH2_REFRESH_TOKEN=
X_OAUTH2_REDIRECT_URI=http://127.0.0.1:8080/callback
X_OAUTH2_SCOPES=tweet.read tweet.write users.read offline.access
```

If `X_OAUTH2_USER_TOKEN` is missing or expired, run the auth helper:

```bash
python3 skills/x/scripts/get_x_oauth2_user_token.py
```

Follow the printed URL, authorize in the browser, paste back the callback URL or code, and copy the output tokens into `.env`.

---

## Authentication

All write operations (post, edit) require **OAuth2 user token** (`X_OAUTH2_USER_TOKEN`).
Read operations (mentions, timelines) can use either the user token or the **Bearer token** (`X_BEARER_TOKEN`).

When making requests via `bash`, read tokens from environment variables — never hardcode them.

---

## Operations

### Post a Tweet

```bash
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your tweet text here"}'
```

**Response:**
```json
{
  "data": {
    "id": "1346889436626259968",
    "text": "Your tweet text here"
  }
}
```

---

### Reply to a Tweet

```bash
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Your reply here",
    "reply": {
      "in_reply_to_tweet_id": "<tweet_id>"
    }
  }'
```

---

### Quote a Tweet

```bash
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Your comment here",
    "quote_tweet_id": "<tweet_id>"
  }'
```

---

### Post a Poll

```bash
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Your poll question",
    "poll": {
      "options": ["Option A", "Option B", "Option C"],
      "duration_minutes": 1440
    }
  }'
```

`duration_minutes` range: 5 – 10080 (7 days).

---

### Edit a Tweet

Only available within the edit window (30 minutes, up to 5 edits):

```bash
curl -s -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Corrected tweet text",
    "edit_options": {
      "previous_post_id": "<tweet_id>"
    }
  }'
```

---

### Get Mentions for a User

Requires the user's numeric ID (`X_USER_ID` or look it up first).

```bash
curl -s "https://api.x.com/2/users/<user_id>/mentions?max_results=10&tweet.fields=created_at,author_id,text" \
  -H "Authorization: Bearer $X_BEARER_TOKEN"
```

**Useful query params:**

| Param | Description |
|---|---|
| `max_results` | 5–100 |
| `since_id` | Only tweets after this ID |
| `until_id` | Only tweets before this ID |
| `start_time` | ISO 8601 UTC (`2025-01-01T00:00:00Z`) |
| `end_time` | ISO 8601 UTC |
| `tweet.fields` | Extra fields: `created_at`, `author_id`, `public_metrics`, `entities`, etc. |
| `expansions` | Expand referenced objects: `author_id`, `attachments.media_keys`, etc. |

---

### Look Up Your Own User ID

```bash
curl -s "https://api.x.com/2/users/me" \
  -H "Authorization: Bearer $X_OAUTH2_USER_TOKEN"
```

Store the returned `id` as `X_USER_ID` in `.env` to avoid re-fetching it.

---

## Field Reference

### `tweet.fields` options
`article`, `attachments`, `author_id`, `card_uri`, `community_id`, `context_annotations`,
`conversation_id`, `created_at`, `edit_controls`, `entities`, `geo`, `id`,
`in_reply_to_user_id`, `lang`, `non_public_metrics`, `note_tweet`, `organic_metrics`,
`possibly_sensitive`, `promoted_metrics`, `public_metrics`, `referenced_tweets`,
`reply_settings`, `source`, `text`, `withheld`

### `user.fields` options
`affiliation`, `created_at`, `description`, `entities`, `id`, `is_identity_verified`,
`location`, `most_recent_tweet_id`, `name`, `pinned_tweet_id`, `profile_banner_url`,
`profile_image_url`, `protected`, `public_metrics`, `subscription_type`, `url`,
`username`, `verified`, `verified_type`, `withheld`

### `expansions` options
`article.cover_media`, `attachments.media_keys`, `attachments.poll_ids`, `author_id`,
`entities.mentions.username`, `geo.place_id`, `in_reply_to_user_id`,
`referenced_tweets.id`, `referenced_tweets.id.author_id`

---

## Error Handling

Always check `errors` in the response. Common issues:

| Status | Meaning |
|---|---|
| 401 | Token expired or missing — re-run the auth script |
| 403 | Insufficient scopes — check `X_OAUTH2_SCOPES` includes what you need |
| 429 | Rate limited — back off and retry |

If the user token is expired and a `X_OAUTH2_REFRESH_TOKEN` is present, refresh it:

```bash
curl -s -X POST "https://api.x.com/2/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$X_CLIENT_ID:$X_CLIENT_SECRET" \
  -d "grant_type=refresh_token&refresh_token=$X_OAUTH2_REFRESH_TOKEN"
```

Update `.env` with the new `access_token` and `refresh_token` from the response.

---

## Operating Rules

- Always read tokens from environment — never print or log them.
- Confirm the tweet text with the user before posting unless they explicitly said to post directly.
- When posting on Reginald's behalf, write in his voice (see `SOUL.md`).
- Prefer the Bearer token for reads; always use the user token for writes.
- After a successful post, report the tweet ID and URL: `https://x.com/i/web/status/<id>`
