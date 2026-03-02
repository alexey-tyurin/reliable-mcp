# MCP Weather & Flight Chatbot — Implementation Plan

## Overview

A production-ready chatbot that answers weather temperature and flight status questions (including combined queries) using MCP servers, LangGraphJS orchestration, and robust reliability patterns. Designed to be built incrementally using **Claude Code**.

---

## Development Principles

These principles apply to **every phase and every Claude Code session**. They are non-negotiable.

### Test-Driven Development (TDD)

Every feature follows the Red → Green → Refactor cycle:

1. **Red:** Write a failing test that defines the expected behavior _before_ writing implementation code.
2. **Green:** Write the minimum code to make the test pass.
3. **Refactor:** Clean up the implementation while keeping tests green.

This means: no function gets written without a test that exercises it first. This applies to utility functions, API handlers, middleware, MCP tool handlers, and agent graph nodes alike. The test suite is not an afterthought bolted on at the end — it is the scaffolding that guides the build.

For non-deterministic components (LLM responses, semantic cache similarity), write tests with bounded assertions (e.g., "response contains flight number", "similarity score is between 0.9 and 1.0") rather than exact string matches.

### Code Quality & Bug Prevention

Every module must be reviewed for these categories of bugs before moving to the next phase:

**Security:**
- No secrets in code or logs (API keys, tokens, user data). Validate with a grep scan.
- All user input sanitized before use (city names, flight numbers, query strings).
- No `eval()`, no dynamic `require()`, no template literal injection in SQL/queries.
- JWT tokens validated on every request — never trust client-side claims without verification.
- HTTP headers hardened via `helmet`. CORS configured to specific origins, not `*` in production.

**Memory leaks & resource management:**
- Every opened resource has a corresponding cleanup: Redis connections, HTTP clients, MCP server/client handles, file descriptors, timers/intervals.
- `graceful-shutdown.ts` must close _all_ resources — not just Redis. Verify with a checklist per phase.
- Event listeners registered with `.on()` must have corresponding `.off()` or `.removeListener()` on shutdown.
- Avoid closures that capture large objects in long-lived scopes (e.g., circuit breaker callbacks holding request bodies).
- Use `AbortController` for cancellable operations (HTTP fetches, LLM calls) so in-flight requests are cleaned up on shutdown.

**Unclosed resources checklist (verify each phase):**
- [ ] Redis client: `client.quit()` in shutdown handler
- [ ] MCP Streamable HTTP servers: `httpServer.close()` with connection draining in shutdown handler
- [ ] MCP client connections: `client.close()` in shutdown handler
- [ ] Express server: `server.close()` with connection draining
- [ ] Pino logger: `logger.flush()` before exit
- [ ] Any `setInterval` / `setTimeout`: cleared on shutdown

**Error handling:**
- No unhandled promise rejections. Use `process.on('unhandledRejection', ...)` as a safety net but fix the root cause.
- Every `async` function has proper error handling — no bare `await` without try/catch or `.catch()`.
- Errors should be typed (custom error classes in `src/utils/errors.ts`), not generic `throw new Error(string)`.
- Never swallow errors silently. At minimum: log, increment a metric, and propagate or return a user-friendly message.

### Maintainability Over Cleverness

**Prefer readable, boring code:**
- No clever one-liners that require a comment to explain. If it needs a comment, rewrite it to be self-explanatory.
- Explicit is better than implicit: name variables descriptively (`flightStatusResponse` not `res2`), avoid abbreviations.
- Functions should do one thing. If a function has "and" in its description, split it.
- Keep files under ~200 lines. If a file grows larger, extract a module.

**Consistent patterns:**
- Every MCP server follows the same structure: schema → validate → call API (via resilience wrapper) → map response → return.
- Every resilience wrapper follows the same pattern: circuit breaker wraps retry wraps timeout wraps the actual call.
- Every error path follows the same pattern: catch → log with context → increment metric → return user-friendly message.
- Use the same naming conventions everywhere: `camelCase` for variables/functions, `PascalCase` for types/interfaces, `SCREAMING_SNAKE` for env vars and constants.

**Dependencies:**
- Prefer well-maintained packages with large install bases over new/trendy alternatives.
- No dependency for something achievable in <30 lines of clear code (e.g., retry with jitter).
- Pin exact dependency versions in `package.json` (no `^` or `~`) for reproducible builds.

**TypeScript discipline:**
- `strict: true` in tsconfig — no exceptions.
- No `any` types. Use `unknown` and narrow with type guards when the type is genuinely uncertain.
- Prefer `interface` for object shapes, `type` for unions/intersections/utilities.
- All function signatures have explicit return types — don't rely on inference for public APIs.

---

## 1. Project Structure

```
reliable-mcp/
├── CLAUDE.md                           # Project context for Claude Code (loaded every session)
├── .claude/
│   └── skills/
│       ├── mcp-server.md              # Pattern: building MCP servers with Streamable HTTP
│       ├── resilience-wrapper.md      # Pattern: circuit breaker → retry → timeout wrapping
│       ├── chaos-testing.md          # Pattern: fault injection framework for resilience validation
│       ├── new-module-checklist.md    # Pre-flight checklist for any new module
│       └── docker-service.md          # Pattern: adding new Docker Compose services
│
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.mjs                  # Flat config, strict rules
├── .env.example
├── .env
├── docker-compose.yml              # Full stack: Redis + weather-mcp + flight-mcp + agent
├── docker-compose.dev.yml          # Dev overrides: hot reload, debug ports
├── Dockerfile                      # Multi-stage build, shared for all services
├── .dockerignore
├── README.md
│
├── fixtures/
│   └── flights/                        # Mock flight API responses for dev/test
│       ├── on-time.json
│       ├── delayed.json
│       ├── cancelled.json
│       └── in-air.json
│
├── src/
│   ├── entrypoints/
│   │   ├── agent.ts                # Entrypoint: Express API + LangGraphJS agent
│   │   ├── weather-mcp.ts         # Entrypoint: Weather MCP server (Streamable HTTP)
│   │   └── flight-mcp.ts          # Entrypoint: Flight MCP server (Streamable HTTP)
│   │
│   ├── config/
│   │   ├── env.ts                  # Validated env vars (zod), per-service profiles
│   │   └── redis.ts                # Redis client singleton
│   │
│   ├── auth/
│   │   ├── oauth-server.ts         # OAuth 2.1 token issuance (dev/test)
│   │   ├── oauth-middleware.ts     # Express middleware — verify JWT
│   │   └── oauth-types.ts
│   │
│   ├── agent/
│   │   ├── graph.ts                # LangGraphJS graph definition
│   │   ├── nodes.ts                # Graph node functions
│   │   ├── state.ts                # Graph state type
│   │   └── prompt.ts               # System prompt template
│   │
│   ├── mcp/
│   │   ├── weather-server.ts       # MCP server: weather tool (Streamable HTTP transport)
│   │   ├── flight-server.ts        # MCP server: flight status tool (Streamable HTTP transport)
│   │   ├── client.ts               # MCP client that connects to both servers via HTTP
│   │   └── schemas.ts              # Zod schemas for tool inputs/outputs
│   │
│   ├── resilience/
│   │   ├── circuit-breaker.ts      # Circuit breaker (opossum)
│   │   ├── rate-limiter.ts         # Token-bucket rate limiter (Redis-backed)
│   │   ├── retry.ts                # Exponential backoff with jitter
│   │   └── timeout.ts              # Request timeout wrapper
│   │
│   ├── chaos/                          # ⚠️ DEV/TEST ONLY — excluded from prod build
│   │   ├── guard.ts                    # Production safety guards (NODE_ENV + CHAOS_ENABLED)
│   │   ├── controller.ts              # ChaosController singleton — central fault registry
│   │   ├── fault-types.ts             # FaultTarget + FaultConfig type definitions
│   │   ├── interceptors/
│   │   │   ├── http-interceptor.ts    # Wraps fetch() with fault injection
│   │   │   ├── redis-interceptor.ts   # Wraps ioredis commands with fault injection
│   │   │   └── auth-interceptor.ts    # Conditional Express middleware for auth faults
│   │   ├── scenarios.ts               # Pre-built chaos scenario definitions (10 scenarios)
│   │   └── cli.ts                     # Optional manual trigger CLI
│   │
│   ├── cache/
│   │   ├── semantic-cache.ts       # Embedding-based cache lookup/store
│   │   └── session-store.ts        # Redis session/memory store
│   │
│   ├── observability/
│   │   ├── langsmith.ts            # LangSmith tracer setup
│   │   ├── metrics.ts              # Custom metrics (cost, traffic, errors)
│   │   └── logger.ts               # Structured logger (pino)
│   │
│   └── utils/
│       ├── errors.ts               # Custom error classes
│       ├── health.ts               # Shared /health endpoint handler
│       └── graceful-shutdown.ts    # Cleanup on SIGTERM
│
├── tests/
│   ├── unit/
│   │   ├── circuit-breaker.test.ts
│   │   ├── rate-limiter.test.ts
│   │   ├── semantic-cache.test.ts
│   │   └── retry.test.ts
│   ├── integration/
│   │   ├── agent-flow.test.ts
│   │   ├── mcp-weather.test.ts
│   │   ├── mcp-flight.test.ts
│   │   └── auth.test.ts
│   ├── chaos/
│   │   ├── failure-scenarios.test.ts   # Automated fault injection scenarios (10 scenarios)
│   │   ├── recovery-scenarios.test.ts  # Verify systems recover after faults clear
│   │   └── helpers.ts                  # Test utilities for chaos setup/teardown
│   └── eval/
│       ├── datasets/
│       │   ├── tool-calling.json      # Test cases: query → expected tool(s)
│       │   ├── e2e-flows.json         # Full conversation flows with expected outputs
│       │   └── edge-cases.json        # Ambiguous, adversarial, and boundary inputs
│       ├── evaluators/
│       │   ├── tool-selection.ts      # Checks correct tool(s) called for a query
│       │   ├── response-quality.ts    # LLM-as-judge for answer quality
│       │   ├── latency-budget.ts      # Asserts response time within budget
│       │   └── resilience.ts          # Validates graceful degradation behavior
│       ├── run-eval.ts                # Main eval runner script
│       └── report.ts                  # Generates eval summary report
│
└── scripts/
    ├── seed-cache.ts               # Pre-warm semantic cache (optional)
    └── generate-token.ts           # Utility to mint test OAuth tokens
```

