# MCP Weather & Flight Chatbot

## What This Project Is

A production-ready chatbot that answers weather temperature and flight status questions (including combined queries in a single request) using MCP servers, LangGraphJS agent orchestration, and comprehensive reliability patterns.

Full implementation plan: `implementation-plan.md` in project root.

## Architecture

4 Docker containers, each with its own entrypoint, health check, and graceful shutdown:

```
┌─────────────────────────────────────────────────────┐
│  docker-compose                                     │
│                                                     │
│  ┌──────────┐   ┌──────────────┐  ┌──────────────┐  │
│  │  Redis   │   │ weather-mcp  │  │ flight-mcp   │  │
│  │  :6379   │   │ :3001/mcp    │  │ :3002/mcp    │  │
│  └──────────┘   └──────────────┘  └──────────────┘  │
│       ▲               ▲                  ▲          │
│       │         ┌─────┴──────────────────┘          │
│  ┌────┴─────────┴──┐                                │
│  │     agent       │  Express + LangGraphJS         │
│  │   :3000/chat    │  Connects to MCP servers       │
│  │   :3000/health  │  via Streamable HTTP           │
│  └─────────────────┘                                │
└─────────────────────────────────────────────────────┘
```

- **agent** (:3000) — Express API with OAuth 2.1 JWT auth, rate limiting, LangGraphJS orchestration, semantic cache, session memory. Entrypoint: `src/entrypoints/agent.ts`
- **weather-mcp** (:3001) — MCP server (Streamable HTTP) with one tool `get_weather`. Calls WeatherAPI.com. Entrypoint: `src/entrypoints/weather-mcp.ts`
- **flight-mcp** (:3002) — MCP server (Streamable HTTP) with one tool `get_flight_status`. Uses FlightProvider interface (mock or FlightAware). Entrypoint: `src/entrypoints/flight-mcp.ts`
- **Redis** (:6379) — Semantic cache, session memory, rate limiting

## Tech Stack

- Node.js 20+ / TypeScript 5.x (strict: true, no `any`)
- MCP SDK (`@modelcontextprotocol/sdk`) with Streamable HTTP transport
- LangGraphJS (`@langchain/langgraph`) for agent orchestration
- gpt-4o-mini via `@langchain/openai` for LLM (model name is configurable via env)
- Express + helmet + cors for HTTP
- ioredis for Redis
- opossum for circuit breaker, custom retry with jitter
- jose for JWT (OAuth 2.1 client_credentials grant)
- pino for structured logging
- LangSmith for observability and cost tracking
- vitest for testing
- zod for all validation (env, MCP schemas, API responses)

## Non-Negotiable Development Rules

### TDD — Always

Write the failing test FIRST, then implement. No exceptions. Red → Green → Refactor.

For non-deterministic outputs (LLM responses, similarity scores), use bounded assertions ("response contains flight number") not exact string matches.

### TypeScript Strictness

- `strict: true` in tsconfig. `noUncheckedIndexedAccess: true`. `exactOptionalPropertyTypes: true`.
- Zero `any` types. Use `unknown` + type guards when needed.
- All functions have explicit return types.
- `interface` for object shapes, `type` for unions/intersections.

### Maintainability Over Cleverness

- No clever one-liners that need comments to explain. If it needs a comment, rewrite it.
- Descriptive names: `flightStatusResponse` not `res2`. No abbreviations.
- Functions do one thing. If description has "and", split it.
- Files under ~200 lines. Extract a module if larger.
- Consistent patterns everywhere (see Skills below).

### Error Handling

- Every `async` function has try/catch or .catch(). No bare awaits.
- Use typed custom errors from `src/utils/errors.ts` (TimeoutError, CircuitOpenError, RateLimitError, etc.), not generic `throw new Error(string)`.
- Never swallow errors. At minimum: log + increment metric + user-friendly message.
- No stack traces or internal details in user-facing error responses.
- `process.on('unhandledRejection', ...)` as safety net but always fix the root cause.

### Resource Management

- Every opened resource registers cleanup in `src/utils/graceful-shutdown.ts`.
- Use `AbortController` for cancellable HTTP fetches and LLM calls.
- Event listeners registered with `.on()` must have `.off()` on shutdown.
- No closures capturing large objects in long-lived scopes.
- Shutdown must complete within 10s (Docker default stop timeout).

### Security

- No secrets in code or logs. API keys, tokens, user data — never logged.
- All user input validated with zod before use.
- No `eval()`, no dynamic `require()`, no template literal injection.
- JWT tokens validated on every request. Never log token values — only metadata.
- `helmet` with strict CSP. CORS to specific origins, not `*` in production.
- Request body size limited to 10kb.

## Key Patterns

### Resilience Wrapping (always this order)

```
circuit breaker → retry with jitter → timeout → actual API call
```

See `.claude/skills/resilience-wrapper.md` for the full pattern.

