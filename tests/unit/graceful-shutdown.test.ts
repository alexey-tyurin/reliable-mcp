import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createShutdownRegistry,
} from '../../src/utils/graceful-shutdown.js';

describe('ShutdownRegistry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers and runs cleanup functions in reverse order', async () => {
    const order: string[] = [];
    const registry = createShutdownRegistry();

    registry.register('first', async () => {
      order.push('first');
    });
    registry.register('second', async () => {
      order.push('second');
    });
    registry.register('third', async () => {
      order.push('third');
    });

    await registry.shutdown();

    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('continues shutting down even if one cleanup throws', async () => {
    const order: string[] = [];
    const registry = createShutdownRegistry();

    registry.register('good-first', async () => {
      order.push('good-first');
    });
    registry.register('bad', async () => {
      throw new Error('cleanup failed');
    });
    registry.register('good-last', async () => {
      order.push('good-last');
    });

    await registry.shutdown();

    expect(order).toEqual(['good-last', 'good-first']);
  });

  it('prevents duplicate shutdown calls', async () => {
    let callCount = 0;
    const registry = createShutdownRegistry();

    registry.register('counter', async () => {
      callCount++;
    });

    await registry.shutdown();
    await registry.shutdown();

    expect(callCount).toBe(1);
  });

  it('returns registered resource names', () => {
    const registry = createShutdownRegistry();

    registry.register('redis', () => Promise.resolve());
    registry.register('http-server', () => Promise.resolve());

    expect(registry.getRegisteredNames()).toEqual(['redis', 'http-server']);
  });

  it('enforces shutdown timeout', async () => {
    const registry = createShutdownRegistry(100);

    registry.register('slow', () =>
      new Promise((resolve) => setTimeout(resolve, 5000))
    );

    const start = Date.now();
    await registry.shutdown();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });
});