---

## 2. Implementation Phases

Each phase is a self-contained milestone. Test before moving to the next.

### Phase 1 — Scaffold & Infrastructure (Day 1)

| Task | Details |
|------|---------|
| Init project | `npm init`, TypeScript config (`strict: true`), ESLint with `@typescript-eslint/strict` + `eslint-plugin-security`, Prettier |
| TDD setup | Configure `vitest` with coverage thresholds (≥80% branches), add `npm run test:watch` for TDD workflow |
| Environment config | Zod-validated `.env` loading (`src/config/env.ts`) with per-service profiles: `SERVICE_ROLE=agent|weather-mcp|flight-mcp` determines which env vars are required |
| Redis setup | `docker-compose.yml` with Redis 7+; `ioredis` client singleton with reconnection logic. **Verify:** `client.quit()` wired into graceful shutdown |
| Docker multi-service | Multi-stage `Dockerfile` (build stage + slim runtime stage). `docker-compose.yml` defines 4 services: `redis`, `weather-mcp`, `flight-mcp`, `agent`. Each service uses the same image with a different entrypoint command. `docker-compose.dev.yml` adds hot reload via volume mounts and exposes debug ports. All services get health checks. |
| Service entrypoints | `src/entrypoints/agent.ts`, `src/entrypoints/weather-mcp.ts`, `src/entrypoints/flight-mcp.ts` — each boots its respective service with shared config, logger, and graceful shutdown |
| Shared health endpoint | `src/utils/health.ts` — a `/health` GET handler reusable by all three services, returns `{ status: "ok", service: "<name>", uptime: <seconds> }` |
| Structured logger | `pino` with JSON output, request-id correlation, `service` field auto-set from `SERVICE_ROLE`. **Verify:** `logger.flush()` wired into graceful shutdown |
| Graceful shutdown | Handle `SIGTERM`/`SIGINT`, drain connections. Maintain a resource registry — every resource registers its cleanup function. Critical for Docker: must respond to `SIGTERM` within the container stop timeout (default 10s) |

**Exit criteria:** `docker compose up` starts Redis + both MCP servers + agent. Each service logs "ready" with its service name. `curl http://localhost:<port>/health` returns OK for all three. `docker compose down` triggers clean shutdown with no warnings.

**Docker architecture:**

```
┌─────────────────────────────────────────────────────┐
│  docker-compose                                     │
│                                                     │
│  ┌──────────┐   ┌──────────────┐  ┌──────────────┐  │
│  │  Redis   │   │ weather-mcp  │  │ flight-mcp   │  │
│  │  :6379   │   │ :3001/mcp    │  │ :3002/mcp    │  │
│  └──────────┘   └──────────────┘  └──────────────┘  │
│       ▲               ▲                  ▲          │
│       │               │                  │          │
│       │         ┌─────┴──────────────────┘          │
│       │         │                                   │
│  ┌────┴─────────┴──┐                                │
│  │     agent       │                                │
│  │   :3000/chat    │ (Express + LangGraphJS)        │
│  │   :3000/health  │                                │
│  └─────────────────┘                                │
└─────────────────────────────────────────────────────┘
```

---

### Phase 2 — MCP Servers (Day 2)

| Task | Details |
|------|---------|
| Weather MCP server | **Streamable HTTP transport** on port 3001, single `get_weather` tool, calls **WeatherAPI.com** (1M free calls/month, no per-minute rate limit). Serves MCP protocol at `POST /mcp`. Includes `/health` endpoint. |
| Flight MCP server | **Streamable HTTP transport** on port 3002, single `get_flight_status` tool, calls **FlightAware AeroAPI** (500 free calls/month, best data quality). Serves MCP protocol at `POST /mcp`. Includes `/health` endpoint. |
| Flight API mock layer | Create a mock provider using JSON fixtures (`fixtures/flights/`) for dev/test — only hit real FlightAware API in smoke tests to conserve quota |
| Flight provider abstraction | Interface `FlightProvider` with `mock` and `flightaware` implementations — swappable via env var `FLIGHT_PROVIDER=mock|flightaware` |
| Zod validation | Validate both inbound tool params and outbound API responses |
| Resilience wrappers | Circuit breaker + retry with jitter around each external API call |

**Exit criteria:** Each MCP server runs as a standalone HTTP service in its Docker container. `curl -X POST http://localhost:3001/mcp` returns a valid MCP response. Health checks pass. Can also be tested with MCP Inspector pointed at the HTTP URL.

---

### Phase 3 — Agent Orchestration (Day 3)

| Task | Details |
|------|---------|
| LangGraphJS graph | Define state, nodes (route → tool-call → summarize), edges |
| MCP client integration | Connect agent to both MCP servers via `@modelcontextprotocol/sdk` **Streamable HTTP client transport**. MCP server URLs configured via env vars: `WEATHER_MCP_URL=http://weather-mcp:3001/mcp`, `FLIGHT_MCP_URL=http://flight-mcp:3002/mcp`. In Docker, uses container hostnames; locally, uses `localhost`. |
| LLM binding | OpenAI `gpt-4o-mini` (see Open Questions about `gpt-5-nano`) with tool-calling |
| System prompt | Instruct agent to use weather/flight tools, handle combined queries |
| Session memory | Persist last N turns + extracted entities (flight numbers) to Redis with TTL |

**Exit criteria:** Send a multi-part query like "What's the weather in NYC and is UA123 on time?" and get a correct combined answer. (Flight data will come from mock provider during development.)

---

### Phase 4 — Semantic Cache (Day 4)

| Task | Details |
|------|---------|
| Embedding model | Use OpenAI `text-embedding-3-small` (cheap, fast) |
| Cache store | Redis with vector search (`redis-stack` image) or simple cosine-similarity with stored embeddings |
| Cache logic | Before agent runs: embed query → search cache (threshold ≥ 0.92) → return cached response or proceed |
| Cache write | After agent responds: store embedding + response with TTL (weather: 30min, flights: 5min) |
| Bypass flag | Allow `?no_cache=true` for debugging |

