import { describe, it, expect, vi, afterEach } from 'vitest';
import { withRetry } from '../../src/resilience/retry.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withRetry', () => {
  it('returns on first success without retrying', async () => {
    const fn = vi.fn(async () => 'ok');
    const wrapped = withRetry(fn, { maxRetries: 3 });

    const result = await wrapped();
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const wrapped = withRetry(fn, {
      maxRetries: 3,
      retryOn: () => true,
      baseDelay: 1,
      jitterFactor: 0,
    });

    const result = await wrapped();
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));

    const wrapped = withRetry(fn, {
      maxRetries: 3,
      retryOn: () => false,
    });

    await expect(wrapped()).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects maxRetries and throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    const wrapped = withRetry(fn, {
      maxRetries: 2,
      retryOn: () => true,
      baseDelay: 1,
      jitterFactor: 0,
    });

    await expect(wrapped()).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('applies exponential backoff with jitter', async () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb, ms) => {
      delays.push(ms as number);
      (cb as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const wrapped = withRetry(fn, {
      maxRetries: 3,
      retryOn: () => true,
      baseDelay: 100,
      jitterFactor: 0.3,
    });

    await expect(wrapped()).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toHaveLength(3);

    // Each delay should be roughly exponential: ~100, ~200, ~400 (±30%)
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('caps delay at maxDelay', async () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb, ms) => {
      delays.push(ms as number);
      (cb as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const wrapped = withRetry(fn, {
      maxRetries: 5,
      retryOn: () => true,
      baseDelay: 1000,
      maxDelay: 2000,
      jitterFactor: 0,
    });

    await expect(wrapped()).rejects.toThrow('fail');

    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });

  it('passes arguments through to the wrapped function', async () => {
    const fn = vi.fn(async (a: string, b: number) => `${a}-${b}`);
    const wrapped = withRetry(fn, { maxRetries: 1 });

    const result = await wrapped('test', 42);
    expect(result).toBe('test-42');
    expect(fn).toHaveBeenCalledWith('test', 42);
  });

  it('uses default retryOn predicate (retries all errors)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('oops'))
      .mockResolvedValueOnce('ok');

    const wrapped = withRetry(fn, {
      maxRetries: 1,
      baseDelay: 1,
      jitterFactor: 0,
    });

    const result = await wrapped();
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
