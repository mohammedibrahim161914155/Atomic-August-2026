import { describe, it, expect, vi } from 'vitest';
import { RedisStore } from './store.redis';

vi.mock('ioredis', () => {
  return {
    default: class MockRedis {
      db = new Map<string, string>();

      get = async (k: string) => this.db.get(k) ?? null;

      set = async (k: string, v: string, _ex?: string, _ttl?: number) => {
        this.db.set(k, v);
        return 'OK' as const;
      };

      del = async (k: string) => { this.db.delete(k); return 1; };

      exists = async (k: string) => (this.db.has(k) ? 1 : 0);

      incr = async (k: string) => {
        const val = Number(this.db.get(k) ?? 0) + 1;
        this.db.set(k, String(val));
        return val;
      };

      incrby = async (k: string, n: number) => {
        const val = Number(this.db.get(k) ?? 0) + n;
        this.db.set(k, String(val));
        return val;
      };

      decr = async (k: string) => {
        const val = Number(this.db.get(k) ?? 0) - 1;
        this.db.set(k, String(val));
        return val;
      };

      expire = async (_k: string, _seconds: number) => 1;

      // Fix A: implement scan so keys() can be tested
      scan = async (cursor: string, _match: string, pattern: string, _count: string, _n: number): Promise<[string, string[]]> => {
        const prefix = pattern.replace(/\*/g, '');
        const matching = [...this.db.keys()].filter(k => k.startsWith(prefix));
        return ['0', matching]; // single page, cursor '0' signals end
      };

      on = () => {};

      quit = async () => 'OK' as const;
    },
  };
});

describe('RedisStore', () => {
  it('set and get round-trips correctly', async () => {
    const store = new RedisStore('test');
    await store.set('key1', 'hello');
    expect(await store.get('key1')).toBe('hello');
  });

  it('returns null for a missing key', async () => {
    const store = new RedisStore('test');
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('del removes a key', async () => {
    const store = new RedisStore('test');
    await store.set('key2', 'val');
    await store.del('key2');
    expect(await store.get('key2')).toBeNull();
  });

  it('exists returns correct boolean', async () => {
    const store = new RedisStore('test');
    await store.set('key3', 'v');
    expect(await store.exists('key3')).toBe(true);
    expect(await store.exists('missing')).toBe(false);
  });

  it('incr and decr work correctly', async () => {
    const store = new RedisStore('test');
    expect(await store.incr('counter')).toBe(1);
    expect(await store.incr('counter')).toBe(2);
    expect(await store.decr('counter')).toBe(1);
  });

  it('incrBy accumulates by the given amount', async () => {
    const store = new RedisStore('test');
    expect(await store.incrBy('cost', 500_000)).toBe(500_000);
    expect(await store.incrBy('cost', 300_000)).toBe(800_000);
  });

  // Fix A: keys() was untested because scan was missing from the mock
  it('keys() returns matching keys via scan cursor loop', async () => {
    const store = new RedisStore('test');
    await store.set('meta:session1', 'a');
    await store.set('meta:session2', 'b');
    await store.set('ck:session1:intent', 'c');

    const metaKeys = await store.keys('meta:*');
    expect(metaKeys).toContain('meta:session1');
    expect(metaKeys).toContain('meta:session2');
    expect(metaKeys).not.toContain('ck:session1:intent');
  });

  it('keys() does not return keys that merely contain the prefix mid-string', async () => {
    const store = new RedisStore('test');
    await store.set('meta:session1', 'a');
    await store.set('some:meta:session2', 'b'); // contains "meta:" but does not start with it

    const metaKeys = await store.keys('meta:*');
    expect(metaKeys).toContain('meta:session1');
    expect(metaKeys).not.toContain('some:meta:session2');
  });

  // Fix B: expire was untested because the mock lacked the method
  it('expire does not throw', async () => {
    const store = new RedisStore('test');
    await store.set('expkey', 'val');
    await expect(store.expire('expkey', 60)).resolves.not.toThrow();
  });

  it('set with TTL is accepted without error', async () => {
    const store = new RedisStore('test');
    await expect(store.set('ttlkey', 'value', 30)).resolves.not.toThrow();
  });
});
