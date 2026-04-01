# ReginaldOS

Personal AI assistant daemon. Runs on your own hardware, accessible through a browser Canvas interface, Telegram, and iMessage. Powered by Claude.

**Stack:** Node.js 22 · TypeScript (ESM) · Claude API · SQLite FTS5 · WebSocket · grammy

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Setup](#setup)
- [Configuration](#configuration)
- [Skills](#skills)
- [Channels](#channels)
- [Canvas & A2UI](#canvas--a2ui)
- [WebSocket Protocol](#websocket-protocol)
- [Memory](#memory)
- [Cron Scheduler](#cron-scheduler)
- [File Structure](#file-structure)
- [Extending](#extending)

---

## Features

- **Browser Canvas** — agent-controlled UI rendered directly in your browser via WebSocket
- **Telegram** — chat with the agent from any device via Telegram bot
- **iMessage** — chat with the agent via iMessage on macOS (requires Full Disk Access)
- **Skills** — teach the agent new capabilities by dropping `SKILL.md` files into `./skills/`
- **Persistent memory** — SQLite FTS5 full-text search store, the agent can save and recall facts across sessions
- **Cron scheduler** — schedule one-shot or recurring agent tasks, with optional Telegram/iMessage delivery
- **Tool suite** — bash, file read/write, web fetch, browser automation, memory search, canvas update

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ReginaldOS Daemon                            │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Gateway  (src/gateway/server.ts)                            │   │
│  │  Node.js HTTP + WebSocket  ·  port 18080                     │   │
│  │                                                              │   │
│  │   GET /        → serves Canvas shell HTML                    │   │
│  │   WS  /ws      → chat messages + A2UI action events          │   │
│  └──────────┬─────────────────────────────────────┬─────────────┘   │
│             │ runTurn()                            │ handleCanvasAction()
│             ▼                                     ▼                 │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Agent Loop  (src/agent/loop.ts)                             │   │
│  │                                                              │   │
│  │   1. Load session history from disk                          │   │
│  │   2. Build message array  (history + user message)           │   │
│  │   3. Stream from Claude API  →  fire onToken callbacks       │   │
│  │   4. On tool_use: execute tool, append result, loop back     │   │
│  │   5. On end_turn: persist text-only messages to session file │   │
│  │                                       (max 20 inner turns)   │   │
│  └──────┬───────────────────────────────────────────────────────┘   │
│         │                                                           │
│   ┌─────▼──────────────────────────────────────────┐               │
│   │  Tools  (src/agent/tools/)                     │               │
│   │                                                │               │
│   │  bash          exec shell command (30s timeout)│               │
│   │  read_file     fs.readFileSync                 │               │
│   │  write_file    fs.writeFileSync + mkdir        │               │
│   │  web_fetch     fetch() · 15s timeout · 100KB   │               │
│   │  memory_search SQLite FTS5 search/insert/delete│               │
│   │  canvas_update broadcast HTML to browser       │               │
│   │  skill_read    load full skill instructions    │               │
│   │  cron_add/list/remove/run_now                  │               │
│   └──────┬───────────────────────┬─────────────────┘               │
│          │                       │                                  │
│   ┌──────▼──────┐   ┌────────────▼─────────────────┐               │
│   │  Sessions   │   │  Memory  (src/memory/store.ts)│               │
│   │  JSON files │   │                              │               │
│   │  per session│   │  SQLite WAL mode             │               │
│   │  (60 msg    │   │  FTS5 virtual table          │               │
│   │   window)   │   │  BM25 ranking via rank col   │               │
│   └─────────────┘   └──────────────────────────────┘               │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Canvas Singleton  (src/canvas/index.ts)                     │   │
│  │  Set<WebSocket> of connected browser clients                 │   │
│  │  canvasBroadcast(html) → sends canvas_update to all clients  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Telegram Bot  (src/channels/telegram/bot.ts)                │   │
│  │  grammy long-poll · per-user session (telegram:<chatId>)     │   │
│  │  accumulates tokens → sends one reply on turn_end            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  iMessage Bot  (src/channels/imessage/bot.ts)                │   │
│  │  SQLite polling of ~/Library/Messages/chat.db                │   │
│  │  replies via osascript  ·  macOS only                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Cron Scheduler  (src/scheduler/)                            │   │
│  │  Persisted JSON job store · relative, ISO, and cron formats  │   │
│  │  Fires agent turns on schedule with optional delivery        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
         │ Anthropic SDK streaming
         ▼
  ┌─────────────┐
  │ Anthropic   │
  │ Claude API  │
  └─────────────┘
```

---

## Setup

### Prerequisites

- Node.js ≥ 22
- Anthropic API key (`ANTHROPIC_API_KEY`)

### Install

```bash
git clone <repo>
cd ReginaldOS
npm install
cp .env.example .env
# Edit .env — fill in ANTHROPIC_API_KEY at minimum
```

### Run (dev — file-watch restart)

```bash
npm run dev
```

### Run (production)

```bash
npm run build   # tsc → dist/
npm start       # node dist/index.js
```

Open `http://localhost:18080` in your browser.

---

## Configuration

All config is read from environment variables (`.env` via dotenv):

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✓ | — | Anthropic API key |
| `MODEL` | | `claude-opus-4-6` | Claude model ID |
| `PORT` | | `18080` | HTTP + WebSocket port |
| `DATA_DIR` | | `./data` | Where sessions and `memory.db` are stored |
| `PROJECTS_DIR` | | `./data/projects` | Astro project build directory |
| `SKILLS_DIR` | | `./skills` | Directory scanned for skill folders |
| `CRON_FILE` | | `./data/cron/jobs.json` | Persisted cron job store |
| `TELEGRAM_BOT_TOKEN` | | — | Enables the Telegram channel |
| `TELEGRAM_ALLOW_FROM` | | (all) | Comma-separated Telegram usernames to allow |
| `IMESSAGE_CHAT_DB` | | `~/Library/Messages/chat.db` | Path to iMessage database (macOS) |
| `IMESSAGE_ALLOW_FROM` | | (all) | Comma-separated iMessage handles to allow |
| `IMESSAGE_POLL_MS` | | `3000` | How often to poll iMessage DB (ms) |
| `TAVILY_API_KEY` | | — | Enables Tavily web search tool |

### Customising agent behaviour

Edit `SOUL.md` at the project root. This file is loaded as the system prompt prefix. Restart after changes — the prompt is cached in memory after first read to enable Claude prompt cache hits.

**Do not inject `new Date()` into `SOUL.md`** — it would break the prompt cache on every request.

---

## Skills

Skills are directories containing a `SKILL.md` file. They teach the agent how and when to use tools or follow specific workflows. ReginaldOS injects the list of available skills into the system prompt; the agent calls `skill_read` to load a skill's full instructions on demand.

### Directory

Place skill folders in `./skills/` (or set `SKILLS_DIR` to point elsewhere):

```
skills/
└── my-skill/
    └── SKILL.md
```

### SKILL.md format

```markdown
---
name: my_skill
description: One-line description shown to the agent in the skills list.
---

# My Skill

Instructions for the agent go here. Tell it which tools to use, in what order,
and what to do with the results.
```

The `name` and `description` frontmatter fields are required. All other content is the instruction body shown to the agent when it calls `skill_read`.

### Using skills from external sources

If you have skills installed elsewhere (e.g. from another tool's workspace), point `SKILLS_DIR` at that directory:

```bash
SKILLS_DIR=/path/to/other/workspace/skills npm run dev
```

Or in `.env`:
```
SKILLS_DIR=/path/to/other/workspace/skills
```

ReginaldOS will load the `SKILL.md` from each subfolder and ignore metadata fields it doesn't understand (such as `requires.bins`, `requires.env`, install specs, etc.). Make sure any binaries or API keys a skill depends on are available in your environment — ReginaldOS does not gate or inject them automatically.

### How it works at runtime

1. On startup, `SkillLoader` scans `SKILLS_DIR` for subdirectories containing `SKILL.md`
2. A compact XML list of skill names is injected into the system prompt
3. When the agent identifies a relevant skill, it calls `skill_read` with the skill name
4. The full `SKILL.md` content is returned and the agent follows the instructions

Skill changes require a restart (no hot reload).

---

## Channels

### Browser Canvas

The primary interface. Open `http://localhost:18080`. The agent controls the canvas content via `canvas_update`. See [Canvas & A2UI](#canvas--a2ui) for details.

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Set `TELEGRAM_BOT_TOKEN` in `.env`
3. Optionally restrict access: `TELEGRAM_ALLOW_FROM=username1,username2`

The bot uses grammy long-polling — no public URL or webhook required. Each Telegram chat gets its own session (`telegram:<chatId>`).

### iMessage (macOS only)

Requires **Full Disk Access** for the process running ReginaldOS (Terminal, your IDE, or the binary).

1. Grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access
2. Optionally restrict: `IMESSAGE_ALLOW_FROM=+15551234567,handle@example.com`

ReginaldOS polls `chat.db` every `IMESSAGE_POLL_MS` milliseconds and replies via AppleScript. Only messages received **after startup** are processed.

---

## Canvas & A2UI

The Canvas is a browser tab that the agent fully controls. It renders HTML sent by the agent via the `canvas_update` tool.

### Rendering flow

1. Agent calls `canvas_update` with an HTML string
2. `canvasBroadcast` sends `{ type: "canvas_update", html }` to all connected WebSocket clients
3. Browser replaces `#canvas-content` innerHTML with the agent's HTML
4. Browser calls `wireA2UI()` to attach click listeners to all `[data-a2ui-action]` elements

### Making elements interactive (A2UI)

Add these attributes to any HTML element to make it send an action back to the agent when clicked:

| Attribute | Purpose |
|---|---|
| `data-a2ui-action="name"` | Action name sent back to the agent |
| `data-a2ui-param-<key>="value"` | Named parameters packed into a `params` object |

Example:
```html
<button data-a2ui-action="confirm" data-a2ui-param-id="42">Confirm</button>
```

When clicked, the browser sends:
```json
{ "type": "a2ui_action", "action": "confirm", "params": { "id": "42" } }
```

The gateway turns this into a new agent turn with message:
```
[Canvas Action] action="confirm" params={"id":"42"}
```

### Built-in CSS classes

```html
<!-- Buttons -->
<button class="a2ui-btn" data-a2ui-action="confirm">Confirm</button>
<button class="a2ui-btn secondary" data-a2ui-action="cancel">Cancel</button>
<button class="a2ui-btn danger" data-a2ui-action="delete">Delete</button>

<!-- Card -->
<div class="a2ui-card">Card content</div>

<!-- Badges -->
<span class="a2ui-badge green">active</span>
<span class="a2ui-badge amber">pending</span>
<span class="a2ui-badge red">error</span>
```

### Canvas behaviour

- While the agent is generating text, tokens appear in a **stream overlay** covering the canvas
- When `canvas_update` arrives, the overlay hides and the new HTML is shown
- If no `canvas_update` arrives, the stream overlay stays visible so you can read the text response
- A "thinking" pill in the top-right shows the current tool name while tools are executing

---

## WebSocket Protocol

All frames are JSON. Connect to `ws://localhost:18080/ws`.

### Client → Server

```jsonc
// Send a chat message
{ "type": "chat", "sessionId": "<uuid>", "text": "Hello" }

// Interactive element clicked
{ "type": "a2ui_action", "action": "confirm", "params": { "id": "42" } }
```

### Server → Client

```jsonc
// Streaming text token
{ "type": "token", "delta": "Hello" }

// Tool execution started
{ "type": "tool_start", "toolCallId": "toolu_01...", "name": "bash", "input": { "command": "ls" } }

// Tool execution finished
{ "type": "tool_result", "toolCallId": "toolu_01...", "name": "bash", "result": "...", "isError": false }

// Agent pushed HTML to the canvas
{ "type": "canvas_update", "html": "<h1>Hello</h1>", "title": "My View" }

// Turn complete
{ "type": "turn_end" }

// Error
{ "type": "error", "message": "..." }
```

---

## Memory

The agent has a persistent memory store backed by SQLite FTS5 at `data/memory.db`.

### Schema

```sql
CREATE TABLE memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT,                          -- optional comma-separated
  created_at TEXT DEFAULT (strftime(...))
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags,
  content='memories',
  content_rowid='id'
);
-- Three triggers keep the FTS index in sync: AFTER INSERT / DELETE / UPDATE
```

### Tool actions

The agent calls `memory_search` with one of three actions:

| Action | Purpose |
|---|---|
| `search` | Full-text BM25 search across all memories |
| `insert` | Save a new memory tagged to the current session |
| `delete` | Remove a memory by ID |

FTS5 special characters (`"`, `*`, `^`) are stripped from queries to avoid parse errors.

---

## Cron Scheduler

The agent can schedule recurring or one-shot tasks using the `cron_add` tool. Jobs are persisted to `data/cron/jobs.json` and survive restarts.

### Schedule formats

| Format | Example | Behaviour |
|---|---|---|
| Relative offset | `+20m`, `+2h`, `+1d`, `+1h30m` | Runs once after the offset, then auto-deleted |
| ISO 8601 datetime | `2026-04-01T08:00:00Z` | Runs once at that time, then auto-deleted |
| Cron expression | `0 8 * * *` | Recurring (5-field cron) |

### Tools

| Tool | Description |
|---|---|
| `cron_add` | Create a new job |
| `cron_list` | List all jobs |
| `cron_remove` | Delete a job by ID |
| `cron_run_now` | Execute a job immediately |

### Delivery

Jobs can optionally deliver their output via Telegram or iMessage:

```jsonc
{
  "name": "Morning briefing",
  "schedule": "0 8 * * *",
  "message": "Give me a summary of today's tasks",
  "delivery": {
    "channel": "telegram",
    "to": "123456789"
  }
}
```

---

## File Structure

```
ReginaldOS/
├── SOUL.md                        ← system prompt (edit to change behaviour)
├── .env.example
├── package.json
├── tsconfig.json
│
├── skills/                          ← drop skill folders here
│   └── my-skill/
│       └── SKILL.md
│
├── src/
│   ├── index.ts                     ← entry point: wires all components
│   ├── config.ts                    ← typed env-var config
│   │
│   ├── gateway/
│   │   └── server.ts                ← HTTP + WebSocket hub
│   │
│   ├── agent/
│   │   ├── loop.ts                  ← agentic loop (Claude streaming + tools)
│   │   ├── systemPrompt.ts          ← reads + caches SOUL.md
│   │   └── tools/
│   │       ├── index.ts             ← TOOL_DEFINITIONS + createDispatcher()
│   │       ├── bash.ts
│   │       ├── readFile.ts
│   │       ├── writeFile.ts
│   │       ├── webFetch.ts
│   │       ├── memorySearch.ts
│   │       ├── skillRead.ts
│   │       └── cron.ts
│   │
│   ├── skills/
│   │   └── loader.ts                ← scans SKILLS_DIR for SKILL.md folders
│   │
│   ├── canvas/
│   │   ├── index.ts                 ← broadcast singleton
│   │   └── static/
│   │       └── index.html           ← Canvas shell served to browser
│   │
│   ├── sessions/
│   │   ├── types.ts                 ← Session, StoredMessage interfaces
│   │   └── manager.ts               ← load / save JSON session files
│   │
│   ├── memory/
│   │   └── store.ts                 ← SQLite FTS5 store
│   │
│   ├── scheduler/
│   │   ├── store.ts                 ← persisted JSON job store
│   │   └── runner.ts                ← cron tick + job execution
│   │
│   ├── delivery/
│   │   └── index.ts                 ← Telegram + iMessage delivery helpers
│   │
│   └── channels/
│       ├── telegram/
│       │   └── bot.ts               ← grammy long-poll adapter
│       └── imessage/
│           └── bot.ts               ← SQLite polling + AppleScript sender
│
└── data/                            ← created at runtime (gitignored)
    ├── memory.db
    ├── cron/
    │   └── jobs.json
    └── sessions/
        ├── main.json
        ├── a3f1c2d4-....json
        ├── telegram:123456789.json
        └── imessage:+15551234567.json
```

---

## Extending

### Add a tool

1. Create `src/agent/tools/myTool.ts` — export an async function
2. Add its JSON schema to `TOOL_DEFINITIONS` in `src/agent/tools/index.ts`
3. Add a `case "my_tool":` branch in the `dispatch` switch

### Add a channel

Channels call `runAgentLoop(session, userText, memory, callbacks)` and handle the callbacks. See `src/channels/telegram/bot.ts` as the reference. Key points:

- Use a per-context session ID scheme (e.g. `myapp:<userId>`)
- Guard against concurrent turns on the same session with a `Set<string>`
- Persist the session with `sessions.save(session)` in `onDone`

### Add a skill

1. Create a folder under `./skills/my-skill/`
2. Add a `SKILL.md` with frontmatter `name` and `description` fields
3. Write instructions in the body — tell the agent which tools to call and how
4. Restart ReginaldOS
