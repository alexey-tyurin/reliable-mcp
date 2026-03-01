import type { FaultTarget, FaultConfig } from './fault-types.js';

export interface ChaosScenario {
  name: string;
  description: string;
  faults: readonly { target: FaultTarget; config: FaultConfig; durationMs?: number }[];
  expectedBehavior: string;
  assertions: readonly string[];
}

export const CHAOS_SCENARIOS: readonly ChaosScenario[] = [
  {
    name: 'weather-api-503-circuit-breaker',
    description: 'Weather API returns 503 continuously — circuit breaker should open',
    faults: [
      { target: 'weather-api', config: { type: 'error', statusCode: 503 } },
    ],
    expectedBehavior:
      'First 5 requests retry and fail. Circuit breaker opens. Subsequent requests get ' +
      'CircuitOpenError immediately. User sees: "Weather data is temporarily unavailable." ' +
      'Flight queries still work.',
    assertions: [
      'Circuit breaker transitions to OPEN after threshold failures',
      'User receives friendly degradation message for weather',
      'Flight data still returned in combined queries',
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
      'Fault expires at 35s. Next request succeeds, circuit closes.',
    assertions: [
      'Circuit transitions: CLOSED → OPEN → HALF_OPEN → CLOSED',
      'Recovery is automatic — no manual intervention needed',
    ],
  },
  {
    name: 'flight-api-timeout-retry-exhaust',
    description: 'Flight API hangs for 10s — timeout fires, retries exhaust',
    faults: [
      { target: 'flight-api', config: { type: 'timeout', hangMs: 10_000 } },
    ],
    expectedBehavior:
      'Each attempt times out at 5s. Retries fire and all fail. ' +
      'User sees: "Flight status is temporarily unavailable." Weather queries still work.',
    assertions: [
      'Each retry attempt hits timeout at 5s',
      'Total latency bounded by retry * timeout',
      'Partial response includes weather data',
    ],
  },
  {
    name: 'redis-connection-drop',
    description: 'Redis becomes unavailable mid-session',
    faults: [
      { target: 'redis', config: { type: 'connection-refused' } },
    ],
    expectedBehavior:
      'Semantic cache bypassed. Session memory unavailable. ' +
      'Rate limiter falls back to in-memory. Agent continues responding.',
    assertions: [
      'Agent still returns correct responses (no crash)',
      'Cache operations return null (not throw)',
      'Rate limiter uses in-memory fallback',
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
      'Response latency not affected by Redis slowness.',
    assertions: [
      'Cache timeout fires at 500ms',
      'Total response latency stays within budget',
      'Subsequent queries still attempt cache',
    ],
  },
  {
    name: 'oauth-token-expired',
    description: 'Auth middleware receives an expired JWT',
    faults: [
      { target: 'oauth-token', config: { type: 'error', statusCode: 401, message: 'Token expired' } },
    ],
    expectedBehavior:
      'Request rejected at auth layer with 401. No agent execution. ' +
      'Clear error message returned.',
    assertions: [
      'HTTP response is 401 with JSON body',
      'Error message is user-friendly',
      'No LLM/tool calls executed',
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
      'Agent cannot reach either tool. User sees: "Our services are temporarily unavailable."',
    assertions: [
      'Agent does not crash or hang',
      'User receives a single clear error message',
      'Both circuits open independently',
    ],
  },
  {
    name: 'weather-mcp-malformed-response',
    description: 'Weather MCP server returns invalid/corrupted JSON',
    faults: [
      { target: 'weather-mcp', config: { type: 'malformed', corruptResponse: true } },
    ],
    expectedBehavior:
      'Validation catches the schema mismatch. Agent treats it as a tool failure. ' +
      'Partial response with flight data if available.',
    assertions: [
      'JSON parse or validation error caught',
      'Error does not propagate as unhandled exception',
      'Agent returns partial response',
    ],
  },
  {
    name: 'flight-api-rate-limited',
    description: 'Flight API returns 429 (rate limited)',
    faults: [
      { target: 'flight-api', config: { type: 'rate-limit', retryAfterSeconds: 60 } },
    ],
    expectedBehavior:
      'Retry logic handles 429 gracefully. User sees degradation message.',
    assertions: [
      '429 is handled gracefully (no crash)',
      'Retry does NOT hammer the API',
      'User gets friendly message',
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
      'Redis down: cache/session bypass. Weather API fails: circuit opens. ' +
      'Flight data still works. System degrades to flight-only without cache.',
    assertions: [
      'System remains responsive',
      'Flight queries still work end-to-end',
      'Error messages are specific',
      'System recovers when faults are cleared',
    ],
  },
] as const;
