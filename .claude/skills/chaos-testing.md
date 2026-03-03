# Skill: Chaos Testing (Lightweight Fault Injection)

Use this pattern when building, extending, or running chaos tests for this project. The chaos framework validates that all resilience patterns (circuit breakers, retries, timeouts, graceful degradation) actually work under failure conditions.

## Architecture

The chaos framework is a **lightweight, dev/test-only** fault injection layer that sits between the resilience wrappers and the actual service calls. It intercepts calls at the transport/client level and injects configurable failures.

```
┌─────────────────────────────────────────────────────────────┐
│  Normal call path                                           │
│                                                             │
│  Agent → Circuit Breaker → Retry → Timeout → MCP/API Call   │
│                                                             │
│  Chaos call path (dev/test only)                            │
│                                                             │
│  Agent → Circuit Breaker → Retry → Timeout → CHAOS PROXY → MCP/API Call
│                                              ▲              │
│                                              │              │
│                                     ChaosController         │
│                                     (injects faults)        │
└─────────────────────────────────────────────────────────────┘
```

**Key principle:** Chaos injection happens INSIDE the resilience stack (after circuit breaker, before the real call) so that resilience wrappers are exercised naturally. The circuit breaker sees real failures and opens/closes as it would in production.

## Production Safety

### Hard Guards — Non-Negotiable

```typescript
// mcp-chaos-monkey: guard.ts (library code)
export function assertChaosAllowed(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: Chaos framework must never run in production');
  }
  if (!process.env.CHAOS_ENABLED || process.env.CHAOS_ENABLED !== 'true') {
    throw new Error('Chaos framework not enabled. Set CHAOS_ENABLED=true');
  }
}
```

**Three layers of protection:**

1. **Environment guard:** `CHAOS_ENABLED=true` env var required. Not set by default anywhere — must be explicitly opted into.
2. **NODE_ENV check:** Refuses to load if `NODE_ENV=production`. Hard crash, not a warning.
3. **Build-time exclusion:** Chaos config lives in `src/chaos-config.ts` and `src/chaos-scenarios.ts`. The `tsconfig.prod.json` excludes these files from compilation. The chaos framework itself is in the `mcp-chaos-monkey` npm package.

```jsonc
// tsconfig.prod.json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "src/chaos-config.ts", "src/chaos-scenarios.ts", "tests/**"]
}
```

## Core Components

### File Structure

```
# mcp-chaos-monkey (npm package) provides:
#   ChaosController, assertChaosAllowed, FaultConfig, FaultTarget, isFaultTarget,
#   createChaosAwareFetch, wrapRedisWithChaos, chaosAuthMiddleware,
#   registerChaosEndpoint, defineScenario, configureChaosLogger

# Project-specific chaos config:
src/chaos-config.ts         # ReliableMcpTarget type, isReliableMcpTarget(), initializeChaos()
src/chaos-scenarios.ts      # 10 project-specific scenarios using defineScenario()

tests/chaos/
├── failure-scenarios.test.ts    # Automated chaos test suite
├── recovery-scenarios.test.ts   # Tests that systems recover after faults clear
└── helpers.ts                   # Test utilities for chaos setup/teardown
```

### ChaosController

Central registry that manages active faults. All interceptors check the controller before executing.

