// src/engine/store.ts
// Abstract key-value store — Redis in production, SQLite in local dev.

import { log } from './logger';

export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  keys(pattern: string): Promise<string[]>;
  incr(key: string): Promise<number>;
  incrBy(key: string, amount: number): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

let _store: KVStore | null = null;
let _initPromise: Promise<KVStore> | null = null;

export async function getStore(): Promise<KVStore> {
  // Return already-initialised store immediately.
  if (_store) return _store;

  // Coalesce concurrent calls during startup into a single init flight.
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // If REDIS_URL is set, attempt Redis first.
    if (process.env.REDIS_URL) {
      let candidate: import('./store.redis').RedisStore | null = null;
      try {
        const { RedisStore } = await import('./store.redis');
        candidate = new RedisStore(process.env.REDIS_URL);
        await candidate.set('health:init', '1', 10);
        _store = candidate;
        log.info('[store] Redis connection established');
        return _store;
      } catch (err) {
        // Cleanly close the failed candidate before falling through to SQLite.
        try { await candidate?.disconnect(); } catch { /* ignore */ }
        log.error({ err }, '[store] Redis connection failed — using SQLite fallback');
      }
    }

    // SQLite fallback.
    const { SqliteStore } = await import('./store.sqlite');
    _store = new SqliteStore();
    log.warn('[store] Using SQLite — sessions will not persist across replicas');
    return _store;
  })();

  return _initPromise;
}
