Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Create a new Node.js/TypeScript project with the following structure from section "1. Project Structure" from implementation-plan.md.

Set up package.json with dependencies from list from section "3. Technology Choices"  from implementation-plan.md.

Configure tsconfig with strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true for maximum type safety. Configure ESLint flat config with @typescript-eslint/strict preset and eslint-plugin-security — zero warnings policy. Set up vitest with coverage thresholds (80% branches minimum).

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