```typescript
// mcp-chaos-monkey: controller.ts (library code)
import { assertChaosAllowed } from './guard.js';
import { type FaultConfig, type FaultTarget } from './fault-types.js';
import { getLogger } from './logger.js';

interface ActiveFault {
  target: FaultTarget;
  config: FaultConfig;
  activatedAt: number;
  expiresAt: number | null;   // null = until manually cleared
  requestCount: number;        // how many requests this fault has affected
}

export class ChaosController {
  private faults: Map<string, ActiveFault> = new Map();
  private static instance: ChaosController | null = null;

  constructor() {
    assertChaosAllowed();
  }

  static getInstance(): ChaosController {
    if (!ChaosController.instance) {
      ChaosController.instance = new ChaosController();
    }
    return ChaosController.instance;
  }

  /** Activate a fault. Returns a fault ID for later removal. */
  inject(target: FaultTarget, config: FaultConfig, durationMs?: number): string {
    const id = `${target}-${Date.now()}`;
    this.faults.set(id, {
      target,
      config,
      activatedAt: Date.now(),
      expiresAt: durationMs ? Date.now() + durationMs : null,
      requestCount: 0,
    });
    logger.warn({ faultId: id, target, config: config.type }, 'Chaos fault injected');
    return id;
  }

  /** Remove a specific fault. */
  clear(faultId: string): void {
    this.faults.delete(faultId);
    logger.info({ faultId }, 'Chaos fault cleared');
  }

  /** Remove all active faults. */
  clearAll(): void {
    this.faults.clear();
    logger.info('All chaos faults cleared');
  }

  /** Check if a fault is active for the given target. Returns the fault config or null. */
  getFault(target: FaultTarget): FaultConfig | null {
    for (const [id, fault] of this.faults) {
      if (fault.target !== target) continue;

      // Check expiry
      if (fault.expiresAt && Date.now() > fault.expiresAt) {
        this.faults.delete(id);
        logger.info({ faultId: id }, 'Chaos fault expired');
        continue;
      }

      // Check probability
      if (fault.config.probability !== undefined && Math.random() > fault.config.probability) {
        continue; // Probabilistic skip
      }

      fault.requestCount++;
      return fault.config;
    }
    return null;
  }

  /** Get a snapshot of all active faults (for logging/debugging). */
  getActiveFaults(): ReadonlyArray<{ id: string; target: FaultTarget; type: string; requestCount: number }> {
    return Array.from(this.faults.entries()).map(([id, f]) => ({
      id,
      target: f.target,
      type: f.config.type,
      requestCount: f.requestCount,
    }));
  }

  /** Reset singleton (for test isolation). */
  static reset(): void {
    if (ChaosController.instance) {
      ChaosController.instance.clearAll();
    }
    ChaosController.instance = null;
  }
}
```

### Fault Types

```typescript
// mcp-chaos-monkey: FaultTarget = string (open type)
// Project narrows it in src/chaos-config.ts:
export type ReliableMcpTarget =
  | 'weather-api'         // WeatherAPI.com calls from weather-mcp
  | 'flight-api'          // FlightAware API calls from flight-mcp
  | 'weather-mcp'         // Agent → weather MCP server HTTP
  | 'flight-mcp'          // Agent → flight MCP server HTTP
  | 'redis'               // All Redis operations
  | 'redis-cache'         // Only semantic cache Redis ops
  | 'redis-session'       // Only session store Redis ops
  | 'oauth-token'         // OAuth token validation
  | 'llm-api';            // OpenAI LLM calls

// mcp-chaos-monkey: FaultConfig (unchanged from library)
export type FaultConfig =
  | { type: 'latency'; delayMs: number; probability?: number }
  | { type: 'error'; statusCode: number; message?: string; probability?: number }
  | { type: 'timeout'; hangMs: number; probability?: number }          // Hangs, then times out
  | { type: 'malformed'; corruptResponse: boolean; probability?: number }  // Returns garbage
  | { type: 'connection-refused'; probability?: number }
  | { type: 'connection-drop'; afterBytes?: number; probability?: number }  // Drops mid-response
  | { type: 'rate-limit'; retryAfterSeconds: number; probability?: number } // Returns 429
  | { type: 'schema-mismatch'; missingFields: string[]; probability?: number }; // Valid JSON, wrong shape
```

### HTTP Interceptor

Wraps `fetch()` to inject faults on matching targets. Used for MCP server calls and external API calls.

