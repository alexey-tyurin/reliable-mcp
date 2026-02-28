import { describe, it, expect, vi } from 'vitest';
import { createCircuitBreaker } from '../../src/resilience/circuit-breaker.js';
import { CircuitOpenError } from '../../src/utils/errors.js';

describe('createCircuitBreaker', () => {
  it('stays closed on success and returns result', async () => {
    const fn = vi.fn(async (x: number) => x * 2);
    const wrapped = createCircuitBreaker(fn, { name: 'test-cb' });

    const result = await wrapped(5);
    expect(result).toBe(10);
    expect(fn).toHaveBeenCalledWith(5);
  });

  it('passes arguments through to the wrapped function', async () => {
    const fn = vi.fn(async (a: string, b: number) => `${a}-${b}`);
    const wrapped = createCircuitBreaker(fn, { name: 'args-cb' });

    const result = await wrapped('hello', 42);
    expect(result).toBe('hello-42');
  });

  it('propagates errors from the wrapped function when closed', async () => {
    const fn = vi.fn(async () => {
      throw new Error('upstream fail');
    });
    const wrapped = createCircuitBreaker(fn, {
      name: 'err-cb',
      volumeThreshold: 10, // high threshold so circuit stays closed
    });

    await expect(wrapped()).rejects.toThrow('upstream fail');
  });

  it('opens after threshold failures and rejects with CircuitOpenError', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fail');
    });
    const wrapped = createCircuitBreaker(fn, {
      name: 'trip-cb',
      volumeThreshold: 2,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });

    // Trigger enough failures to trip the breaker
    for (let i = 0; i < 3; i++) {
      try {
        await wrapped();
      } catch {
        // expected
      }
    }

    // Next call should be rejected with CircuitOpenError
    try {
      await wrapped();
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitOpenError);
      expect((error as CircuitOpenError).circuitName).toBe('trip-cb');
    }
  });

  it('rejects immediately when open (does not call the function)', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fail');
    });
    const wrapped = createCircuitBreaker(fn, {
      name: 'no-call-cb',
      volumeThreshold: 1,
      errorThresholdPercentage: 1,
      resetTimeout: 60000,
    });

    // Trip it
    for (let i = 0; i < 3; i++) {
      try {
        await wrapped();
      } catch {
        // expected
      }
    }

    const callCountBefore = fn.mock.calls.length;
    await expect(wrapped()).rejects.toBeInstanceOf(CircuitOpenError);
    // Function should NOT have been called again
    expect(fn).toHaveBeenCalledTimes(callCountBefore);
  });

  it('transitions to half-open after reset timeout and closes on success', async () => {
    vi.useFakeTimers();

    // With volumeThreshold: 1, circuit opens after first failure.
    // Only call 1 reaches fn; calls while open skip fn entirely.
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('recovered');

    const wrapped = createCircuitBreaker(fn, {
      name: 'halfopen-cb',
      volumeThreshold: 1,
      errorThresholdPercentage: 1,
      resetTimeout: 5000,
    });

    // Trip the circuit (1 call is enough with volumeThreshold: 1)
    await expect(wrapped()).rejects.toThrow('fail');

    // Should be open now
    await expect(wrapped()).rejects.toBeInstanceOf(CircuitOpenError);

    // Advance past reset timeout
    await vi.advanceTimersByTimeAsync(6000);

    // Should be half-open now, next call goes through and succeeds
    const result = await wrapped();
    expect(result).toBe('recovered');

    vi.useRealTimers();
  });

  it('uses default configuration when no options provided', async () => {
    const fn = vi.fn(async () => 'ok');
    const wrapped = createCircuitBreaker(fn, { name: 'default-cb' });

    const result = await wrapped();
    expect(result).toBe('ok');
  });
});
