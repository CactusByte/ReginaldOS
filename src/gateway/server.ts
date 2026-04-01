import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { exec, spawn } from "node:child_process"
import { WebSocketServer, WebSocket } from "ws"
import { runAgentLoop } from "../agent/loop.js"
import { registerClient } from "../canvas/index.js"
import type { SessionManager } from "../sessions/manager.js"
import type { MemoryStore } from "../memory/store.js"
import type { AstroManager } from "../astro/manager.js"

const CANVAS_HTML_PATH = join(process.cwd(), "src/canvas/static/index.html")
const ASTRO_BIN = join(process.cwd(), "node_modules", ".bin", "astro")

export function createGateway(
  sessions: SessionManager,
  memory: MemoryStore,
  astro: AstroManager,
  port: number
): void {
  const canvasHtml = readFileSync(CANVAS_HTML_PATH, "utf-8")

  // ── HTTP server ──────────────────────────────────────────────────────────────
  const httpServer = createHttpServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(canvasHtml)
    } else if (req.url?.startsWith("/export/")) {
      const sessionId = decodeURIComponent(req.url.slice("/export/".length))
      const projectDir = astro.projectDir(sessionId)
      if (!existsSync(projectDir)) {
        res.writeHead(404); res.end("No project for this session"); return
      }
      exec(
        `"${ASTRO_BIN}" build --root "${projectDir}"`,
        { timeout: 300_000 },
        (err) => {
          if (err) { res.writeHead(500); res.end(`Build failed: ${err.message}`); return }
          const distDir = join(projectDir, "dist")
          if (!existsSync(distDir)) {
            res.writeHead(500); res.end("Build output not found"); return
          }
          res.writeHead(200, {
            "Content-Type": "application/gzip",
            "Content-Disposition": `attachment; filename="site.tar.gz"`,
          })
          const tar = spawn("tar", ["-czf", "-", "-C", distDir, "."])
          tar.stdout.pipe(res)
          tar.on("error", () => res.end())
        }
      )
    } else {
      res.writeHead(404); res.end("Not found")
    }
  })

  // ── WebSocket server (same port, upgrade) ────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
    } else {
      socket.destroy()
    }
  })

  const running = new Set<string>()
  // Sessions that already have Astro started (so we don't re-send project_ready on every turn)
  const astroReady = new Set<string>()

  function sendWs(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  // ── Run an agent turn, streaming back to `ws` ────────────────────────────────
  async function runTurn(ws: WebSocket, sessionId: string, userText: string): Promise<void> {
    if (running.has(sessionId)) {
      sendWs(ws, { type: "error", message: "Agent is already running — please wait." })
      return
    }
    running.add(sessionId)
    const session = sessions.getOrCreate(sessionId)
    try {
      await runAgentLoop(session, userText, memory, {
        onToken: (delta) => sendWs(ws, { type: "token", delta }),
        onToolStart: (id, name, input) =>
          sendWs(ws, { type: "tool_start", toolCallId: id, name, input }),
        onToolEnd: (id, name, result, isError) => {
          sendWs(ws, { type: "tool_result", toolCallId: id, name, result, isError })
          // Start Astro lazily the first time the agent uses project_info
          if (name === "project_info" && !isError && !astroReady.has(sessionId)) {
            astroReady.add(sessionId)
            sendWs(ws, { type: "project_starting" })
            astro.getOrStart(sessionId)
              .then(({ port: astroPort }) => {
                sendWs(ws, { type: "project_ready", url: `http://localhost:${astroPort}`, sessionId })
              })
              .catch((err: Error) => {
                astroReady.delete(sessionId) // allow retry on next project_info
                sendWs(ws, { type: "error", message: `Failed to start preview: ${err.message}` })
              })
          }
        },
        onRetry: (attempt) =>
          sendWs(ws, { type: "stream_reset", attempt }),
        onCompaction: () =>
          sendWs(ws, { type: "compaction" }),
        onDone: () => {
          sessions.save(session)
          sendWs(ws, { type: "turn_end" })
        },
        onError: (err) => sendWs(ws, { type: "error", message: err.message }),
      })
    } finally {
      running.delete(sessionId)
    }
  }

  // ── Connection handler ────────────────────────────────────────────────────────
  wss.on("connection", (ws: WebSocket) => {
    registerClient(ws)

    ws.on("message", async (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.type === "init" && typeof msg.sessionId === "string") {
        // If Astro was already started for this session (e.g. page reload), re-send project_ready
        if (astroReady.has(msg.sessionId)) {
          astro.getOrStart(msg.sessionId)
            .then(({ port: astroPort }) => {
              sendWs(ws, { type: "project_ready", url: `http://localhost:${astroPort}`, sessionId: msg.sessionId as string })
            })
            .catch(() => { /* server no longer running — let user re-trigger */ })
        }
        // Otherwise do nothing — chat-only until the agent uses project_info
      } else if (
        msg.type === "chat" &&
        typeof msg.text === "string" &&
        typeof msg.sessionId === "string"
      ) {
        await runTurn(ws, msg.sessionId, msg.text)
      }
    })
  })

  httpServer.listen(port, () => {
    console.log(`Canvas  →  http://localhost:${port}`)
  })
}