```typescript
// mcp-chaos-monkey: interceptors/http-interceptor.ts (library code)
import { ChaosController } from '../controller.js';
import { type FaultTarget, type FaultConfig } from '../fault-types.js';
import { getLogger } from '../logger.js';

/**
 * Returns a wrapped fetch function that checks the ChaosController
 * before each request and injects faults as configured.
 *
 * Usage: Replace the fetch call in your resilience-wrapped function
 * with chaosAwareFetch() when CHAOS_ENABLED=true.
 */
export function createChaosAwareFetch(
  target: FaultTarget,
  originalFetch: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  originalFetch: typeof globalThis.fetch
): Promise<Response> {
  switch (fault.type) {
    case 'latency': {
      await delay(fault.delayMs);
      return originalFetch(input, init); // Real call after delay
    }
    case 'error': {
      return new Response(
        JSON.stringify({ error: fault.message ?? 'Chaos injected error' }),
        { status: fault.statusCode, headers: { 'Content-Type': 'application/json' } }
      );
    }
    case 'timeout': {
      await delay(fault.hangMs); // Hang until the caller's AbortSignal fires
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
        }
      );
    }
    case 'malformed': {
      return new Response(
        '<<<CORRUPTED_RESPONSE>>>{{{{not json',
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    case 'schema-mismatch': {
      // Make the real call, then strip fields from the response
      const realResponse = await originalFetch(input, init);
      const body = await realResponse.json() as Record<string, unknown>;
      for (const field of fault.missingFields) {
        delete body[field];
      }
      return new Response(JSON.stringify(body), {
        status: realResponse.status,
        headers: realResponse.headers,
      });
    }
    case 'connection-drop': {
      // Start the real request, then abort it mid-stream
      const abortController = new AbortController();
      const fetchPromise = originalFetch(input, { ...init, signal: abortController.signal });
      setTimeout(() => abortController.abort(), 50); // Abort after 50ms
      return fetchPromise;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### Redis Interceptor

Wraps `ioredis` commands to inject faults on Redis operations.

```typescript
// mcp-chaos-monkey: interceptors/redis-interceptor.ts (library code)
import { ChaosController } from '../controller.js';
import type { FaultTarget } from '../fault-types.js';
import type Redis from 'ioredis';
import { getLogger } from '../logger.js';

/**
 * Wraps a Redis client's command methods with chaos fault injection.
 * Call this once during test setup. Returns an unwrap function for cleanup.
 */
export function wrapRedisWithChaos(
  client: Redis,
  target: FaultTarget = 'redis'
): () => void {
  const originals = new Map<string, (...args: unknown[]) => unknown>();
  const commandsToWrap = ['get', 'set', 'del', 'hget', 'hset', 'expire', 'ttl', 'keys', 'mget'];

  for (const cmd of commandsToWrap) {
    const original = (client as Record<string, unknown>)[cmd] as (...args: unknown[]) => unknown;
    if (typeof original !== 'function') continue;

    originals.set(cmd, original);
    (client as Record<string, unknown>)[cmd] = async (...args: unknown[]): Promise<unknown> => {
      const controller = ChaosController.getInstance();
      const fault = controller.getFault(target);

      if (!fault) {
        return original.apply(client, args);
      }

      logger.debug({ target, cmd, faultType: fault.type }, 'Chaos Redis fault triggered');

      switch (fault.type) {
        case 'latency':
          await new Promise((r) => setTimeout(r, fault.delayMs));
          return original.apply(client, args);
        case 'error':
          throw new Error(`Chaos Redis error: ${fault.message ?? 'connection lost'}`);
        case 'timeout':
          await new Promise((r) => setTimeout(r, fault.hangMs));
          throw new Error('Chaos Redis timeout');
        case 'connection-refused':
          throw new Error('Redis connection refused (chaos)');
        default:
          return original.apply(client, args);
      }
    };
  }

  // Return unwrap function
  return (): void => {
    for (const [cmd, original] of originals) {
      (client as Record<string, unknown>)[cmd] = original;
    }
    originals.clear();
  };
}
```

### Auth Interceptor

Intercepts JWT token validation to simulate auth failures.

```typescript
// mcp-chaos-monkey: interceptors/auth-interceptor.ts (library code)
import { ChaosController } from '../controller.js';
import type { Request, Response, NextFunction } from 'express';
import { getLogger } from '../logger.js';