### Chaos / Fault Injection Pattern

Dev/test-only fault injection that sits inside the resilience stack. Faults are injected at the transport level (fetch, Redis commands) so circuit breakers, retries, and timeouts exercise naturally. See `.claude/skills/chaos-testing.md`.

**Safety:** Chaos code never runs in production — guarded by `CHAOS_ENABLED` env var + `NODE_ENV` check + excluded from production build via `tsconfig.prod.json`.

### MCP Server Pattern

Every MCP server follows the same structure. See `.claude/skills/mcp-server.md`.

### Error Response Pattern

Every error path: catch → log with context → increment metric → return user-friendly message.

User-facing error messages are always friendly and actionable:
- "Weather data is temporarily unavailable. Try again in a few minutes."
- "Flight status is temporarily unavailable."
- "I couldn't understand that request. Could you rephrase?"
- Never: stack traces, internal error codes, raw exception messages.

### Graceful Degradation

If one MCP server is down, the agent still returns results from the other. If Redis is down, the agent continues without cache/session (degraded mode). If the LLM fails, retry once then return an error message.

## File Organization

```
src/entrypoints/       — One file per Docker container entrypoint
src/config/            — Env validation (zod), Redis client
src/auth/              — OAuth 2.1 JWT issuance + middleware
src/agent/             — LangGraphJS graph, nodes, state, prompt
src/mcp/               — MCP servers (weather, flight), MCP client, zod schemas
src/resilience/        — Circuit breaker, retry, rate limiter, timeout
src/chaos/             — Fault injection framework (dev/test only, excluded from prod build)
src/cache/             — Semantic cache, session store
src/observability/     — LangSmith tracing, metrics, pino logger
src/utils/             — Custom errors, health endpoint, graceful shutdown
tests/unit/            — Fast, no Docker needed
tests/integration/     — Needs Redis, starts MCP servers on random ports
tests/chaos/           — Failure injection scenarios
tests/eval/            — Pre-deployment evaluation suite (datasets + evaluators)
fixtures/flights/      — Mock flight API responses (on-time, delayed, cancelled, in-air)
```

## Commands

```bash
# Full stack
docker compose up -d
docker compose ps

# Dev with hot reload
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# TDD workflow
npm run test:watch

# Quality checks
npx tsc --noEmit          # zero errors
npm run lint              # zero warnings

# Tests
npm run test:unit
npm run test:integration
npm run test:chaos

# Chaos testing (fault injection)
CHAOS_ENABLED=true npm run test:chaos          # Automated chaos scenarios
CHAOS_ENABLED=true npx ts-node src/chaos/cli.ts status   # View active faults (manual mode)

# Evaluation
npm run eval:quick        # tool-calling only (~1 min)
npm run eval              # full suite (~5 min)

# Pre-deploy gate (must pass before merge)
npm run predeploy         # typecheck + lint + all tests + full eval
```

## Anti-Patterns — Do NOT Do These

- ❌ `any` type anywhere
- ❌ `console.log` — use pino logger
- ❌ Bare `await` without error handling
- ❌ Hardcoded secrets, URLs, or magic numbers
- ❌ Opening a resource without registering shutdown cleanup
- ❌ Swallowing errors silently (empty catch blocks)
- ❌ Stack traces in user-facing responses
- ❌ `setInterval` / `setTimeout` without clearing on shutdown
- ❌ Files over 200 lines
- ❌ Dependencies with `^` or `~` — pin exact versions
- ❌ Importing from `src/chaos/` in production code without `CHAOS_ENABLED` guard
- ❌ Inline lambdas for complex logic — extract named functions
- ❌ Testing after implementation — write tests FIRST

## Environment Variables

Per-service — each service only reads what it needs:

| Variable | Services | Default | Notes |
|---|---|---|---|
| SERVICE_ROLE | all | required | `agent`, `weather-mcp`, or `flight-mcp` |
| PORT | all | 3000/3001/3002 | Per service |
| REDIS_URL | all | `redis://localhost:6379` | |
| OPENAI_API_KEY | agent | required | For LLM + embeddings |
| LANGSMITH_API_KEY | agent | required | Observability |
| OAUTH_SECRET | agent | required | JWT signing |
| WEATHER_MCP_URL | agent | `http://localhost:3001/mcp` | Docker: `http://weather-mcp:3001/mcp` |
| FLIGHT_MCP_URL | agent | `http://localhost:3002/mcp` | Docker: `http://flight-mcp:3002/mcp` |
| WEATHERAPI_KEY | weather-mcp | required | WeatherAPI.com key |
| FLIGHTAWARE_API_KEY | flight-mcp | optional | Only needed when FLIGHT_PROVIDER=flightaware |
| FLIGHT_PROVIDER | flight-mcp | `mock` | `mock` or `flightaware` |
| CHAOS_ENABLED | all (test only) | not set | Set to `true` to enable fault injection. Never set in production. |
