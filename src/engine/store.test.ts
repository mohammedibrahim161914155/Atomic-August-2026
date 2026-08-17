import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SqliteStore } from './store.sqlite';
import { RedisStore } from './store.redis';
import { randomBytes } from 'crypto';

// Run the same test suite against both backends
function kvTests(name: string, makeStore: () => any) {
  describe(name, () => {
    let store: any;
    let p: string;
    beforeEach(() => { 
      store = makeStore(); 
      p = randomBytes(4).toString('hex') + '_';
    });

    it('set and get round-trips correctly', async () => {
      await store.set(p+'k1', 'hello');
      expect(await store.get(p+'k1')).toBe('hello');
    });

    it('returns null for missing key', async () => {
      expect(await store.get(p+'nonexistent')).toBeNull();
    });

    it('del removes key', async () => {
      await store.set(p+'k2', 'val');
      await store.del(p+'k2');
      expect(await store.get(p+'k2')).toBeNull();
    });

    it('exists returns correct boolean', async () => {
      await store.set(p+'k3', 'v');
      expect(await store.exists(p+'k3')).toBe(true);
      expect(await store.exists(p+'missing')).toBe(false);
    });

    it('incr and decr work atomically', async () => {
      expect(await store.incr(p+'counter')).toBe(1);
      expect(await store.incr(p+'counter')).toBe(2);
      expect(await store.decr(p+'counter')).toBe(1);
    });

    it('incrBy accumulates correctly', async () => {
      expect(await store.incrBy(p + 'cost', 500)).toBe(500);
      expect(await store.incrBy(p + 'cost', 300)).toBe(800);
    });

    it('incrBy on a non-existent key starts from zero', async () => {
      expect(await store.incrBy(p + 'fresh', 1_000_000)).toBe(1_000_000);
    });

    it('TTL expires key', async () => {
      await store.set(p+'expiring', 'val', 0.001); // 1ms
      await new Promise(r => setTimeout(r, 5));
      expect(await store.get(p+'expiring')).toBeNull();
    });
  });
}

kvTests('SqliteStore', () => new SqliteStore());
if (process.env.TEST_REDIS_URL) {
  kvTests('RedisStore', () => new RedisStore(process.env.TEST_REDIS_URL!));
}

describe('getStore initialisation branches', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.REDIS_URL;
    vi.resetModules(); 
    // Need to clear the internal state of store.ts
    // but the getStore logic caches the result. We can import it freshly.
  });

  afterEach(() => {
    process.env.REDIS_URL = originalEnv;
  });

  it('falls back to SQLite if Redis fails during init', async () => {
    process.env.REDIS_URL = 'redis://invalid:1234';
    
    // We mock the RedisStore constructor to throw during init logic
    vi.doMock('./store.redis', () => {
      return {
        RedisStore: class {
          constructor() { throw new Error('Redis down'); }
          disconnect() {}
        }
      };
    });

    const freshStore = await import('./store');
    // Call getStore, it should catch the error and fallback to sqlite
    const instance = await freshStore.getStore();
    expect(instance.constructor.name).toBe('SqliteStore');
    vi.doUnmock('./store.redis');
  });
});