/**
 * Express middleware that injects auth faults before the real auth middleware.
 * Place this BEFORE the real OAuth middleware in the Express chain.
 */
export function chaosAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const controller = ChaosController.getInstance();
  const fault = controller.getFault('oauth-token');

  if (!fault) {
    next();
    return;
  }

  logger.debug({ faultType: fault.type }, 'Chaos auth fault triggered');

  switch (fault.type) {
    case 'error':
      res.status(fault.statusCode).json({
        error: 'token_invalid',
        message: fault.message ?? 'Authentication failed (chaos)',
      });
      return;
    case 'latency':
      setTimeout(() => next(), fault.delayMs);
      return;
    case 'timeout':
      // Don't respond — let the request hang until client timeout
      return;
    default:
      next();
  }
}
```

## Injection Modes

### 1. Probabilistic (for sustained chaos runs)

```typescript
// 20% of weather API calls fail with 503
chaos.inject('weather-api', { type: 'error', statusCode: 503, probability: 0.2 });

// 10% of Redis operations have 2s latency
chaos.inject('redis', { type: 'latency', delayMs: 2000, probability: 0.1 });
```

### 2. Scheduled (time-bounded faults)

```typescript
// Redis goes down for 30 seconds
chaos.inject('redis', { type: 'connection-refused' }, 30_000);

// Weather API slow for 60 seconds
chaos.inject('weather-api', { type: 'latency', delayMs: 8000 }, 60_000);
```

### 3. Manual Trigger (via test code or optional CLI)

```typescript
// In test code
const faultId = chaos.inject('flight-api', { type: 'error', statusCode: 500 });
// ... run assertions ...
chaos.clear(faultId);

// Optional: CLI for manual Docker-based exploration
// npx mcp-chaos inject weather-api error --status 503 --duration 30
// npx mcp-chaos clear-all
// npx mcp-chaos status
```

## Integration Approach

### How to Wire Chaos Into the Codebase

The chaos layer wraps the **transport functions** (fetch, Redis commands), NOT the resilience wrappers. This means the resilience stack (circuit breaker → retry → timeout) sees real failures and exercises naturally.

**For HTTP calls (MCP client + external APIs):**

```typescript
// In the MCP server or API client module:
// Dynamically import from the library only when chaos is enabled:
async function resolveFetch(target: string): Promise<typeof fetch> {
  if (process.env['CHAOS_ENABLED'] === 'true') {
    const { createChaosAwareFetch } = await import('mcp-chaos-monkey');
    return createChaosAwareFetch(target, globalThis.fetch);
  }
  return globalThis.fetch;
}
const fetchFn = await resolveFetch('weather-api');

// Use fetchFn instead of fetch in the resilience-wrapped call:
const fetchWeatherRaw = async (city: string): Promise<WeatherResponse> => {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
  // ...
};
```

**For Redis:**

```typescript
// In test setup (not in application code):
import { wrapRedisWithChaos } from 'mcp-chaos-monkey';

let unwrapRedis: () => void;

beforeAll(() => {
  unwrapRedis = wrapRedisWithChaos(redisClient);
});

afterAll(() => {
  unwrapRedis();
  ChaosController.reset();
});
```

**For auth:**

```typescript
// In the Express app setup (conditionally):
if (process.env['CHAOS_ENABLED'] === 'true' && process.env['NODE_ENV'] !== 'production') {
  const { initializeChaos } = await import('../chaos-config.js');
  initializeChaos();
  const { chaosAuthMiddleware } = await import('mcp-chaos-monkey');
  app.use(chaosAuthMiddleware);
}
app.use(oauthMiddleware); // Real auth middleware always applied
```

## LangSmith Observability Tie-In

Every chaos-injected fault must be visible in LangSmith so you can verify that metrics, error tracking, and cost tracking work correctly under failure.

### What to Tag on LangSmith Runs

```typescript
// When a chaos fault fires, add metadata to the current LangSmith run:
import { metrics } from '../observability/metrics.js';

