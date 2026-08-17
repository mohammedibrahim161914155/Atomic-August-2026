import { randomUUID, createHash } from 'crypto';
import crypto from 'crypto';
import { getStore } from './store';
import type { KVStore } from './store';
import { log } from './logger';

const UUID_RE = 
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

export async function saveCheckpoint(sessionId: string, key: string, data: unknown): Promise<void> {
  const store = await getStore();
  await store.set(`ck:${sessionId}:${key}`, JSON.stringify(data));
}

export async function loadCheckpoint<T>(sessionId: string, key: string): Promise<T | null> {
  const store = await getStore();
  const raw = await store.get(`ck:${sessionId}:${key}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function checkpointExists(sessionId: string, key: string): Promise<boolean> {
  const store = await getStore();
  return store.exists(`ck:${sessionId}:${key}`);
}

export async function saveMeta(sessionId: string, meta: import('./types').SessionMeta): Promise<void> {
  const store = await getStore();
  await store.set(`meta:${sessionId}`, JSON.stringify(meta));
}

export async function loadMeta(sessionId: string): Promise<import('./types').SessionMeta | null> {
  const store = await getStore();
  const raw = await store.get(`meta:${sessionId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as import('./types').SessionMeta; } catch { return null; }
}

export async function listSessions(): Promise<import('./types').SessionMeta[]> {
  const store = await getStore();
  const keys = await store.keys('meta:*');
  // Limit to 50 most-recently-created sessions to avoid loading the entire store
  const results = await Promise.all(keys.map(k => store.get(k)));
  return results
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r!); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 50);
}

export async function verifySessionToken(sessionId: string, token: string): Promise<boolean> {
  if (!token || typeof token !== 'string') return false;
  const meta = await loadMeta(sessionId);
  if (!meta?.session_token) return false;
  
  const incomingHash = createHash('sha256').update(token).digest('hex');
  const a = Buffer.from(meta.session_token);
  const b = Buffer.from(incomingHash);
  
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const store = await getStore();
  const keys = await store.keys(`ck:${sessionId}:*`);
  await Promise.all([...keys.map(k => store.del(k)), store.del(`meta:${sessionId}`)]);
}

interface Pruneable {
  pruneExpired(): number | Promise<number>;
}

function isPruneable(store: KVStore): store is KVStore & Pruneable {
  return typeof (store as any)?.pruneExpired === 'function';
}

export async function pruneOldSessions(_maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  // Redis auto-expires via TTL. For SQLite fallback, run an explicit DELETE pass.
  const store = await getStore();
  if (isPruneable(store)) {
    const pruned = await store.pruneExpired();
    if (pruned > 0) {
      log.info({ pruned }, '[store] pruned expired SQLite keys');
    }
    return pruned;
  }
  return 0;
}

export function generateSessionId(): string { return randomUUID(); }