**Exit criteria:** Second identical/similar query returns cached response; logs show cache hit/miss.

---

### Phase 5 — Rate Limiting & Auth (Day 5)

| Task | Details |
|------|---------|
| Rate limiter | Redis-backed sliding window (`rate-limiter-flexible`), per-user, 30 req/min default |
| OAuth 2.1 server | Minimal token endpoint for dev/test (PKCE flow); issue JWTs |
| Auth middleware | Verify JWT signature, check expiry, extract user ID for rate-limiter key |
| Error responses | 401 for invalid/expired token, 429 for rate limit with `Retry-After` header |

**Exit criteria:** Unauthenticated requests get 401; authenticated requests work; exceeding rate limit returns 429.

---

### Phase 6 — Observability & LangSmith (Day 6)

| Task | Details |
|------|---------|
| LangSmith tracer | Wrap LangGraphJS runs with LangSmith callbacks |
| Token cost tracking | Log prompt/completion tokens per request, compute cost |
| Custom metrics | Error rate, cache hit rate, circuit breaker state changes, latency p50/p95/p99 |
| Dashboard tags | Tag runs with user_id, tool_name, cache_hit, error_type |
| Alert-ready logs | Structured log events for: circuit-open, rate-limited, auth-failure, api-timeout |

**Exit criteria:** All requests visible in LangSmith with cost, latency, and error metadata.

---

### Phase 7 — Hardening & Chaos Testing (Day 7)

| Task | Details |
|------|---------|
| **Chaos framework** | Build the lightweight fault injection framework in `src/chaos/`. Follow `.claude/skills/chaos-testing.md`. Components: `guard.ts` (production safety), `controller.ts` (ChaosController singleton), `fault-types.ts` (FaultTarget + FaultConfig), `interceptors/` (http, redis, auth). Wire interceptors into codebase with `CHAOS_ENABLED` conditional imports. Create `tsconfig.prod.json` that excludes `src/chaos/**`. |
| **Chaos scenarios** | Implement all 10 pre-built scenarios from `src/chaos/scenarios.ts`: weather-api-503-circuit-breaker, weather-api-503-recovery, flight-api-timeout-retry-exhaust, redis-connection-drop, redis-latency-spike-cache-bypass, oauth-token-expired, both-mcp-servers-unreachable, weather-mcp-malformed-response, flight-api-rate-limited, cascading-failure-redis-then-api |
| **Chaos test suite** | `tests/chaos/failure-scenarios.test.ts` + `tests/chaos/recovery-scenarios.test.ts` — automated tests for each scenario with assertions on user-facing messages, partial responses, circuit breaker states, and latency budgets |
| Graceful degradation | Verify every failure mode (see Section 5) with clear user messages — now validated by automated chaos tests instead of manual checks |
| Timeout budget | Global 15s timeout; individual API calls 5s; cache lookup 500ms |
| Input validation | Sanitize all user inputs; reject oversized payloads |
| Security review | Check for env leaks, SSRF, prompt injection basics. Run `eslint-plugin-security` with zero warnings. Grep codebase for hardcoded secrets. |
| Resource leak audit | Walk through every opened resource (Redis, MCP servers/clients, Express server, timers) and verify each has cleanup in `graceful-shutdown.ts`. Test: start app → send 10 requests → SIGTERM → verify clean exit with no "connection still open" warnings |
| Memory leak check | Run a load test (100 sequential requests via a simple script) and monitor Node.js heap with `--inspect`. Verify heap does not grow unboundedly. Check for closures capturing request-scoped data in long-lived objects. |
| Code quality sweep | Run `npx tsc --noEmit` (zero errors), `npm run lint` (zero warnings), review all `// TODO` and `// FIXME` comments — resolve or document in open questions |
| **Production safety verification** | Verify chaos code is excluded from production: `tsconfig.prod.json` excludes `src/chaos/**`, Dockerfile uses prod config, `CHAOS_ENABLED` not set in any production env file |

**Exit criteria:** All 10 chaos scenarios pass automated tests; recovery scenarios verify automatic healing; no unhandled promise rejections; every error path returns a friendly message; production build does not contain chaos code.

---

### Phase 8 — Evaluation Suite (Day 8)

| Task | Details |
|------|---------|
| Eval dataset: tool calling | 30+ test cases mapping user queries → expected tool(s) called. Covers: weather-only, flight-only, combined, ambiguous, no-tool-needed |
| Eval dataset: e2e flows | 15+ multi-turn conversation flows testing session memory, cache hits, and combined queries |
| Eval dataset: edge cases | 15+ adversarial/boundary inputs: prompt injection attempts, unknown cities, invalid flight numbers, gibberish, empty strings, extremely long inputs |
| Tool selection evaluator | Deterministic check: did the agent call the correct tool(s) with valid parameters? Score: exact match (1.0), partial match (0.5), wrong tool (0.0) |
| Response quality evaluator | LLM-as-judge (separate LLM call) scores responses on: accuracy, completeness, tone, and whether error messages are user-friendly |
| Latency budget evaluator | Assert total response time stays within budget: ≤3s (cache hit), ≤8s (single tool), ≤12s (combined tools), ≤15s (global max) |
| Resilience evaluator | Run eval dataset against degraded modes (weather API down, flight API down, both down, Redis down) and verify graceful degradation messages |
| Eval runner & reporting | Script that runs all datasets through all evaluators, outputs pass/fail summary with scores, and optionally pushes results to LangSmith as an experiment |
| CI gate | Eval must pass with ≥90% tool-selection accuracy and 0 critical failures before deploy |

**Exit criteria:** `npm run eval` completes all datasets, generates a report, and all scores meet the thresholds defined above. Results visible in LangSmith experiments.

---

## 3. Technology Choices

