import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { KVStore } from './store';

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  
  try {
    const DB_DIR = process.env.SESSIONS_DIR ?? path.join(os.homedir(), '.atomic', 'sessions');
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

    dbInstance = new Database(path.join(DB_DIR, 'kv.sqlite'));
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('busy_timeout = 5000');    // wait up to 5 s on write lock (multi-process safe)
    dbInstance.pragma('cache_size = -32000');    // 32 MB page cache
    dbInstance.pragma('synchronous = NORMAL');   // safe + fast (WAL makes this safe)
    dbInstance.pragma('foreign_keys = ON');      // referential integrity
    dbInstance.pragma('temp_store = MEMORY');    // temp tables in RAM
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        ttl INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_kv_ttl ON kv(ttl) WHERE ttl IS NOT NULL;
    `);
    
    return dbInstance;
  } catch (error) {
    console.error("Failed to initialize SQLite database:", error);
    throw error;
  }
}

export class SqliteStore implements KVStore {
  async get(key: string) {
    const db = getDb();
    const row = db.prepare('SELECT value, ttl FROM kv WHERE key = ?').get(key) as any;
    if (!row) return null;
    if (row.ttl && Date.now() > row.ttl) {
      db.prepare('DELETE FROM kv WHERE key = ?').run(key);
      return null;
    }
    return row.value;
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    const db = getDb();
    const ttl = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    db.prepare('INSERT INTO kv (key,value,ttl) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ttl=excluded.ttl').run(key, value, ttl);
  }

  async del(key: string) { getDb().prepare('DELETE FROM kv WHERE key=?').run(key); }

  async exists(key: string) {
    const now = Date.now();
    return !!getDb().prepare('SELECT 1 FROM kv WHERE key=? AND (ttl IS NULL OR ttl > ?)').get(key, now);
  }

  async keys(pattern: string) {
    const like = pattern.replace(/\*/g, '%');
    const now = Date.now();
    const rows = getDb().prepare('SELECT key FROM kv WHERE key LIKE ? AND (ttl IS NULL OR ttl > ?)').all(like, now) as any[];
    return rows.map(r => r.key);
  }

  async incr(key: string): Promise<number> {
    const db = getDb();
    const row = db.prepare(`
      INSERT INTO kv (key, value, ttl) VALUES (?, '1', NULL)
      ON CONFLICT(key) DO UPDATE
      SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      RETURNING value
    `).get(key) as { value: string } | undefined;
    return parseInt(row?.value ?? '1', 10);
  }

  async incrBy(key: string, amount: number): Promise<number> {
    const db = getDb();
    const row = db.prepare(`
      INSERT INTO kv (key, value, ttl) VALUES (?, CAST(? AS TEXT), NULL)
      ON CONFLICT(key) DO UPDATE
      SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)
      RETURNING value
    `).get(key, amount, amount) as { value: string } | undefined;
    return parseInt(row?.value ?? String(amount), 10);
  }

  async decr(key: string): Promise<number> {
    const db = getDb();
    const row = db.prepare(`
      INSERT INTO kv (key, value, ttl) VALUES (?, '0', NULL)
      ON CONFLICT(key) DO UPDATE
      SET value = CAST(MAX(0, CAST(value AS INTEGER) - 1) AS TEXT)
      RETURNING value
    `).get(key) as { value: string } | undefined;
    return parseInt(row?.value ?? '0', 10);
  }

  async expire(key: string, seconds: number) {
    const row = getDb().prepare('SELECT value FROM kv WHERE key=?').get(key) as any;
    if (row) await this.set(key, row.value, seconds);
  }

  pruneExpired(): number {
    const result = getDb().prepare('DELETE FROM kv WHERE ttl IS NOT NULL AND ttl < ?').run(Date.now());
    return result.changes;
  }
}
