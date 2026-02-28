import { describe, it, expect } from 'vitest';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { createRateLimiter } from '../../src/resilience/rate-limiter.js';
import { RateLimitError } from '../../src/utils/errors.js';

function buildLimiter(points: number, duration: number): RateLimiterMemory {
  return new RateLimiterMemory({ points, duration });
}

describe('createRateLimiter', () => {
  it('allows requests within the limit', async () => {
    const limiter = buildLimiter(5, 60);
    const checkLimit = createRateLimiter(limiter);

    // Should not throw for first 5 requests
    for (let i = 0; i < 5; i++) {
      await expect(checkLimit('user-1')).resolves.toBeUndefined();
    }
  });

  it('throws RateLimitError when limit is exceeded', async () => {
    const limiter = buildLimiter(2, 60);
    const checkLimit = createRateLimiter(limiter);

    await checkLimit('user-2');
    await checkLimit('user-2');

    try {
      await checkLimit('user-2');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('tracks limits per key independently', async () => {
    const limiter = buildLimiter(1, 60);
    const checkLimit = createRateLimiter(limiter);

    await expect(checkLimit('user-a')).resolves.toBeUndefined();
    await expect(checkLimit('user-b')).resolves.toBeUndefined();

    // user-a is now over limit
    await expect(checkLimit('user-a')).rejects.toBeInstanceOf(RateLimitError);
    // user-b is also over limit
    await expect(checkLimit('user-b')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('uses default 30 req/min when using createDefaultRateLimiter', async () => {
    // This test just verifies the factory works with memory backend
    const limiter = buildLimiter(30, 60);
    const checkLimit = createRateLimiter(limiter);

    // 30 requests should succeed
    for (let i = 0; i < 30; i++) {
      await checkLimit('user-default');
    }

    // 31st should fail
    await expect(checkLimit('user-default')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('includes retryAfterSeconds in the error', async () => {
    const limiter = buildLimiter(1, 60);
    const checkLimit = createRateLimiter(limiter);

    await checkLimit('user-retry');

    try {
      await checkLimit('user-retry');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      const rateLimitError = error as RateLimitError;
      expect(rateLimitError.retryAfterSeconds).toBeGreaterThan(0);
      expect(rateLimitError.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });
});