// In the interceptor, after triggering a fault:
metrics.increment('chaos.fault.injected', { target, faultType: fault.type });

// In the resilience wrapper, when handling a fault result:
// (This already happens via the existing resilience metrics — chaos just causes
// more of these events to fire)
// - resilience.{name}.failure → counter
// - resilience.{name}.circuit.open → event
// - resilience.{name}.retry → counter
// - resilience.{name}.timeout → counter
```

### What to Verify in LangSmith After a Chaos Run

1. **Error counts increase** for the targeted service
2. **Circuit breaker state changes** are logged (open → half-open → closed)
3. **Latency p95/p99 increases** when latency faults are injected
4. **Token costs are still tracked** even for failed/partial requests
5. **No stack traces leak** into user-facing responses (check response content)
6. **Degradation tags** appear on runs: `weather_degraded`, `flight_degraded`, `redis_down`

### Verification Script

```typescript
// tests/chaos/helpers.ts — utility to verify LangSmith state after chaos test
export async function assertLangSmithMetrics(expectations: {
  minErrorCount?: number;
  circuitOpenEvents?: string[];  // Circuit names that should have opened
  noCriticalFailures?: boolean;
}): Promise<void> {
  // Query LangSmith API for recent runs tagged with chaos test ID
  // Assert metrics match expectations
  // This validates that observability works under failure conditions
}
```

## Pre-Built Chaos Scenarios

These are the concrete test scenarios. Each scenario describes what fault is injected, what the system should do, and what to assert.

```typescript
// src/chaos-scenarios.ts (project-specific, uses mcp-chaos-monkey)
import { defineScenario } from 'mcp-chaos-monkey';
import type { FaultConfig } from 'mcp-chaos-monkey';

export interface ChaosScenario {
  name: string;
  description: string;
  faults: Array<{ target: FaultTarget; config: FaultConfig; durationMs?: number }>;
  expectedBehavior: string;
  assertions: string[];  // Human-readable for documentation; implemented in test code
}

