import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChaosController } from '../../src/chaos/controller.js';
import { wrapRedisWithChaos } from '../../src/chaos/interceptors/redis-interceptor.js';

function createMockRedisClient() {
  return {
    get: vi.fn(async (_key: string) => 'value'),
    set: vi.fn(async (_key: string, _value: string) => 'OK'),
    del: vi.fn(async (_key: string) => 1),
    hget: vi.fn(async (_key: string, _field: string) => 'hvalue'),
    hset: vi.fn(async (_key: string, _field: string, _value: string) => 1),
    expire: vi.fn(async (_key: string, _seconds: number) => 1),
    ttl: vi.fn(async (_key: string) => 300),
    keys: vi.fn(async (_pattern: string) => ['key1', 'key2']),
    mget: vi.fn(async (..._keys: string[]) => ['v1', 'v2']),
  };
}

type MockRedisClient = ReturnType<typeof createMockRedisClient>;

describe('wrapRedisWithChaos', () => {
  let controller: ChaosController;
  let client: MockRedisClient;

  beforeEach(() => {
    process.env['CHAOS_ENABLED'] = 'true';
    process.env['NODE_ENV'] = 'test';
    ChaosController.reset();
    controller = ChaosController.getInstance();
    client = createMockRedisClient();
  });

  afterEach(() => {
    ChaosController.reset();
  });

  it('passes through to original when no fault is active', async () => {
    const originalGet = client.get;
    const unwrap = wrapRedisWithChaos(client as never, 'redis');

    const result = await client.get('mykey');
    expect(result).toBe('value');
    expect(originalGet).toHaveBeenCalledWith('mykey');

    unwrap();
  });

  it('unwrap restores original methods', async () => {
    const originalGet = client.get;
    const unwrap = wrapRedisWithChaos(client as never, 'redis');

    // Method has been wrapped
    expect(client.get).not.toBe(originalGet);

    unwrap();

    // Method restored
    expect(client.get).toBe(originalGet);
  });

  describe('latency fault', () => {
    it('delays then calls original command', async () => {
      const unwrap = wrapRedisWithChaos(client as never, 'redis');
      controller.inject('redis', { type: 'latency', delayMs: 10 });

      const start = Date.now();
      const result = await client.get('mykey');
      const elapsed = Date.now() - start;

      expect(result).toBe('value');
      expect(elapsed).toBeGreaterThanOrEqual(8);

      unwrap();
    });
  });

  describe('error fault', () => {
    it('throws an error instead of calling original', async () => {
      const unwrap = wrapRedisWithChaos(client as never, 'redis');
      controller.inject('redis', { type: 'error', statusCode: 500, message: 'Redis crashed' });

      await expect(client.get('mykey')).rejects.toThrow('Redis crashed');

      unwrap();
    });

    it('uses default message when none provided', async () => {
      const unwrap = wrapRedisWithChaos(client as never, 'redis');
      controller.inject('redis', { type: 'error', statusCode: 500 });

      await expect(client.set('k', 'v')).rejects.toThrow('connection lost');

      unwrap();
    });
  });

  describe('timeout fault', () => {
    it('hangs then throws timeout error', async () => {
      const unwrap = wrapRedisWithChaos(client as never, 'redis');
      controller.inject('redis', { type: 'timeout', hangMs: 10 });

      await expect(client.del('mykey')).rejects.toThrow('Chaos Redis timeout');

      unwrap();
    });
  });

  describe('connection-refused fault', () => {
    it('throws connection refused error', async () => {
      const unwrap = wrapRedisWithChaos(client as never, 'redis');
      controller.inject('redis', { type: 'connection-refused' });

      await expect(client.hget('key', 'field')).rejects.toThrow(
        'Redis connection refused (chaos)',
      );

      unwrap();
    });
  });

  it('wraps all expected commands', async () => {
    const unwrap = wrapRedisWithChaos(client as never, 'redis');
    controller.inject('redis', { type: 'connection-refused' });

    const commands = ['get', 'set', 'del', 'hget', 'hset', 'expire', 'ttl', 'keys', 'mget'] as const;

    for (const cmd of commands) {
      await expect(
        (Reflect.get(client, cmd) as (...args: unknown[]) => Promise<unknown>)('arg'),
      ).rejects.toThrow('Redis connection refused (chaos)');
    }

    unwrap();
  });

  it('uses the specified target for fault lookup', async () => {
    const unwrap = wrapRedisWithChaos(client as never, 'redis-cache');
    controller.inject('redis-cache', { type: 'connection-refused' });

    await expect(client.get('mykey')).rejects.toThrow('Redis connection refused (chaos)');

    // Fault on 'redis' target should not affect 'redis-cache' wrapped client
    controller.clearAll();
    controller.inject('redis', { type: 'connection-refused' });

    const result = await client.get('mykey');
    expect(result).toBe('value');

    unwrap();
  });
});
