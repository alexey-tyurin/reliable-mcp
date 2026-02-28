import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('createRedisClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates a Redis client with default URL', async () => {
    const { createRedisClient } = await import('../../src/config/redis.js');
    const client = createRedisClient();

    expect(client).toBeDefined();
    expect(typeof client.quit).toBe('function');
    expect(typeof client.get).toBe('function');
    expect(typeof client.set).toBe('function');

    await client.quit();
  });

  it('creates a Redis client with custom URL', async () => {
    const { createRedisClient } = await import('../../src/config/redis.js');
    const client = createRedisClient('redis://custom-host:6380');

    expect(client).toBeDefined();
    await client.quit();
  });

  it('configures reconnection strategy', async () => {
    const { createRedisClient } = await import('../../src/config/redis.js');
    const client = createRedisClient();

    expect(client.options.retryStrategy).toBeDefined();
    await client.quit();
  });

  it('retryStrategy returns increasing delays up to a max', async () => {
    const { createRedisClient } = await import('../../src/config/redis.js');
    const client = createRedisClient();

    const strategy = client.options.retryStrategy;
    expect(strategy).toBeDefined();

    if (strategy) {
      const delay1 = strategy(1);
      const delay2 = strategy(2);
      const delay3 = strategy(3);

      expect(typeof delay1).toBe('number');
      expect(typeof delay2).toBe('number');
      expect(typeof delay3).toBe('number');

      expect(delay1 as number).toBeLessThanOrEqual(delay2 as number);
      expect(delay2 as number).toBeLessThanOrEqual(delay3 as number);
    }

    await client.quit();
  });

  it('retryStrategy returns null after max retries', async () => {
    const { createRedisClient } = await import('../../src/config/redis.js');
    const client = createRedisClient();

    const strategy = client.options.retryStrategy;
    expect(strategy).toBeDefined();

    if (strategy) {
      const result = strategy(100);
      expect(result).toBeNull();
    }

    await client.quit();
  });
});