export const CHAOS_SCENARIOS: ChaosScenario[] = [
  {
    name: 'weather-api-503-circuit-breaker',
    description: 'Weather API returns 503 continuously — circuit breaker should open',
    faults: [
      { target: 'weather-api', config: { type: 'error', statusCode: 503 } },
    ],
    expectedBehavior:
      'First 5 requests retry and fail. Circuit breaker opens. Subsequent requests get ' +
      'CircuitOpenError immediately (no actual API call). User sees: "Weather data is ' +
      'temporarily unavailable." Flight queries still work (partial response).',
    assertions: [
      'Circuit breaker transitions to OPEN after threshold failures',
      'User receives friendly degradation message for weather',
      'Flight data still returned in combined queries',
      'LangSmith logs show circuit_breaker.weather-api.trip event',
      'No stack traces in any response',
    ],
  },
  {
    name: 'weather-api-503-recovery',
    description: 'Weather API returns 503, then recovers — circuit should close',
    faults: [
      { target: 'weather-api', config: { type: 'error', statusCode: 503 }, durationMs: 35_000 },
    ],
    expectedBehavior:
      'Circuit opens after threshold. After 30s cooldown, circuit goes half-open. ' +
      'Fault expires at 35s. Next request succeeds, circuit closes. Full service restored.',
    assertions: [
      'Circuit transitions: CLOSED → OPEN → HALF_OPEN → CLOSED',
      'Recovery is automatic — no manual intervention needed',
      'LangSmith logs show full state transition sequence',
    ],
  },
  {
    name: 'flight-api-timeout-retry-exhaust',
    description: 'Flight API hangs for 10s — timeout fires, retries exhaust',
    faults: [
      { target: 'flight-api', config: { type: 'timeout', hangMs: 10_000 } },
    ],
    expectedBehavior:
      'Each attempt times out at 5s. Retry fires (up to 3 attempts, ~15s total). ' +
      'All retries fail. User sees: "Flight status is temporarily unavailable." ' +
      'Weather queries still work.',
    assertions: [
      'Each retry attempt hits timeout at 5s',
      'Total latency bounded by retry * timeout, not unbounded',
      'Partial response includes weather data',
      'LangSmith shows retry.flight-api.exhausted counter',
    ],
  },
  {
    name: 'redis-connection-drop',
    description: 'Redis becomes unavailable mid-session',
    faults: [
      { target: 'redis', config: { type: 'connection-refused' } },
    ],
    expectedBehavior:
      'Semantic cache bypassed (cache miss fallback). Session memory unavailable. ' +
      'Rate limiter falls back to in-memory. Agent continues responding without cache/session. ' +
      'User experience degraded but functional.',
    assertions: [
      'Agent still returns correct responses (no crash)',
      'Cache operations return null (not throw)',
      'Rate limiter uses in-memory fallback',
      'LangSmith tagged with redis_down',
      'Logger emits level=critical for Redis connection failure',
    ],
  },
  {
    name: 'redis-latency-spike-cache-bypass',
    description: 'Redis responds but slowly (2s per operation) — cache should be bypassed',
    faults: [
      { target: 'redis-cache', config: { type: 'latency', delayMs: 2000 } },
    ],
    expectedBehavior:
      'Cache lookup hits 500ms timeout, bypassed. Agent makes real API calls. ' +
      'Response latency not affected by Redis slowness. Cache store operation ' +
      'also times out (non-blocking).',
    assertions: [
      'Cache timeout fires at 500ms',
      'Total response latency stays within budget (not +2s)',
      'Metrics show cache.timeout incremented',
      'Subsequent queries still attempt cache (not permanently disabled)',
    ],
  },
  {
    name: 'oauth-token-expired',
    description: 'Auth middleware receives an expired JWT',
    faults: [
      { target: 'oauth-token', config: { type: 'error', statusCode: 401, message: 'Token expired' } },
    ],
    expectedBehavior:
      'Request rejected at auth layer with 401. No agent execution. Clear error ' +
      'message: "Please re-authenticate." Token value NOT logged — only metadata.',
    assertions: [
      'HTTP response is 401 with JSON body',
      'Error message is user-friendly',
      'No LLM/tool calls executed (auth gate works)',
      'Logger records auth failure without token value',
    ],
  },
  {
    name: 'both-mcp-servers-unreachable',
    description: 'Both weather-mcp and flight-mcp return connection refused',
    faults: [
      { target: 'weather-mcp', config: { type: 'connection-refused' } },
      { target: 'flight-mcp', config: { type: 'connection-refused' } },
    ],
    expectedBehavior:
      'Agent cannot reach either tool. LLM recognizes no tool data available. ' +
      'User sees: "Our services are temporarily unavailable. Please try again shortly."',
    assertions: [
      'Agent does not crash or hang',
      'User receives a single clear error message',
      'Both circuits open independently',
      'Response time stays bounded (not waiting for full timeout chain on both)',
    ],
  },
  {
    name: 'weather-mcp-malformed-response',
    description: 'Weather MCP server returns invalid/corrupted JSON',
    faults: [
      { target: 'weather-mcp', config: { type: 'malformed' } },
    ],
    expectedBehavior:
      'Zod validation on the MCP client response catches the schema mismatch. ' +
      'Agent treats it as a tool failure. Partial response with flight data if available.',
    assertions: [
      'JSON parse error or zod validation error caught',
      'Error does not propagate as unhandled exception',
      'Agent returns partial response (flight data still works)',
      'Logger records schema validation failure with details',
    ],
  },
  {
    name: 'flight-api-rate-limited',
    description: 'Flight API returns 429 (rate limited)',
    faults: [
      { target: 'flight-api', config: { type: 'rate-limit', retryAfterSeconds: 60 } },
    ],
    expectedBehavior:
      'Retry logic recognizes 429 as non-retryable (or retries with respect for Retry-After). ' +
      'Circuit breaker counts this as a failure. User sees degradation message.',
    assertions: [
      '429 is handled gracefully (no crash)',
      'Retry does NOT hammer the API (respects 429)',
      'User gets friendly message, not raw 429',
    ],
  },
  {
    name: 'cascading-failure-redis-then-api',
    description: 'Redis drops, then weather API starts failing — compound failure',
    faults: [
      { target: 'redis', config: { type: 'connection-refused' } },
      { target: 'weather-api', config: { type: 'error', statusCode: 503 } },
    ],
    expectedBehavior:
      'Redis down: cache/session bypass activated. Weather API fails: circuit opens. ' +
      'Flight data still works. System degrades gracefully to flight-only mode without ' +
      'cache. No cascading crash.',
    assertions: [
      'System remains responsive (no total failure)',
      'Flight queries still work end-to-end',
      'Error messages are specific (not generic "something went wrong")',
      'System recovers when faults are cleared',
    ],
  },
];
```

## Test Implementation Pattern

### Automated Chaos Tests (`tests/chaos/failure-scenarios.test.ts`)

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ChaosController } from 'mcp-chaos-monkey';
import { CHAOS_SCENARIOS } from '../../src/chaos-scenarios.js';

// Test helper: send a chat request through the full agent stack
async function sendChatRequest(query: string): Promise<{
  status: number;
  body: Record<string, unknown>;
  latencyMs: number;
}> {
  const start = Date.now();
  const res = await fetch(`${agentBaseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
    body: JSON.stringify({ message: query }),
  });
  return {
    status: res.status,
    body: await res.json() as Record<string, unknown>,
    latencyMs: Date.now() - start,
  };
}

