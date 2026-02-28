# Skill: Resilience Wrapper

Use this pattern when wrapping any external API call, MCP client call, or unreliable operation in this project.

## Wrapping Order (Always)

```
circuit breaker → retry with jitter → timeout → actual call
```

This is the ONLY correct order. The circuit breaker is the outermost wrapper because it should prevent any attempt (including retries) when the circuit is open. Retry is next so it can retry on timeout errors. Timeout is innermost so each individual attempt has a bounded duration.

## Configuration

### Circuit Breaker (opossum)
```typescript
{
  timeout: 5000,           // 5s per call
  errorThresholdPercentage: 50,
  resetTimeout: 30000,     // 30s before half-open
  rollingCountTimeout: 60000,
  volumeThreshold: 5       // Min calls before tripping
}
```

### Retry
```typescript
{
  maxRetries: 3,
  baseDelay: 200,          // ms
  maxDelay: 5000,          // ms
  jitterFactor: 0.3,       // ±30% randomization
  retryOn: [502, 503, 504, 'ETIMEDOUT', 'ECONNRESET']
}
```

### Timeouts
```typescript
// Per-call timeouts
const API_CALL_TIMEOUT = 5000;      // External API calls
const CACHE_TIMEOUT = 500;          // Cache operations
const GLOBAL_REQUEST_TIMEOUT = 15000; // Entire user request

// Budget breakdown for a combined query:
// cache lookup: 500ms
// weather API: 5s (with 1 retry = 10s max)
// flight API: 5s (with 1 retry = 10s max, parallel with weather)
// LLM call: 5s
// Total budget: ~15s max
```

## Usage Pattern

### Wrapping an External API Call

```typescript
import { createCircuitBreaker } from '../resilience/circuit-breaker.js';
import { withRetry } from '../resilience/retry.js';
import { withTimeout } from '../resilience/timeout.js';
import { logger } from '../observability/logger.js';

// Define the raw call
async function fetchWeatherRaw(city: string): Promise<WeatherResponse> {
  const url = `https://api.weatherapi.com/v1/current.json?key=${env.WEATHERAPI_KEY}&q=${encodeURIComponent(city)}&aqi=no`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

  if (!response.ok) {
    throw new ApiError(`WeatherAPI returned ${response.status}`, response.status);
  }

  return WeatherResponseSchema.parse(await response.json());
}

// Wrap it: circuit breaker → retry → timeout
const fetchWeather = createCircuitBreaker(
  withRetry(
    withTimeout(fetchWeatherRaw, 5000),
    {
      maxRetries: 3,
      retryOn: (error) => error instanceof ApiError && [502, 503, 504].includes(error.status),
    }
  ),
  { name: 'weather-api' }
);

// Use it — the caller just awaits, all resilience is handled
try {
  const weather = await fetchWeather('New York');
} catch (error) {
  if (error instanceof CircuitOpenError) {
    logger.warn({ circuit: 'weather-api' }, 'Circuit open, skipping weather');
    // Return partial response or degradation message
  }
  // Other errors already retried and timed out — this is the final failure
}
```

### Wrapping an MCP Client Call (agent → MCP server)

The agent calls MCP servers over HTTP. These calls also need resilience:

```typescript
const callWeatherTool = createCircuitBreaker(
  withRetry(
    withTimeout(
      async (params: WeatherInput): Promise<WeatherOutput> => {
        const result = await mcpClient.callTool('get_weather', params);
        return JSON.parse(result.content[0].text);
      },
      8000  // slightly longer — includes MCP server's own API call time
    ),
  ),
  { name: 'weather-mcp' }
);
```

### Wrapping Cache Operations (with bypass-on-timeout)

Cache operations have a shorter timeout and should NEVER block the main request:

```typescript
async function getCachedResponse(query: string): Promise<CachedResponse | null> {
  try {
    return await withTimeout(
      async () => {
        const embedding = await getEmbedding(query);
        return await searchCache(embedding);
      },
      500  // 500ms — bypass cache if slow
    );
  } catch (error) {
    if (error instanceof TimeoutError) {
      logger.warn('Cache timeout, bypassing');
      metrics.increment('cache.timeout');
      return null;  // Proceed without cache
    }
    logger.error({ error }, 'Cache error, bypassing');
    return null;  // Never let cache failure block the request
  }
}
```

## Custom Error Types

All resilience errors should use typed errors from `src/utils/errors.ts`:

```typescript
export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number, public readonly operation: string) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export class CircuitOpenError extends Error {
  constructor(public readonly circuitName: string) {
    super(`Circuit breaker '${circuitName}' is open`);
    this.name = 'CircuitOpenError';
  }
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Rate limit exceeded, retry after ${retryAfterSeconds}s`);
    this.name = 'RateLimitError';
  }
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}
```

## Metrics to Track

Every resilience wrapper should emit metrics:

- `circuit_breaker.{name}.state` — open / closed / half-open
- `circuit_breaker.{name}.trip` — counter, fires when circuit opens
- `retry.{name}.attempt` — counter with attempt number tag
- `retry.{name}.exhausted` — counter, fires when all retries fail
- `timeout.{name}.exceeded` — counter, fires on timeout

## Testing Resilience Wrappers

Test each layer independently (TDD):

```typescript
describe('Circuit Breaker', () => {
  it('stays closed on success');
  it('opens after threshold failures');
  it('transitions to half-open after reset timeout');
  it('closes again on successful half-open call');
  it('rejects immediately when open (no actual call)');
});

describe('Retry', () => {
  it('returns on first success');
  it('retries on retryable error');
  it('does not retry on non-retryable error');
  it('respects maxRetries');
  it('applies exponential backoff with jitter');
});

describe('Timeout', () => {
  it('returns result if within timeout');
  it('throws TimeoutError if exceeded');
  it('cancels the underlying operation via AbortController');
});
```

## Checklist

- [ ] Wrapping order is circuit breaker → retry → timeout → call
- [ ] Circuit breaker has a descriptive name for metrics
- [ ] Retry predicate only retries on transient errors (5xx, network errors), NOT on 4xx
- [ ] Timeout value is appropriate: 5s for external APIs, 500ms for cache, 8s for MCP client calls
- [ ] All errors are typed (TimeoutError, CircuitOpenError, etc.)
- [ ] Metrics emitted for circuit trips, retry attempts, timeouts
- [ ] Cache/optional operations return null on failure (never block)
- [ ] Tests cover success, timeout, circuit open, retry exhaustion
