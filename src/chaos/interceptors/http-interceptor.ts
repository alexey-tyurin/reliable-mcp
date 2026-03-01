import { ChaosController } from '../controller.js';
import type { FaultTarget, FaultConfig } from '../fault-types.js';
import { createLogger } from '../../observability/logger.js';

const logger = createLogger('chaos-http');

export function createChaosAwareFetch(
  target: FaultTarget,
  originalFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const controller = ChaosController.getInstance();
    const fault = controller.getFault(target);

    if (!fault) {
      return originalFetch(input, init);
    }

    logger.debug({ target, faultType: fault.type }, 'Chaos fault triggered');

    return applyFault(fault, input, init, originalFetch);
  };
}

async function applyFault(
  fault: FaultConfig,
  input: string | URL | Request,
  init: RequestInit | undefined,
  originalFetch: typeof globalThis.fetch,
): Promise<Response> {
  switch (fault.type) {
    case 'latency': {
      await delay(fault.delayMs);
      return originalFetch(input, init);
    }
    case 'error': {
      return new Response(
        JSON.stringify({ error: fault.message ?? 'Chaos injected error' }),
        { status: fault.statusCode, headers: { 'Content-Type': 'application/json' } },
      );
    }
    case 'timeout': {
      await delay(fault.hangMs);
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    case 'connection-refused': {
      throw new TypeError('fetch failed (chaos: connection refused)');
    }
    case 'rate-limit': {
      return new Response(
        JSON.stringify({ error: 'Too Many Requests' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(fault.retryAfterSeconds),
          },
        },
      );
    }
    case 'malformed': {
      return new Response(
        '<<<CORRUPTED_RESPONSE>>>{{{{not json',
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    case 'schema-mismatch': {
      const realResponse = await originalFetch(input, init);
      const body = await realResponse.json() as Record<string, unknown>;
      for (const field of fault.missingFields) {
        Reflect.deleteProperty(body, field);
      }
      return new Response(JSON.stringify(body), {
        status: realResponse.status,
        headers: realResponse.headers,
      });
    }
    case 'connection-drop': {
      const abortController = new AbortController();
      const mergedInit = { ...init, signal: abortController.signal };
      const fetchPromise = originalFetch(input, mergedInit);
      setTimeout(() => { abortController.abort(); }, 50);
      return fetchPromise;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