describe('Chaos: Failure Scenarios', () => {
  let chaos: ChaosController;

  beforeAll(() => {
    process.env.CHAOS_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    chaos = ChaosController.getInstance();
  });

  afterEach(() => {
    chaos.clearAll();  // Always clean up faults between tests
  });

  afterAll(() => {
    ChaosController.reset();
  });

  it('weather API 503 → circuit opens → partial response with flight data', async () => {
    chaos.inject('weather-api', { type: 'error', statusCode: 503 });

    // Send enough requests to trip the circuit breaker
    for (let i = 0; i < 6; i++) {
      await sendChatRequest("What's the weather in NYC?");
    }

    // This request should hit the open circuit (no actual API call)
    const result = await sendChatRequest("Weather in NYC and status of TEST001?");

    expect(result.status).toBe(200);
    expect(result.body.response).toContain('unavailable');  // Weather degraded
    // Flight data should still be present
    expect(JSON.stringify(result.body.response)).toMatch(/TEST001|on.time|flight/i);
  });

  it('Redis connection drop → agent continues without cache/session', async () => {
    chaos.inject('redis', { type: 'connection-refused' });

    const result = await sendChatRequest("What's the weather in London?");

    expect(result.status).toBe(200);
    // Agent should still return a response (not crash)
    expect(result.body.response).toBeDefined();
    expect(typeof result.body.response).toBe('string');
  });

  it('both MCP servers unreachable → clear error message', async () => {
    chaos.inject('weather-mcp', { type: 'connection-refused' });
    chaos.inject('flight-mcp', { type: 'connection-refused' });

    const result = await sendChatRequest("Weather in NYC and status of UA123?");

    expect(result.status).toBe(200);
    expect(result.body.response).toMatch(/unavailable|try again/i);
    // No stack traces
    expect(JSON.stringify(result.body)).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/);
  });

  it('API latency spike → timeout fires → response within budget', async () => {
    chaos.inject('weather-api', { type: 'latency', delayMs: 8000 });

    const result = await sendChatRequest("What's the weather in Paris?");

    // Should not wait the full 8s — timeout at 5s + retry budget
    expect(result.latencyMs).toBeLessThan(20_000); // Global 15s + buffer
    expect(result.body.response).toMatch(/unavailable|try again/i);
  });

  it('expired OAuth token → 401 without agent execution', async () => {
    chaos.inject('oauth-token', { type: 'error', statusCode: 401, message: 'Token expired' });

    const result = await sendChatRequest("What's the weather?");

    expect(result.status).toBe(401);
    expect(result.body.message).toMatch(/re-authenticate|expired/i);
  });
});

