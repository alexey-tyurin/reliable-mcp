Chaos Framework & Fault Injection Tests

Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Follow the pattern in .claude/skills/chaos-testing.md. Build the lightweight chaos (fault injection) framework and the automated chaos test suite. This is a dev/test-only framework — it must NEVER run in production.

PART A — Chaos Framework (src/chaos/):

1) Create src/chaos/guard.ts — production safety. Hard crash if NODE_ENV=production or CHAOS_ENABLED is not 'true'. Write tests first: guard throws in production, guard throws when CHAOS_ENABLED unset, guard passes when both conditions met.

2) Create src/chaos/fault-types.ts — TypeScript types for FaultTarget (weather-api, flight-api, weather-mcp, flight-mcp, redis, redis-cache, redis-session, oauth-token, llm-api) and FaultConfig (latency, error, timeout, malformed, connection-refused, connection-drop, rate-limit, schema-mismatch). All with optional probability field (0-1). No any types.

3) Create src/chaos/controller.ts — ChaosController singleton class. Methods: inject(target, config, durationMs?) → faultId string, clear(faultId), clearAll(), getFault(target) → FaultConfig|null (checks expiry and probability), getActiveFaults() → readonly snapshot, static reset() for test isolation. Write TDD tests first: inject/clear lifecycle, duration-based expiry, probabilistic skipping, reset for isolation.

4) Create src/chaos/interceptors/http-interceptor.ts — createChaosAwareFetch(target, originalFetch?) that returns a wrapped fetch function. For each fault type: latency adds delay then calls real fetch, error returns a fake Response with the status code, timeout hangs then aborts, connection-refused throws TypeError, rate-limit returns 429 with Retry-After header, malformed returns corrupted non-JSON body with 200 status, schema-mismatch calls real fetch then strips fields, connection-drop starts real fetch then aborts mid-stream. Write tests for each fault type.

5) Create src/chaos/interceptors/redis-interceptor.ts — wrapRedisWithChaos(client, target) that monkey-patches ioredis command methods (get, set, del, hget, hset, expire, ttl, keys, mget). Returns an unwrap() function for cleanup. Supports latency, error, timeout, connection-refused faults. Write tests.

6) Create src/chaos/interceptors/auth-interceptor.ts — chaosAuthMiddleware Express middleware that checks ChaosController for oauth-token faults. Must be placed BEFORE the real auth middleware. Supports error (returns status code), latency (delays), timeout (hangs). Write tests.

7) Create src/chaos/scenarios.ts — define all 10 chaos scenarios as typed objects (see .claude/skills/chaos-testing.md for the full list): weather-api-503-circuit-breaker, weather-api-503-recovery, flight-api-timeout-retry-exhaust, redis-connection-drop, redis-latency-spike-cache-bypass, oauth-token-expired, both-mcp-servers-unreachable, weather-mcp-malformed-response, flight-api-rate-limited, cascading-failure-redis-then-api.

8) Create src/chaos/cli.ts — optional CLI for manual exploration: 'inject <target> <type> [--status N] [--delay N] [--duration N]', 'clear <faultId>', 'clear-all', 'status'. Uses ChaosController via HTTP endpoint (add a /chaos admin endpoint to the agent, guarded by CHAOS_ENABLED + NODE_ENV check).

9) Create tsconfig.prod.json that extends tsconfig.json but excludes src/chaos/** and tests/**. Verify the production Dockerfile uses this config.

PART B — Wire Chaos Into Codebase:

In the modules that make external calls (weather server, flight server, MCP client, Redis operations), add conditional imports that swap the real fetch/client for chaos-aware versions when CHAOS_ENABLED=true. The pattern is:

const fetchFn = process.env.CHAOS_ENABLED === 'true'
  ? (await import('../chaos/interceptors/http-interceptor.js')).createChaosAwareFetch('weather-api')
  : globalThis.fetch;

This ensures chaos code is only imported when explicitly enabled and can be tree-shaken out of production builds.

PART C — Automated Chaos Test Suite:

1) Create tests/chaos/helpers.ts — test utilities: sendChatRequest(query) helper, setupChaos/teardownChaos hooks, assertNoStackTrace(response) helper.

2) Create tests/chaos/failure-scenarios.test.ts — implement tests for all 10 scenarios. Each test: activates fault → sends request(s) → asserts user-facing behavior (status code, message content, partial responses) → asserts system behavior (circuit state, latency bounds, no stack traces). Use afterEach to clearAll faults.

3) Create tests/chaos/recovery-scenarios.test.ts — tests that verify automatic recovery: weather API recovers → circuit closes, Redis reconnects → cache resumes, compound failure clears → full service restored. These tests use time-bounded faults and setTimeout to wait for recovery windows.

PART D — Hardening (same as before):

Do a full code quality review:
- Run npx tsc --noEmit: must be zero errors.
- Run npm run lint: must be zero warnings.
- Grep the entire codebase for: 'any' type annotations, console.log, hardcoded secrets, TODO/FIXME.
- Review every file in src/ for resource leaks.
- Run a simple load test: 100 sequential requests against the full Docker Compose stack.
- Verify no stack traces or internal details leak in any error response.
- Verify tsconfig.prod.json excludes src/chaos/**. Verify production Docker image does not contain chaos code.

Add npm scripts: 'test:chaos' runs CHAOS_ENABLED=true vitest run tests/chaos/, 'chaos:status' and 'chaos:clear' for manual mode.