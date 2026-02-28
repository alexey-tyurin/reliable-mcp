# Skill: Docker Service

Use this pattern when adding a new service to the Docker Compose stack or modifying existing container configuration.

## Architecture

All services share a single multi-stage Dockerfile. Each service has a different `command` in docker-compose.yml that points to its entrypoint.

```
Dockerfile (shared)
├── Build stage: compile TypeScript
└── Runtime stage: node:20-alpine, non-root user, HEALTHCHECK
```

Docker Compose services:
- `redis` — Data store (redis-stack image)
- `weather-mcp` — MCP server on :3001
- `flight-mcp` — MCP server on :3002
- `agent` — Express API on :3000

## Dockerfile (Multi-Stage)

```dockerfile
# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM node:20-alpine
RUN apk add --no-cache curl  # For health checks
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY fixtures/ ./fixtures/
USER app
EXPOSE 3000
# Default CMD overridden per-service in docker-compose.yml
CMD ["node", "dist/entrypoints/agent.js"]
```

Key points:
- Non-root user (`app`) for security
- `curl` installed for health check commands
- `fixtures/` copied for mock flight provider
- No `COPY .env` — env vars injected via docker-compose

## Docker Compose Service Template

```yaml
services:
  new-service:
    build:
      context: .
      dockerfile: Dockerfile
    command: node dist/entrypoints/new-service.js
    ports:
      - "${NEW_SERVICE_PORT:-3003}:${NEW_SERVICE_PORT:-3003}"
    env_file: .env
    environment:
      - SERVICE_ROLE=new-service
      - PORT=${NEW_SERVICE_PORT:-3003}
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${NEW_SERVICE_PORT:-3003}/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 15s
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M
```

## Dev Override (`docker-compose.dev.yml`)

```yaml
services:
  new-service:
    command: npx ts-node-dev --respawn src/entrypoints/new-service.ts
    volumes:
      - ./src:/app/src:ro
      - ./fixtures:/app/fixtures:ro
    environment:
      - NODE_ENV=development
      - LOG_LEVEL=debug
```

## Service Entrypoint Pattern

Every service entrypoint follows the same structure:

```typescript
// src/entrypoints/new-service.ts
import { loadEnv } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import { registerShutdown, onShutdown } from '../utils/graceful-shutdown.js';

async function main(): Promise<void> {
  const env = loadEnv('new-service');
  const logger = createLogger('new-service');

  // 1. Initialize dependencies (Redis, etc.)
  // 2. Create the service (Express app, MCP server, etc.)
  // 3. Start listening

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Service ready');
  });

  // 4. Register ALL cleanup
  registerShutdown('http-server', () =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  );
  // ... register other resources

  // 5. Activate shutdown handler
  onShutdown();
}

main().catch((error) => {
  console.error('Fatal startup error:', error);  // OK to use console here — logger may not be initialized
  process.exit(1);
});
```

## Networking

Services communicate by container hostname inside Docker Compose:

| From | To | URL |
|------|-----|------|
| agent | weather-mcp | `http://weather-mcp:3001/mcp` |
| agent | flight-mcp | `http://flight-mcp:3002/mcp` |
| any service | redis | `redis://redis:6379` |

These are configured via env vars. Locally (without Docker), they default to `localhost`:

```
WEATHER_MCP_URL=http://localhost:3001/mcp    # local default
FLIGHT_MCP_URL=http://localhost:3002/mcp     # local default
REDIS_URL=redis://localhost:6379             # local default
```

In `docker-compose.yml`:
```yaml
agent:
  environment:
    - WEATHER_MCP_URL=http://weather-mcp:3001/mcp
    - FLIGHT_MCP_URL=http://flight-mcp:3002/mcp
    - REDIS_URL=redis://redis:6379
```

## Health Checks

Every service exposes `GET /health` returning:

```json
{
  "status": "ok",
  "service": "weather-mcp",
  "uptime": 123.45
}
```

Docker uses this for:
- `depends_on.condition: service_healthy` — ordering startup
- Container restart decisions (`restart: unless-stopped`)
- Load balancer readiness (if scaling later)

## Graceful Shutdown

Critical for Docker — containers receive `SIGTERM` on `docker compose stop/down`:

1. Stop accepting new connections
2. Drain in-flight requests (wait for completion)
3. Close resources in reverse order (HTTP server → MCP → Redis → logger)
4. Exit with code 0

Must complete within Docker's stop timeout (default 10s). If not, Docker sends `SIGKILL`.

```typescript
// In graceful-shutdown.ts
const SHUTDOWN_TIMEOUT = 9000;  // Leave 1s buffer before Docker's 10s SIGKILL

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  const timer = setTimeout(() => {
    logger.error('Shutdown timeout, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  await runCleanup();  // Calls all registered cleanup functions
  clearTimeout(timer);
  logger.info('Clean shutdown complete');
  process.exit(0);
});
```

## Checklist for Adding a New Docker Service

- [ ] Entrypoint created in `src/entrypoints/`
- [ ] `GET /health` endpoint using shared health handler
- [ ] All resources registered in shutdown registry
- [ ] `docker-compose.yml` service entry with health check, restart policy, memory limit
- [ ] `docker-compose.dev.yml` override with hot reload and volume mounts
- [ ] `.env.example` updated with new env vars
- [ ] `src/config/env.ts` updated with new SERVICE_ROLE option and per-service validation
- [ ] `docker compose build && docker compose up` — new service starts and passes health check
- [ ] `docker compose stop <service>` — clean shutdown within 10s
- [ ] Agent handles new service being unreachable (partial degradation)
- [ ] README updated with new service documentation
