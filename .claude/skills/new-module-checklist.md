# Skill: New Module Checklist

Use this checklist whenever adding a new module, feature, or file to the project. Every item must be verified before considering the work done.

## Before Writing Code

- [ ] **Test file created first.** Write the test that defines expected behavior before writing the implementation. File goes in the matching `tests/` subdirectory.
- [ ] **Interface/types defined.** Define TypeScript interfaces and types for inputs, outputs, and dependencies before implementation. Use `interface` for object shapes, `type` for unions/utilities. All function signatures have explicit return types.
- [ ] **Error cases identified.** List what can go wrong: invalid input, network failure, timeout, missing data, auth failure. Each error case gets a test.

## During Implementation

- [ ] **No `any` types.** Use `unknown` + type guards. Zero exceptions.
- [ ] **No `console.log`.** Use the pino logger from `src/observability/logger.js`.
- [ ] **No hardcoded values.** Secrets in env vars (via `src/config/env.ts`), constants extracted to named `const` at module top.
- [ ] **Descriptive names.** `flightStatusResponse` not `res2`. No abbreviations. If the function needs "and" in its description, split it into two functions.
- [ ] **Error handling on every async path.** Every `await` inside try/catch or with `.catch()`. Use typed errors from `src/utils/errors.ts`.
- [ ] **Zod validation on all external input.** User input, API responses, MCP tool params, env vars — validated with zod before use.

## Resource Management

- [ ] **Opened resource = registered cleanup.** If the module opens a connection, starts a server, creates a timer, or registers an event listener — it MUST register a cleanup function in `src/utils/graceful-shutdown.ts`.
- [ ] **AbortController for HTTP fetches.** Cancellable on shutdown.
- [ ] **Event listeners paired.** Every `.on()` has a `.off()` or `.removeListener()` on shutdown.
- [ ] **No leaking closures.** Don't capture request-scoped data (bodies, large objects) in long-lived scopes (circuit breaker callbacks, cached functions).

## After Implementation

- [ ] **All tests pass.** `npm run test:unit` (or `test:integration` if applicable).
- [ ] **TypeScript compiles.** `npx tsc --noEmit` — zero errors.
- [ ] **Lint passes.** `npm run lint` — zero warnings.
- [ ] **File under 200 lines.** If over, extract into a separate module.
- [ ] **No TODO/FIXME without a documented open question.** Either resolve it or add to open questions in `implementation-plan.md`.
- [ ] **Grep check.** Search for `any`, `console.log`, hardcoded URLs/keys in the new files.

## Docker Awareness

If the module is part of a service entrypoint or changes service behavior:

- [ ] **Works in Docker.** Service URLs use env vars (not hardcoded `localhost`). In Docker, services resolve via container hostnames (`weather-mcp`, `flight-mcp`, `redis`).
- [ ] **Health check still passes.** `GET /health` returns 200 after the change.
- [ ] **Graceful shutdown still works.** `docker compose stop <service>` completes within 10s, no "connection still open" warnings.
- [ ] **Docker Compose updated.** If adding a new service, new env var, or new port — update `docker-compose.yml`, `docker-compose.dev.yml`, and `.env.example`.

## Integration Points

If the module connects to other services or stores data:

- [ ] **Resilience wrapper applied.** External calls wrapped with circuit breaker → retry → timeout (see `resilience-wrapper.md` skill).
- [ ] **Metrics emitted.** Key operations tracked: success/failure counters, latency, error types. Tagged for LangSmith filtering.
- [ ] **Degradation tested.** What happens when this module's dependency is down? Agent should still return partial results or a friendly error. Test this.