describe('Chaos: Recovery Scenarios', () => {
  let chaos: ChaosController;

  beforeAll(() => {
    process.env.CHAOS_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    chaos = ChaosController.getInstance();
  });

  afterEach(() => {
    chaos.clearAll();
  });

  afterAll(() => {
    ChaosController.reset();
  });

  it('weather API recovers → circuit closes → full service restored', async () => {
    // Inject fault with 35s duration (circuit cooldown is 30s)
    chaos.inject('weather-api', { type: 'error', statusCode: 503 }, 35_000);

    // Trip the circuit
    for (let i = 0; i < 6; i++) {
      await sendChatRequest("What's the weather in NYC?");
    }

    // Wait for circuit half-open + fault expiry
    await new Promise((r) => setTimeout(r, 36_000));

    // This should succeed — fault expired, circuit half-open allows a test request
    const result = await sendChatRequest("What's the weather in NYC?");
    expect(result.status).toBe(200);
    // Should have actual weather data (not degradation message)
  }, 45_000); // Extended timeout for this long-running test

  it('Redis reconnects → cache resumes → session memory restored', async () => {
    // Start with Redis down
    const faultId = chaos.inject('redis', { type: 'connection-refused' });

    await sendChatRequest("Status of TEST001?");
    // Agent works but without cache

    // Clear the fault (simulating Redis recovery)
    chaos.clear(faultId);

    // Next request should use cache again
    const result = await sendChatRequest("Status of TEST001?");
    expect(result.status).toBe(200);
    // Could check for cache hit in response metadata if exposed
  });
});
```

## Running Chaos Tests

### Commands

```bash
# Run all chaos tests (needs full Docker stack)
docker compose up -d
CHAOS_ENABLED=true npm run test:chaos

# Run a specific scenario
CHAOS_ENABLED=true npx vitest tests/chaos/failure-scenarios.test.ts -t "weather API 503"

# Manual chaos exploration against running Docker stack
# (optional CLI from mcp-chaos-monkey — useful for demos and exploratory testing)
CHAOS_ENABLED=true npx mcp-chaos inject weather-api error --status 503 --duration 60
# ... manually test the chatbot ...
CHAOS_ENABLED=true npx mcp-chaos clear-all
CHAOS_ENABLED=true npx mcp-chaos status
```

### npm Scripts (add to package.json)

```json
{
  "scripts": {
    "test:chaos": "CHAOS_ENABLED=true vitest run tests/chaos/",
    "test:chaos:watch": "CHAOS_ENABLED=true vitest watch tests/chaos/",
    "chaos:status": "CHAOS_ENABLED=true npx mcp-chaos status",
    "chaos:clear": "CHAOS_ENABLED=true npx mcp-chaos clear-all"
  }
}
```

## Checklist

Before considering the chaos framework done:

- [ ] `mcp-chaos-monkey` guard prevents chaos code from loading in production (NODE_ENV + CHAOS_ENABLED)
- [ ] `tsconfig.prod.json` excludes `src/chaos-config.ts` and `src/chaos-scenarios.ts` from production build
- [ ] All chaos imports guarded by `CHAOS_ENABLED` check (dynamic imports only)
- [ ] ChaosController is singleton with reset capability (test isolation)
- [ ] HTTP interceptor wraps fetch for all fault targets
- [ ] Redis interceptor wraps ioredis commands with unwrap cleanup
- [ ] Auth interceptor is conditional Express middleware
- [ ] All 10 scenarios from `src/chaos-scenarios.ts` have corresponding test implementations
- [ ] Each test cleans up faults in afterEach (no fault leakage between tests)
- [ ] Recovery scenarios verify that systems heal after faults clear
- [ ] LangSmith shows correct metrics during chaos runs
- [ ] `configureChaosLogger` called with pino before chaos usage (via `initializeChaos()`)
- [ ] `npm run test:chaos` passes cleanly from a fresh `docker compose up`
