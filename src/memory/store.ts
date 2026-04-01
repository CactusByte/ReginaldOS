import Database, { type Database as DB } from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export interface MemoryRow {
  id: number
  session_id: string
  content: string
  tags: string | null
  created_at: string
}

export class MemoryStore {
  private db: DB

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma("journal_mode = WAL")
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content    TEXT NOT NULL,
        tags       TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        tags,
        content='memories',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.id, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.id, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
      END;
    `)
  }

  search(query: string, limit = 10): MemoryRow[] {
    // Escape FTS5 special chars to avoid query parse errors
    const safe = query.replace(/["*^]/g, " ").trim()
    if (!safe) return []
    return this.db
      .prepare(
        `SELECT m.id, m.session_id, m.content, m.tags, m.created_at
         FROM memories m
         JOIN memories_fts f ON m.id = f.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(safe, limit) as MemoryRow[]
  }

  insert(sessionId: string, content: string, tags?: string): number {
    const result = this.db
      .prepare("INSERT INTO memories (session_id, content, tags) VALUES (?, ?, ?)")
      .run(sessionId, content, tags ?? null)
    return result.lastInsertRowid as number
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id)
  }

  listBySession(sessionId: string): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE session_id = ? ORDER BY created_at DESC")
      .all(sessionId) as MemoryRow[]
  }
}
