import Redis from 'ioredis';
import type { KVStore } from './store';

export class RedisStore implements KVStore {
  private client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    this.client.on('error', (err) => {
      console.error('[redis] connection error:', err.message);
    });
  }

  async get(key: string) { return this.client.get(key); }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string) { await this.client.del(key); }

  async exists(key: string) {
    return (await this.client.exists(key)) === 1;
  }

  async keys(pattern: string): Promise<string[]> {
    const results: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor, 'MATCH', pattern, 'COUNT', 100
      );
      results.push(...keys);
      cursor = nextCursor;
    } while (cursor !== '0');
    return results;
  }

  async incr(key: string) { return this.client.incr(key); }
  async incrBy(key: string, amount: number) { return this.client.incrby(key, amount); }

  async decr(key: string) { return this.client.decr(key); }

  async expire(key: string, seconds: number) {
    await this.client.expire(key, seconds);
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
