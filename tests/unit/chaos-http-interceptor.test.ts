import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChaosController } from '../../src/chaos/controller.js';
import { createChaosAwareFetch } from '../../src/chaos/interceptors/http-interceptor.js';

describe('createChaosAwareFetch', () => {
  let controller: ChaosController;

  beforeEach(() => {
    process.env['CHAOS_ENABLED'] = 'true';
    process.env['NODE_ENV'] = 'test';
    ChaosController.reset();
    controller = ChaosController.getInstance();
  });

  afterEach(() => {
    ChaosController.reset();
  });

  it('calls original fetch when no fault is active', async () => {
    const mockFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const chaosAwareFetch = createChaosAwareFetch('weather-api', mockFetch);

    const response = await chaosAwareFetch('http://example.com');
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  describe('latency fault', () => {
    it('delays then calls real fetch', async () => {
      vi.useFakeTimers();
      const mockFetch = vi.fn(async () => new Response('ok', { status: 200 }));
      const chaosAwareFetch = createChaosAwareFetch('weather-api', mockFetch);

      controller.inject('weather-api', { type: 'latency', delayMs: 500 });

      const promise = chaosAwareFetch('http://example.com');
      await vi.advanceTimersByTimeAsync(600);
      const response = await promise;

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });
  });

  describe('error fault', () => {
    it('returns a fake response with the status code', async () => {
      const mockFetch = vi.fn();
      const chaosAwareFetch = createChaosAwareFetch('weather-api', mockFetch);

      controller.inject('weather-api', { type: 'error', statusCode: 503, message: 'Service down' });

      const response = await chaosAwareFetch('http://example.com');
      expect(response.status).toBe(503);

      const body = await response.json() as { error: string };
      expect(body.error).toBe('Service down');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('uses default message when none provided', async () => {
      const mockFetch = vi.fn();
      const chaosAwareFetch = createChaosAwareFetch('weather-api', mockFetch);

      controller.inject('weather-api', { type: 'error', statusCode: 500 });

      const response = await chaosAwareFetch('http://example.com');
      const body = await response.json() as { error: string };
      expect(body.error).toBe('Chaos injected error');
    });
  });

  describe('timeout fault', () => {
    it('hangs then throws AbortError', async () => {
      const mockFetch = vi.fn();
      const chaosAwareFetch = createChaosAwareFetch('weather-api', mockFetch);

      controller.inject('weather-api', { type: 'timeout', hangMs: 10 });

      await expect(chaosAwareFetch('http://example.com')).rejects.toThrow(
        'The operation was aborted',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('connection-refused fault', () => {
    it('throws TypeError', async () => {
      const mockFetch = vi.fn();
      const chaosAwareFetch = createChaosAwareFetch('weather-api', mockFetch);

      controller.inject('weather-api', { type: 'connection-refused' });

      await expect(chaosAwareFetch('http://example.com')).rejects.toThrow(TypeError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('rate-limit fault', () => {
    it('returns 429 with Retry-After header', async () => {
      const mockFetch = vi.fn();
      const chaosAwareFetch = createChaosAwareFetch('flight-api', mockFetch);

      controller.inject('flight-api', { type: 'rate-limit', retryAfterSeconds: 60 });

      const response = await chaosAwareFetch('http://example.com');
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('malformed fault', () => {
    it('returns corrupted non-JSON body with 200 status', async () => {
      const mockFetch = vi.fn();
      const chaosAwareFetch = createChaosAwareFetch('weather-mcp', mockFetch);

      controller.inject('weather-mcp', { type: 'malformed', corruptResponse: true });

      const response = await chaosAwareFetch('http://example.com');
      expect(response.status).toBe(200);

      const text = await response.text();
      expect(text).toContain('CORRUPTED');
      expect(() => JSON.parse(text)).toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('schema-mismatch fault', () => {
    it('calls real fetch then strips fields', async () => {
      const original = { city: 'NYC', temperature: 72, humidity: 45 };
      const mockFetch = vi.fn(async () =>
        new Response(JSON.stringify(original), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const chaosAwareFetch = createChaosAwareFetch('weather-api', mockFetch);

      controller.inject('weather-api', {
        type: 'schema-mismatch',
        missingFields: ['temperature', 'humidity'],
      });

      const response = await chaosAwareFetch('http://example.com');
      const body = await response.json() as Record<string, unknown>;

      expect(body['city']).toBe('NYC');
      expect(body['temperature']).toBeUndefined();
      expect(body['humidity']).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe('connection-drop fault', () => {
    it('starts real fetch then aborts mid-stream', async () => {
      const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        // Simulate a long-running response that respects abort signal
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException('The operation was aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
          // Never resolve — we'll get aborted
        });
      });
      const chaosAwareFetch = createChaosAwareFetch('weather-api', mockFetch);

      controller.inject('weather-api', { type: 'connection-drop' });

      await expect(chaosAwareFetch('http://example.com')).rejects.toThrow('aborted');
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });
});