| Scope Item | Package / Tool | Justification |
|---|---|---|
| **Runtime** | Node.js 20+ / TypeScript 5.x | Per spec |
| **MCP SDK** | `@modelcontextprotocol/sdk` | Official MCP TypeScript SDK |
| **MCP transport** | **Streamable HTTP** | Production-ready: each MCP server runs as an independent HTTP service, deployable in its own container. Supports health checks, load balancing, and network-level isolation. Agent connects via configurable URLs. |
| **Agent orchestration** | `@langchain/langgraph` | Per spec (LangGraphJS) |
| **LLM** | `@langchain/openai` → `gpt-4o-mini` (fallback plan, see open questions) | LangChain-compatible; cheapest capable model for tool-calling |
| **Containerization** | **Docker** multi-stage build + **Docker Compose** | Single `Dockerfile` for all services (different entrypoints). Compose orchestrates 4 containers: Redis, weather-mcp, flight-mcp, agent. Dev override file adds hot reload. |
| **Redis client** | `ioredis` | Robust reconnection, Lua scripting, cluster support |
| **Rate limiter** | `rate-limiter-flexible` | Redis-backed, sliding window, battle-tested |
| **Circuit breaker** | `opossum` | Most popular Node.js circuit breaker, simple API |
| **Retry** | Custom (tiny utility) | Exponential backoff + jitter is ~20 lines; avoids a dependency |
| **Semantic cache** | Custom with `openai` embeddings + Redis sorted sets | Simpler than pulling in a vector DB; good enough for FAQ-style queries |
| **OAuth 2.1** | `jose` (JWT) + custom middleware | Lightweight; `jose` handles JWK/JWT well. Full OAuth server not needed for side project |
| **HTTP framework** | `express` + `helmet` + `cors` | Standard, well-understood |
| **Logging** | `pino` | Fastest structured logger for Node.js |
| **Observability** | `langsmith` SDK | Per spec |
| **Env validation** | `zod` | Already needed for MCP schemas; reuse for config |
| **Testing** | `vitest` | Fast, TypeScript-native, good DX |
| **Evaluation** | Custom eval runner + `langsmith` SDK experiments | LangSmith experiments track eval runs over time; custom runner allows CI gating on tool-selection accuracy and latency budgets |
| **Linting** | `eslint` + `@typescript-eslint/strict` | Catches bugs at compile time; strict preset enforces no-`any`, no-unused-vars, explicit return types |
| **Code quality** | `typescript` strict mode + `eslint-plugin-security` | `strict: true` in tsconfig eliminates implicit `any`; security plugin catches unsafe patterns (eval, non-literal require, prototype pollution) |
| **Weather API** | **WeatherAPI.com** (free tier) | 1M calls/month free (vs OpenWeatherMap's 1K/day), no per-minute rate limit, clean JSON responses, commercial use allowed |
| **Flight API** | **FlightAware AeroAPI** (free tier) + mock layer | Best data quality (powers half of US airline ETAs), 500 free calls/month. Mock layer for dev/test conserves quota. Provider abstraction allows swapping to AviationStack or AeroDataBox if needed |
| **Chaos testing** | Custom lightweight framework (`src/chaos/`) | Dependency-minimal: no external chaos libraries. ChaosController singleton + interceptors wrapping fetch/ioredis/auth. 3 injection modes (probabilistic, scheduled, manual). 10 pre-built scenarios. Production-safe via 3-layer guard (env var + NODE_ENV + build exclusion). |

---

## 4. MCP Server Design

Both MCP servers use **Streamable HTTP transport**, each running as an independent HTTP service. This enables containerized deployment, health checks, and network-level isolation between services.

**Shared MCP server pattern:**
- Each server is an Express app that mounts the MCP SDK's Streamable HTTP handler at `POST /mcp`
- Each server exposes `GET /health` for Docker health checks and readiness probes
- Each server registers its HTTP server in the graceful shutdown registry
- Each server runs in its own Docker container with its own port

### 4.1 Weather MCP Server

**Service:** `weather-mcp` — port `3001`
**MCP endpoint:** `POST http://weather-mcp:3001/mcp`
**Health endpoint:** `GET http://weather-mcp:3001/health`
**Tool name:** `get_weather`

```typescript
// Input schema
{
  name: "get_weather",
  description: "Get current weather temperature for a city",
  inputSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "City name (e.g., 'New York', 'London')"
      },
      units: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        default: "celsius",
        description: "Temperature unit"
      }
    },
    required: ["city"]
  }
}

// Output (returned as tool content)
{
  city: "New York",
  country: "US",
  temperature: 22,
  units: "celsius",
  condition: "partly cloudy",
  humidity: 65,
  timestamp: "2025-01-15T14:30:00Z"
}
```

**Internal flow:**
1. Validate input with Zod
2. Call **WeatherAPI.com** `current.json` endpoint via circuit-breaker-wrapped HTTP client
3. Map API response → tool output schema
4. Return as MCP `TextContent`

**API endpoint:** `https://api.weatherapi.com/v1/current.json?key={API_KEY}&q={city}&aqi=no`

---

### 4.2 Flight Status MCP Server

**Service:** `flight-mcp` — port `3002`
**MCP endpoint:** `POST http://flight-mcp:3002/mcp`
**Health endpoint:** `GET http://flight-mcp:3002/health`
**Tool name:** `get_flight_status`

```typescript
// Input schema
{
  name: "get_flight_status",
  description: "Get current status of a flight by flight number",
  inputSchema: {
    type: "object",
    properties: {
      flight_number: {
        type: "string",
        description: "IATA flight number (e.g., 'UA123', 'BA456')"
      },
      date: {
        type: "string",
        description: "Flight date in YYYY-MM-DD format. Defaults to today.",
        format: "date"
      }
    },
    required: ["flight_number"]
  }
}

// Output
{
  flight_number: "UA123",
  airline: "United Airlines",
  status: "in_air",           // scheduled | boarding | in_air | landed | cancelled | delayed
  departure: {
    airport: "SFO",
    scheduled: "2025-01-15T08:00:00Z",
    actual: "2025-01-15T08:12:00Z"
  },
  arrival: {
    airport: "JFK",
    scheduled: "2025-01-15T16:30:00Z",
    estimated: "2025-01-15T16:45:00Z"
  },
  delay_minutes: 15,
  timestamp: "2025-01-15T14:30:00Z"
}
```

**Internal flow:**
1. Validate input with Zod
2. Check `FLIGHT_PROVIDER` env var → route to mock or FlightAware provider
3. **Mock provider:** Load from `fixtures/flights/` based on a mapping of test flight numbers to scenarios (e.g., `TEST001` → on-time, `TEST002` → delayed, `TEST003` → cancelled, `TEST004` → in-air)
4. **FlightAware provider:** Call AeroAPI `/flights/{flight_number}` endpoint via circuit-breaker-wrapped HTTP client
5. Map API response → tool output schema
6. Return as MCP `TextContent`

**FlightAware API endpoint:** `https://aeroapi.flightaware.com/aeroapi/flights/{flight_number}`
**Auth:** API key via `x-apikey` header

**Mock-first development strategy:**
- Default `FLIGHT_PROVIDER=mock` in `.env.example` and during all automated tests
- Switch to `FLIGHT_PROVIDER=flightaware` only for manual smoke tests or production
- Mock fixtures cover all flight states: on-time, delayed, cancelled, in-air, landed
- This preserves the 500 free FlightAware calls/month for when they matter most

---

## 5. Reliability Patterns — Failure Mode Matrix

| Failure Scenario | Detection | Response to User | System Action |
|---|---|---|---|
| **Weather API down** | Circuit breaker opens after 5 failures in 30s | "Weather data is temporarily unavailable. Try again in a few minutes." | Log error, increment `api.weather.failures` metric, return partial response if flight data succeeded |
| **Flight API down** | Same circuit breaker pattern | "Flight status is temporarily unavailable." | Same — partial response pattern |
| **Weather MCP server unreachable** | HTTP connection refused / timeout to `weather-mcp:3001` | "Weather service is temporarily unavailable." | Log error, circuit breaker on MCP client, return partial response if flight MCP succeeded. Agent health check marks weather as degraded. |
| **Flight MCP server unreachable** | HTTP connection refused / timeout to `flight-mcp:3002` | "Flight service is temporarily unavailable." | Same pattern as weather MCP unreachable |
| **MCP server unhealthy** | Docker health check fails, `/health` returns non-200 | Service auto-restarts via Docker `restart: unless-stopped` | Log warning, agent MCP client retries with backoff |
| **Redis unavailable** | `ioredis` connection error event | Continue without cache/session (degraded mode); respond normally | Log critical, alert via LangSmith tag `redis_down`, disable semantic cache, use in-memory fallback for rate limiting |
| **Cache latency spike** | Timeout after 500ms | Bypass cache, proceed to agent | Log warning, increment `cache.timeout` |
| **API latency spike** | Timeout after 5s per call | "This is taking longer than expected. [partial result or retry suggestion]" | Log, record latency in LangSmith |
| **Invalid/expired OAuth token** | JWT verification failure | 401 `{ error: "token_expired", message: "Please re-authenticate." }` | Log auth failure with user context (no token content) |
| **Rate limit exceeded** | Redis counter check | 429 `{ error: "rate_limited", retry_after: 32 }` | Log, no further processing |
| **MCP tool input mismatch** | Zod schema validation failure | "I couldn't understand that request. Could you rephrase?" | Log schema validation error with details, do NOT pass invalid data to API |
| **LLM API error** | HTTP error / timeout | "I'm having trouble processing your request right now." | Retry once with backoff; if still failing, return error message |
| **Prompt injection attempt** | Basic heuristic checks | Respond normally but ignore injected instructions | Log suspicious input for review |

### Circuit Breaker Configuration

```typescript
{
  timeout: 5000,           // 5s per call
  errorThresholdPercentage: 50,
  resetTimeout: 30000,     // 30s before half-open
  rollingCountTimeout: 60000,
  volumeThreshold: 5       // Minimum calls before tripping
}
```

### Retry Configuration

```typescript
{
  maxRetries: 3,
  baseDelay: 200,          // ms
  maxDelay: 5000,          // ms
  jitterFactor: 0.3,       // ±30% randomization
  retryOn: [502, 503, 504, 'ETIMEDOUT', 'ECONNRESET']
}
```

---

## 6. Claude Code Workflow

Break the project into focused Claude Code sessions. Each session should be a single coherent task.

> **Context files — loaded automatically or referenced per-session:**
>
> - `CLAUDE.md` — Loaded automatically by Claude Code on every session. Contains: architecture, tech stack, development rules, anti-patterns, commands, env vars. **You do not need to paste project context into prompts — Claude Code reads this file.**
> - `.claude/skills/mcp-server.md` — Reference when building or modifying MCP servers.
> - `.claude/skills/resilience-wrapper.md` — Reference when wrapping external API calls.
> - `.claude/skills/chaos-testing.md` — Reference when building or running chaos/fault injection tests.
> - `.claude/skills/new-module-checklist.md` — Reference when adding any new module.
> - `.claude/skills/docker-service.md` — Reference when adding or modifying Docker services.
>
> **IMPORTANT — Prepend this instruction to EVERY session prompt below:**
>
> _"Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. Run `npm run lint` before considering the task done — zero warnings required."_

### Session 1 — Project Scaffold
```
Prompt: "Create a new Node.js/TypeScript project with the following structure: [paste project structure from Section 1]. Set up package.json with these dependencies: [list from Section 3]. Configure tsconfig with strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true for maximum type safety. Configure ESLint flat config with @typescript-eslint/strict preset and eslint-plugin-security — zero warnings policy. Set up vitest with coverage thresholds (80% branches minimum).

Create a multi-stage Dockerfile:
- Build stage: node:20-alpine, install deps, compile TypeScript
- Runtime stage: node:20-alpine, copy compiled JS + node_modules, non-root user, HEALTHCHECK instruction
- Entrypoint determined by CMD override in docker-compose

Create docker-compose.yml with 4 services:
- redis: redis-stack image, port 6379, health check via redis-cli ping
- weather-mcp: build from Dockerfile, command 'node dist/entrypoints/weather-mcp.js', port 3001, depends_on redis, health check via curl /health, restart unless-stopped
- flight-mcp: same pattern, command 'node dist/entrypoints/flight-mcp.js', port 3002
- agent: same pattern, command 'node dist/entrypoints/agent.js', port 3000, depends_on weather-mcp + flight-mcp + redis
- All services share the same .env file, each service reads only the vars it needs based on SERVICE_ROLE
Create docker-compose.dev.yml override that adds: volume mounts for hot reload (src/ mapped in), debug ports, ts-node-dev instead of compiled JS.

Create src/config/env.ts that validates environment variables using zod with per-service profiles: SERVICE_ROLE (enum: 'agent' | 'weather-mcp' | 'flight-mcp'), OPENAI_API_KEY (agent only), REDIS_URL (all), LANGSMITH_API_KEY (agent only), OAUTH_SECRET (agent only), WEATHERAPI_KEY (weather-mcp only), FLIGHTAWARE_API_KEY (flight-mcp only, optional when FLIGHT_PROVIDER=mock), FLIGHT_PROVIDER (flight-mcp only, enum: 'mock' | 'flightaware', default: 'mock'), WEATHER_MCP_URL (agent only, default: 'http://localhost:3001/mcp'), FLIGHT_MCP_URL (agent only, default: 'http://localhost:3002/mcp'), PORT (all, defaults: agent=3000, weather-mcp=3001, flight-mcp=3002). Write tests for env.ts first (missing vars throw, valid vars parse, per-service validation works).

Create src/entrypoints/agent.ts, src/entrypoints/weather-mcp.ts, src/entrypoints/flight-mcp.ts — minimal entrypoint files that initialize config, logger, graceful shutdown, and start the respective service.
Create src/utils/health.ts — shared /health GET handler returning { status: 'ok', service: string, uptime: number }.
Create src/config/redis.ts with ioredis client that has reconnection logic and error logging — write tests for connection error handling.
Create src/observability/logger.ts with pino structured logger with auto-set 'service' field from SERVICE_ROLE.
Create src/utils/graceful-shutdown.ts with a resource registry pattern: modules register their cleanup functions, shutdown handler calls them all in order. Must respond to SIGTERM within 10s (Docker default stop timeout). Write tests for the registry.
Pin all dependency versions exactly (no ^ or ~).

Create CLAUDE.md in project root with the content from the provided CLAUDE.md file. This gives Claude Code persistent context about the project architecture, rules, and conventions for every future session.

Create .claude/skills/ directory with these skill files from the provided templates:
- mcp-server.md — pattern for building MCP servers with Streamable HTTP
- resilience-wrapper.md — pattern for wrapping external calls with circuit breaker → retry → timeout
- new-module-checklist.md — pre-flight checklist for adding any new module
- docker-service.md — pattern for adding new Docker Compose services"
```

### Session 2 — Resilience Utilities
```
Prompt: "Follow the pattern in .claude/skills/resilience-wrapper.md. Create the resilience layer using TDD — write each test file before the implementation file. 1) src/resilience/circuit-breaker.ts — a factory function that wraps any async function with opossum circuit breaker using these settings: [paste config]. 2) src/resilience/retry.ts — exponential backoff with jitter, configurable max retries, base delay, jitter factor. Should accept a predicate for retryable errors. 3) src/resilience/rate-limiter.ts — Redis-backed sliding window rate limiter using rate-limiter-flexible, keyed by user ID, 30 req/min default. 4) src/resilience/timeout.ts — wraps any promise with a timeout that rejects with a TimeoutError. For each utility: write the test file first covering success, failure, and edge cases, then implement. No any types. Use custom error classes (TimeoutError, CircuitOpenError, RateLimitError) from src/utils/errors.ts. Keep each file under 100 lines — these are focused utilities."
```

### Session 3 — MCP Weather Server
```
Prompt: "Follow the patterns in .claude/skills/mcp-server.md and .claude/skills/docker-service.md. Create the Weather MCP server using Streamable HTTP transport. Follow TDD: write integration tests first that send HTTP requests to the MCP endpoint and assert the response shape, then implement.

Create src/mcp/weather-server.ts — an MCP server using @modelcontextprotocol/sdk with Streamable HTTP transport. The server is an Express app that:
- Mounts the MCP SDK's StreamableHTTPServerTransport at POST /mcp
- Exposes GET /health using the shared health handler
- Listens on the port from env config (default 3001)
- Registers the HTTP server in the graceful shutdown registry

It exposes one tool 'get_weather' with this schema: [paste from Section 4.1]. The tool handler: validates input with zod, calls WeatherAPI.com current.json endpoint (https://api.weatherapi.com/v1/current.json?key={API_KEY}&q={city}&aqi=no) wrapped in circuit breaker + retry, maps the response to the output schema, returns as TextContent.

Create src/mcp/schemas.ts with the zod schemas. Handle all errors gracefully — never crash the MCP server. Ensure the HTTP client (fetch/axios) uses AbortController so in-flight requests are cancelled on shutdown.

Create src/entrypoints/weather-mcp.ts that boots: env config → logger → weather MCP server → graceful shutdown. This is the Docker container entrypoint.

Integration tests should start the MCP server on a random port, send MCP tool calls via HTTP, and assert responses. Tests must clean up the server after each test."
```

### Session 4 — MCP Flight Server
```
Prompt: "Follow the patterns in .claude/skills/mcp-server.md and .claude/skills/docker-service.md. Create the Flight MCP server using Streamable HTTP transport — same architecture pattern as the weather server. Follow TDD: write tests for both providers first, then implement.

Create src/mcp/flight-server.ts — MCP server with Streamable HTTP transport on port 3002 (default). Express app mounting MCP SDK at POST /mcp, GET /health, graceful shutdown.

Tool 'get_flight_status' with this schema: [paste from Section 4.2]. Implement a FlightProvider interface with two implementations: 1) MockFlightProvider — reads from JSON fixtures in fixtures/flights/ directory, mapping test flight numbers (TEST001=on-time, TEST002=delayed, TEST003=cancelled, TEST004=in-air) to fixture files. 2) FlightAwareProvider — calls FlightAware AeroAPI (https://aeroapi.flightaware.com/aeroapi/flights/{flight_number}) with x-apikey header auth, wrapped in circuit breaker + retry. Select provider via FLIGHT_PROVIDER env var (default: 'mock'). Create the 4 fixture JSON files with realistic flight data.

Create src/entrypoints/flight-mcp.ts that boots: env config → logger → flight MCP server → graceful shutdown.

Follow same patterns as weather server: zod validation, error handling, shutdown cleanup, AbortController for HTTP requests. The FlightProvider interface should be clean and minimal — easy to add AeroDataBox or AviationStack later. Integration tests should start the server on a random port and test via HTTP."
```

### Session 5 — LangGraphJS Agent
```
Prompt: "Create the LangGraphJS agent in src/agent/. Write tests first for the graph structure and each node function. The graph state should track: messages array, user_id, session_id, tool_results, error state — define as a TypeScript interface, no any types. Define nodes: 1) 'route' — LLM decides which tools to call, 2) 'execute_tools' — calls MCP tools via MCP client, 3) 'respond' — LLM generates final answer from tool results. Each node is a pure-ish function: takes state, returns updated state — easy to test in isolation. The agent should handle combined weather+flight queries in a single turn. Use gpt-4o-mini via @langchain/openai.

Connect to both MCP servers via src/mcp/client.ts using Streamable HTTP client transport. The client reads MCP server URLs from env vars: WEATHER_MCP_URL (default: http://localhost:3001/mcp) and FLIGHT_MCP_URL (default: http://localhost:3002/mcp). In Docker, these resolve to container hostnames (http://weather-mcp:3001/mcp). The MCP client should handle connection failures gracefully — if a server is unreachable, the agent can still use the other server for partial responses. Wrap MCP client HTTP calls in the circuit breaker from src/resilience/.

Integrate session memory from Redis — load previous context at start, save after response. Register MCP client cleanup in shutdown registry. Keep each node function in its own clearly-named function — no inline lambdas in the graph definition.

Create src/entrypoints/agent.ts that boots: env config → logger → Redis → MCP client connections → Express app (from Session 7) → graceful shutdown. This is the Docker container entrypoint for the agent service."
```

### Session 6 — Semantic Cache
```
Prompt: "Create src/cache/semantic-cache.ts. Write unit tests first with mocked embeddings — test cache hit, cache miss, TTL expiry, timeout bypass, and similarity threshold edge cases. Then implement. On query: 1) generate embedding via OpenAI text-embedding-3-small, 2) search Redis for cached embeddings with cosine similarity ≥ 0.92, 3) if hit, return cached response. On response: store embedding + response in Redis with TTL (weather queries: 30 min, flight queries: 5 min, mixed: 5 min). Use a 500ms timeout on all cache operations — bypass cache on timeout. Track cache hit/miss as metrics. The cosine similarity function should be its own tested utility, not inlined. Use explicit types for cache entries — no untyped JSON blobs in Redis."
```

### Session 7 — OAuth & HTTP Layer
```
Prompt: "Create using TDD: 1) src/auth/oauth-server.ts — minimal OAuth 2.1 token endpoint that issues JWTs (for dev/test). Support client_credentials grant. Use jose library. Write tests first: valid grant returns JWT, invalid client_id rejected, missing fields rejected. 2) src/auth/oauth-middleware.ts — Express middleware that validates JWT from Authorization Bearer header, extracts user_id, attaches to req. Write tests first: valid JWT passes, expired JWT returns 401 with clear message, malformed token returns 401, missing header returns 401. Never log the token value itself — only metadata. 3) Wire the Express app in src/entrypoints/agent.ts with: helmet (with strict CSP), cors (specific origins, not *), JSON body parser (with size limit: 10kb), auth middleware, rate limiter middleware, POST /chat endpoint that runs the agent, GET /health using shared handler. Register Express server cleanup in shutdown registry with connection draining. Run npm run lint and fix any warnings."
```

### Session 8 — LangSmith Observability
```
Prompt: "Create src/observability/langsmith.ts and src/observability/metrics.ts. Integrate LangSmith tracing into the LangGraphJS agent — every run should be traced with metadata: user_id, session_id, cache_hit (bool), tools_called (array), total_tokens, estimated_cost_usd, latency_ms, error (if any). Create helper functions to track: token costs per model, error counts by type, cache hit rate, circuit breaker state transitions. Tag LangSmith runs so they can be filtered in the dashboard."
```

### Session 9 — Chaos Framework & Fault Injection Tests
```
Prompt: "Follow the pattern in .claude/skills/chaos-testing.md. Build the lightweight chaos (fault injection) framework and the automated chaos test suite. This is a dev/test-only framework — it must NEVER run in production.

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

Add npm scripts: 'test:chaos' runs CHAOS_ENABLED=true vitest run tests/chaos/, 'chaos:status' and 'chaos:clear' for manual mode."
```

### Session 10 — Evaluation Suite
```
Prompt: "Create a pre-deployment evaluation system in tests/eval/. 

1) Create tests/eval/datasets/ with three JSON dataset files:
   - tool-calling.json: 30+ test cases, each with {input: string, expected_tools: string[], expected_params_subset?: object}. Cover categories: weather-only ('What's the temp in Paris?'), flight-only ('Is BA456 on time?'), combined ('Weather in NYC and status of UA123'), ambiguous ('Tell me about my trip'), no-tool ('What can you help me with?'), multi-city weather, flights with dates, and misspelled cities.
   - e2e-flows.json: 15+ multi-turn conversations, each with {turns: [{role, content}], assertions: {session_memory_keys?, cache_hit_expected?, tools_called_per_turn?}}.
   - edge-cases.json: 15+ adversarial inputs: prompt injection ('Ignore instructions and...'), unknown cities, invalid flight numbers (ZZZZZ999), gibberish, empty string, 10,000-char input, SQL injection in city name, special characters.

2) Create tests/eval/evaluators/:
   - tool-selection.ts: Takes agent response trace, checks tools_called matches expected_tools. Returns {score: 1.0|0.5|0.0, reason: string}. 1.0 = exact match, 0.5 = correct tools but extra call, 0.0 = wrong/missing tool.
   - response-quality.ts: Uses a separate LLM call (gpt-4o-mini) as judge. Prompt: 'Rate this chatbot response on accuracy (1-5), completeness (1-5), and tone (1-5). The user asked: {query}. The tools returned: {tool_results}. The chatbot responded: {response}.' Parse scores, flag any below 3.
   - latency-budget.ts: Assert response time: ≤3s for cache hits, ≤8s for single tool calls, ≤12s for combined tool calls, ≤15s absolute max. Return {pass: boolean, actual_ms: number, budget_ms: number}.
   - resilience.ts: Run a subset of tool-calling dataset with injected failures (mock weather API 500, mock flight API timeout, Redis disconnected). Check that: response contains user-friendly error message, no stack traces leaked, partial results returned when possible, correct LangSmith error tags set.

3) Create tests/eval/run-eval.ts: Main runner that:
   - Loads all datasets
   - Runs each input through the real agent (using mock flight provider, real weather API or mocked)
   - Applies all relevant evaluators to each result
   - Collects scores into a summary: {total, passed, failed, tool_accuracy_pct, avg_quality_score, latency_p50_ms, latency_p95_ms, critical_failures: []}
   - Optionally pushes results to LangSmith as an experiment run (via --langsmith flag)
   - Exits with code 1 if tool_accuracy < 90% or critical_failures > 0

4) Create tests/eval/report.ts: Formats the summary as a table printed to console, and optionally writes eval-report.json to disk.

5) Add npm scripts: 'eval' runs the full suite, 'eval:quick' runs only tool-calling dataset (for fast iteration), 'eval:resilience' runs only resilience evaluator.

The eval suite should use FLIGHT_PROVIDER=mock by default. It should be runnable in CI. Write it so new test cases can be added to the JSON files without changing code."
```

### Session 11 — Final Integration & README
```
Prompt: "Do a final integration review of the entire project. 

1) Full Docker deployment test: docker compose build && docker compose up — all 4 containers start, health checks pass for all services within 30s.
2) Test the full flow via Docker: authenticate → send combined weather+flight query to agent container → get response → verify LangSmith trace shows tools called via HTTP to MCP containers.
3) Test session memory: ask about UA123, then in a new session ask 'is my flight still on time?' and verify it remembers UA123.
4) Test partial degradation via Docker: stop weather-mcp container → verify agent still answers flight queries. Stop flight-mcp → verify agent still answers weather queries. Restart both → verify recovery.
5) Run the full evaluation suite (npm run eval) and verify all thresholds pass — fix any failures.
6) Run eval with --langsmith flag and verify the experiment appears in the LangSmith dashboard.
7) Write a comprehensive README.md with: project overview, architecture diagram (mermaid showing all 4 containers and their connections), setup instructions (Docker and local dev), environment variables per service, Docker commands reference, API usage examples with curl, testing instructions, evaluation guide (how to run evals, add test cases, interpret results), monitoring/observability guide, deployment guide (how to deploy containers individually, how to scale)."
```


---

## 7. Testing Strategy

### Unit Tests
| Component | What to test |
|---|---|
| Circuit breaker | Opens after threshold, half-open after reset, closes on success |
| Retry with jitter | Correct backoff times, jitter range, max retry cap, retryable vs non-retryable errors |
| Rate limiter | Allows under limit, blocks over limit, returns correct Retry-After, per-user isolation |
| Semantic cache | Cache hit at similarity ≥ 0.92, miss below, TTL expiry, timeout bypass |
| Zod schemas | Valid inputs pass, invalid inputs rejected with useful messages |
| Auth middleware | Valid JWT passes, expired JWT rejected, malformed token rejected, missing header rejected |

### Integration Tests
| Flow | What to test |
|---|---|
| Weather MCP server | Start server on random port → send MCP tool call via HTTP → get weather response (mock external API) |
| Flight MCP server | Start server on random port → send MCP tool call via HTTP → get flight response (mock provider) |
| MCP health endpoints | GET /health on each MCP server returns 200 with service name and uptime |
| Agent → MCP integration | Agent connects to both MCP servers via HTTP URLs, resolves a combined query |
| Agent graph | Multi-tool query resolved correctly, session memory persisted/loaded |
| HTTP API | Full request lifecycle through Express → auth → rate limit → agent → MCP servers → response |

### Chaos / Failure Tests

Uses the lightweight chaos framework (`src/chaos/`) to inject faults at the transport level. The framework is dev/test-only — guarded by `CHAOS_ENABLED=true` + `NODE_ENV !== production` + excluded from prod build via `tsconfig.prod.json`. See `.claude/skills/chaos-testing.md` for full architecture.

**Injection modes:**
- **Probabilistic:** `chaos.inject('weather-api', { type: 'error', statusCode: 503, probability: 0.2 })` — 20% of calls fail
- **Scheduled:** `chaos.inject('redis', { type: 'connection-refused' }, 30_000)` — Redis down for 30s
- **Manual:** `chaos.inject(...)` / `chaos.clear(faultId)` in test code or via CLI

**Fault types:** latency, error (with status code), timeout/hang, malformed response, connection-refused, connection-drop, rate-limit (429), schema-mismatch (valid JSON, wrong shape)

| Scenario | Method | Expected behavior |
|---|---|---|
| Weather API 503 → circuit opens | `chaos.inject('weather-api', { type: 'error', statusCode: 503 })` | Circuit opens after threshold, user gets degradation msg, flight queries still work |
| Weather API recovers → circuit closes | Time-bounded fault (35s), wait for circuit cooldown (30s) | Circuit: CLOSED → OPEN → HALF_OPEN → CLOSED. Automatic recovery. |
| Flight API hangs → timeout + retry exhaust | `chaos.inject('flight-api', { type: 'timeout', hangMs: 10_000 })` | Each attempt times out at 5s, retries exhaust, partial response with weather |
| Redis connection drop | `chaos.inject('redis', { type: 'connection-refused' })` | Cache bypassed, session unavailable, rate limiter falls back to in-memory, agent continues |
| Redis latency spike → cache bypass | `chaos.inject('redis-cache', { type: 'latency', delayMs: 2000 })` | Cache timeout at 500ms, bypassed, total latency unaffected |
| Expired OAuth token | `chaos.inject('oauth-token', { type: 'error', statusCode: 401 })` | 401 immediately, no agent execution, no token logged |
| Both MCP servers unreachable | Two `connection-refused` faults on weather-mcp + flight-mcp | Clear "services unavailable" message, bounded response time |
| Weather MCP malformed response | `chaos.inject('weather-mcp', { type: 'malformed' })` | Zod catches, partial response with flight data |
| Flight API rate limited (429) | `chaos.inject('flight-api', { type: 'rate-limit', retryAfterSeconds: 60 })` | No retry hammering, graceful degradation |
| Cascading: Redis down + weather API 503 | Two faults: redis + weather-api | Flight-only mode without cache, no total failure |
| Container SIGTERM | `docker compose stop <service>` | Graceful shutdown within 10s, in-flight requests complete |

### Evaluation Tests (Pre-Deployment Gate)

Unlike unit/integration/chaos tests which validate _code correctness_, evals validate _agent behavior quality_ — did the LLM pick the right tools, give good answers, and stay within latency budgets?

| Evaluator | What it checks | Pass threshold | Run frequency |
|---|---|---|---|
| **Tool selection** | Correct tool(s) called with valid params for 30+ queries | ≥90% accuracy | Every CI run |
| **Response quality** | LLM-as-judge scores: accuracy, completeness, tone (1–5 each) | Avg ≥3.5, none below 3 | Every CI run |
| **Latency budget** | Cache hit ≤3s, single tool ≤8s, combined ≤12s, max ≤15s | 0 violations at p95 | Every CI run |
| **Resilience** | Graceful messages under degraded modes, no stack traces, partial results when possible | 0 critical failures | Pre-deploy only |
| **E2E flows** | Multi-turn conversations: session memory, cache behavior, combined queries | All assertions pass | Pre-deploy only |
| **Edge cases** | Adversarial inputs: no crashes, no data leaks, user-friendly errors | 0 crashes, 0 leaks | Pre-deploy only |

**Eval dataset design principles:**
- Datasets are JSON files — add test cases without changing code
- Each test case has clear expected behavior, not just "doesn't crash"
- Edge cases explicitly test boundaries: empty inputs, 10K-char inputs, SQL injection in city names, prompt injection attempts
- Tool selection dataset covers the full matrix: weather-only, flight-only, combined, ambiguous, no-tool-needed

**How evals differ from other tests:**

```
Unit tests       → "Does the circuit breaker open after 5 failures?"     (deterministic)
Integration tests → "Does the MCP server return valid JSON?"              (deterministic)
Chaos tests      → "Does the app survive Redis going down?"              (deterministic)
Eval tests       → "Does the LLM pick the right tool for this query?"   (probabilistic — needs thresholds)
```

### Running Tests
```bash
# Unit tests (fast, no Docker needed)
npm run test:unit

# Integration tests (needs Redis)
docker compose up -d redis
npm run test:integration

# Chaos tests (needs full stack)
docker compose up -d
npm run test:chaos

# Evaluation — quick (tool-calling only, ~1 min)
npm run eval:quick

# Evaluation — full suite (~5 min, needs Redis + full stack)
docker compose up -d
npm run eval

# Evaluation — resilience only (injects failures)
npm run eval:resilience

# Evaluation — push results to LangSmith experiments
npm run eval -- --langsmith

# All tests (unit + integration + chaos, excludes eval)
npm test

# Pre-deploy check (typecheck + lint + all tests + full eval)
npm run predeploy
```

---

## 8. Open Questions & Risks

| # | Item | Risk Level | Notes |
|---|---|---|---|
| 1 | **`gpt-5-nano` availability** | 🔴 High | This model may not exist yet or may not be publicly available. **Recommendation:** Build with `gpt-4o-mini` (cheapest tool-calling model), make model name configurable via env var. Swap when `gpt-5-nano` becomes available. |
| 2 | **Session memory TTL** | 🟡 Medium | Spec says "remember user for some time" — how long? **Recommendation:** Default to 24 hours, make configurable. Store flight numbers as extracted entities for cross-session recall. |
| 3 | **Semantic cache similarity threshold** | 🟡 Medium | 0.92 is a starting point. Too low = wrong cached answers. Too high = cache misses. **Recommendation:** Start at 0.92, log all near-miss scores (0.85–0.92), tune based on real queries. |
| 4 | **Weather data staleness** | 🟡 Medium | 30-min cache TTL for weather may be too long for rapidly changing conditions. **Recommendation:** 15-min TTL for weather, 5-min for flights. Make configurable. |
| 5 | **Flight API free tier limits** | 🟡 Medium | FlightAware AeroAPI free tier: 500 calls/month (personal use only). Sufficient for smoke tests but not daily dev. **Recommendation:** Already mitigated via mock-first strategy — `FLIGHT_PROVIDER=mock` by default, switch to `flightaware` for manual smoke tests only. If 500/month is still tight, AeroDataBox offers 300–600 free calls/month at $5/month for 3,000 calls as a cheaper paid fallback. The `FlightProvider` interface makes swapping trivial. |
| 6 | **OAuth 2.1 scope** | 🟢 Low | Full OAuth 2.1 compliance (PKCE, DPoP, etc.) is complex. For a side project, JWT issuance + verification is sufficient. **Recommendation:** Implement client_credentials grant with JWT. Document which OAuth 2.1 requirements are implemented vs. deferred. |
| 7 | **Redis vector search** | 🟢 Low | `redis-stack` supports vector similarity search natively (RediSearch). Alternative: store embeddings as JSON and compute cosine similarity in Node.js. **Recommendation:** Start with Node.js cosine similarity (simpler); upgrade to RediSearch if query volume grows. |
| 8 | **MCP transport choice** | 🟢 Resolved | Using **Streamable HTTP transport**. Each MCP server runs as an independent HTTP service in its own Docker container, enabling independent scaling, health checks, and network isolation. The agent connects via configurable URLs (`WEATHER_MCP_URL`, `FLIGHT_MCP_URL`), making it trivial to point at remote servers, add load balancers, or swap implementations. |
| 9 | **LangSmith cost** | 🟢 Low | LangSmith free tier has trace limits. **Recommendation:** Use sampling (trace 10% in production) and always trace errors. |
| 10 | **Prompt injection** | 🟡 Medium | Users could try to manipulate the agent via input. **Recommendation:** Add basic input sanitization, constrain the system prompt, and log suspicious inputs. Full prompt injection defense is out of scope for v1 but should be acknowledged. |
| 11 | **Chaos framework in CI** | 🟢 Low | Chaos tests are slower than unit tests (some scenarios wait for circuit breaker cooldowns of 30s+). **Recommendation:** Run `test:chaos` as a separate CI step with a generous timeout (5 min). Don't block fast feedback loops — run chaos tests in parallel with eval tests. Recovery scenarios can be skipped in PR checks and only run in the pre-deploy gate. |

---

## 9. Quick Reference — Key Commands

```bash
# Start full stack (all containers)
docker compose up -d                # Redis + weather-mcp + flight-mcp + agent
docker compose ps                   # Verify all 4 services healthy
curl http://localhost:3000/health    # Agent health
curl http://localhost:3001/health    # Weather MCP health
curl http://localhost:3002/health    # Flight MCP health

# Start development (with hot reload)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
npm run test:watch          # Keep running in a terminal — TDD red/green/refactor

# Run individual services locally (without Docker)
WEATHER_MCP_URL=http://localhost:3001/mcp FLIGHT_MCP_URL=http://localhost:3002/mcp 
npm run dev:agent
npm run dev:weather-mcp
npm run dev:flight-mcp

# Run specific Claude Code session
# (copy the relevant prompt from Section 6)
# (ALWAYS prepend the TDD instruction from the workflow preamble)

# Code quality checks
npx tsc --noEmit            # Typecheck — must be zero errors
npm run lint                # ESLint — must be zero warnings
npm run lint -- --fix       # Auto-fix what's possible

# Test
npm run test:unit
npm run test:integration    # Starts MCP servers on random ports internally
npm run test:chaos

# Test partial degradation (manual)
docker compose stop weather-mcp     # Agent should still serve flight queries
docker compose start weather-mcp    # Recovery
docker compose stop flight-mcp      # Agent should still serve weather queries
docker compose start flight-mcp     # Recovery

# Chaos testing (automated — needs full Docker stack)
docker compose up -d
CHAOS_ENABLED=true npm run test:chaos

# Chaos testing (manual exploration)
CHAOS_ENABLED=true npx ts-node src/chaos/cli.ts inject weather-api error --status 503 --duration 60
CHAOS_ENABLED=true npx ts-node src/chaos/cli.ts status
# ... manually test the chatbot ...
CHAOS_ENABLED=true npx ts-node src/chaos/cli.ts clear-all

# Evaluate (pre-deploy)
npm run eval              # Full evaluation suite
npm run eval:quick        # Tool-calling only (fast iteration)
npm run eval -- --langsmith  # Push results to LangSmith experiments

# Pre-deploy gate (runs everything)
npm run predeploy         # typecheck + lint + all tests + full eval

# Build production images
docker compose build

# Generate a test OAuth token
npx ts-node scripts/generate-token.ts

# Check LangSmith dashboard
open https://smith.langchain.com
```

---

## 10. Definition of Done

### Code Quality
- [ ] **`npx tsc --noEmit` — zero errors**
- [ ] **`npm run lint` — zero warnings**
- [ ] **No `any` types anywhere in `src/`**
- [ ] **No `console.log` — all logging via pino logger**
- [ ] **No hardcoded secrets — verified by grep scan**
- [ ] **No unresolved `TODO` or `FIXME` without a linked issue/open question**
- [ ] **All files under ~200 lines**
- [ ] **Test coverage ≥80% branches**

### Resource Management
- [ ] **All resources registered in shutdown handler (Redis, MCP servers/clients, Express, timers)**
- [ ] **Clean shutdown verified: start app → send requests → SIGTERM → exit code 0 with no warnings**
- [ ] **Load test (100 requests) shows no memory growth or connection pool exhaustion**
- [ ] **All HTTP clients use AbortController for cancellation**

### Tests
- [ ] All unit tests pass (written before implementation via TDD)
- [ ] All integration tests pass
- [ ] All chaos/failure tests pass (10 failure scenarios + recovery scenarios)
- [ ] No unhandled promise rejections in any test scenario

### Chaos Framework
- [ ] **Production safety verified:** `tsconfig.prod.json` excludes `src/chaos/**`, production Docker image has no chaos code, `CHAOS_ENABLED` not set in any prod env
- [ ] **All 10 scenarios automated:** weather-api-503, recovery, flight-timeout, redis-drop, redis-latency, oauth-expired, both-mcp-down, malformed, rate-limit, cascading
- [ ] **Recovery tests pass:** systems auto-heal after faults clear
- [ ] **LangSmith shows correct metrics** during chaos runs: circuit events, error counts, latency impact

### Evaluation
- [ ] **Eval: tool selection accuracy ≥90%**
- [ ] **Eval: response quality avg ≥3.5 (no score below 3)**
- [ ] **Eval: latency within budget at p95**
- [ ] **Eval: 0 critical failures in resilience evaluator**
- [ ] **Eval: all e2e flow assertions pass**
- [ ] **Eval: 0 crashes or data leaks on edge case inputs**
- [ ] **Eval results pushed to LangSmith as experiment baseline**

### Functionality
- [ ] Combined weather+flight query works end-to-end
- [ ] Session memory persists across requests (same user can reference previous flights)
- [ ] Semantic cache hits on similar queries, misses on different ones
- [ ] Rate limiting works per-user
- [ ] OAuth token validation works (valid, expired, missing)
- [ ] All failures degrade gracefully with user-friendly messages
- [ ] Every request traced in LangSmith with cost, latency, and error metadata

### Security
- [ ] **No stack traces or internal details in any user-facing error response**
- [ ] **JWT tokens never logged — only metadata (user_id, expiry, valid/invalid)**
- [ ] **All user inputs validated/sanitized before use**
- [ ] **`helmet` configured with strict CSP**
- [ ] **Request body size limited (10kb)**
- [ ] **`eslint-plugin-security` passes with zero warnings**

### Deliverables
- [ ] README documents setup, usage, architecture, and **evaluation guide**
- [ ] `docker compose up` brings the entire stack up successfully
- [ ] **`npm run predeploy` passes (all tests + full eval + lint + typecheck)**
