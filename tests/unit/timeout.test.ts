import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from '../../src/resilience/timeout.js';
import { TimeoutError } from '../../src/utils/errors.js';

describe('withTimeout', () => {
  it('returns result if operation completes within timeout', async () => {
    const fn = async (x: number): Promise<number> => x * 2;
    const wrapped = withTimeout(fn, 1000, 'test-op');

    const result = await wrapped(5);
    expect(result).toBe(10);
  });

  it('throws TimeoutError if operation exceeds timeout', async () => {
    const fn = async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 'done';
    };
    const wrapped = withTimeout(fn, 50, 'slow-op');

    await expect(wrapped()).rejects.toThrow(TimeoutError);
    await expect(wrapped()).rejects.toThrow('slow-op timed out after 50ms');
  });

  it('preserves the TimeoutError properties', async () => {
    const fn = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    };
    const wrapped = withTimeout(fn, 10, 'my-op');

    try {
      await wrapped();
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TimeoutError);
      expect((error as TimeoutError).timeoutMs).toBe(10);
      expect((error as TimeoutError).operation).toBe('my-op');
    }
  });

  it('passes through arguments to the wrapped function', async () => {
    const fn = vi.fn(async (a: string, b: number): Promise<string> => `${a}-${b}`);
    const wrapped = withTimeout(fn, 1000, 'args-op');

    const result = await wrapped('hello', 42);
    expect(result).toBe('hello-42');
    expect(fn).toHaveBeenCalledWith('hello', 42);
  });

  it('propagates errors from the wrapped function (not TimeoutError)', async () => {
    const fn = async (): Promise<void> => {
      throw new Error('inner failure');
    };
    const wrapped = withTimeout(fn, 1000, 'err-op');

    await expect(wrapped()).rejects.toThrow('inner failure');
    await expect(wrapped()).rejects.not.toBeInstanceOf(TimeoutError);
  });

  it('uses default operation name when not provided', async () => {
    const fn = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    };
    const wrapped = withTimeout(fn, 10);

    await expect(wrapped()).rejects.toThrow('unknown timed out after 10ms');
  });
});
