import { WebSocket } from "ws"

const clients = new Set<WebSocket>()

export function registerClient(ws: WebSocket): void {
  clients.add(ws)
  ws.on("close", () => clients.delete(ws))
}

export function broadcast(msg: object): void {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}
