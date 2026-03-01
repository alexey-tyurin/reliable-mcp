# MCP Weather & Flight Chatbot

A production-ready chatbot that answers weather and flight status questions using **MCP servers**, **LangGraphJS agent orchestration**, and comprehensive reliability patterns. Supports combined queries ("weather in NYC and flight UA123 status?") in a single request.

## Architecture

```mermaid
graph TB
    Client([Client])

    subgraph Docker["docker-compose"]
        subgraph Agent["agent :3000"]
            Express["Express API"]
            OAuth["OAuth 2.1 JWT"]
            RateLimit["Rate Limiter"]
            LangGraph["LangGraphJS Agent"]
            SemanticCache["Semantic Cache"]
            SessionStore["Session Memory"]
        end

        subgraph WeatherMCP["weather-mcp :3001"]
            WeatherServer["MCP Server"]
            WeatherTool["get_weather"]
            WeatherAPI["WeatherAPI.com"]
        end

        subgraph FlightMCP["flight-mcp :3002"]
            FlightServer["MCP Server"]
            FlightTool["get_flight_status"]
            FlightProvider["Mock / FlightAware"]
        end

        Redis[("Redis :6379")]
    end

    LangSmith["LangSmith"]

    Client -->|"POST /chat"| Express
    Express --> OAuth
    OAuth --> RateLimit
    RateLimit --> LangGraph
    LangGraph -->|"Streamable HTTP"| WeatherServer
    LangGraph -->|"Streamable HTTP"| FlightServer
    LangGraph --> SemanticCache
    LangGraph --> SessionStore
    WeatherServer --> WeatherTool
    WeatherTool --> WeatherAPI
    FlightServer --> FlightTool
    FlightTool --> FlightProvider
    SemanticCache --> Redis
    SessionStore --> Redis
    RateLimit --> Redis
    LangGraph -.->|"traces"| LangSmith
```

**4 containers**, each with its own entrypoint, health check, and graceful shutdown:

| Container | Port | Purpose |
|-----------|------|---------|
| **agent** | 3000 | Express API with OAuth 2.1, rate limiting, LangGraphJS orchestration, semantic cache, session memory |
| **weather-mcp** | 3001 | MCP server (Streamable HTTP) — `get_weather` tool calling WeatherAPI.com |
| **flight-mcp** | 3002 | MCP server (Streamable HTTP) — `get_flight_status` tool (mock or FlightAware) |
| **Redis** | 6379 | Semantic cache, session memory, rate limiting |

## Key Features

- **Combined queries**: Ask about weather and flights in a single message
- **Session memory**: Conversation context persists across requests via Redis
- **Graceful degradation**: If one MCP server goes down, the other still works. If Redis is down, the agent continues in stateless mode
- **Auto-reconnection**: MCP client automatically reconnects when servers restart
- **Resilience stack**: Circuit breaker → retry with jitter → timeout on all external calls
- **Semantic caching**: Similar questions hit cache using cosine similarity on embeddings
- **Chaos testing**: Fault injection framework for testing failure scenarios (dev/test only)
- **Evaluation suite**: Pre-deployment quality gate with tool-calling accuracy, latency budgets, resilience checks, and LangSmith integration
- **Observability**: Structured logging (pino), LangSmith tracing, metrics tracking

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- API keys (see [Environment Variables](#environment-variables))

### Setup

```bash
# Clone and install
git clone https://github.com/alexey-tyurin/reliable-mcp.git
cd reliable-mcp
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys (see Environment Variables below)
```

### Docker (recommended)

```bash
# Build and start all services
docker compose build
docker compose up -d

# Verify all 4 containers are healthy
docker compose ps

# Check health endpoints
curl http://localhost:3000/health  # agent
curl http://localhost:3001/health  # weather-mcp
curl http://localhost:3002/health  # flight-mcp
```

### Local Development

```bash
# Start Redis (required for cache/sessions)
docker compose up -d redis

# Start each service in separate terminals
npm run dev:weather-mcp
npm run dev:flight-mcp
npm run dev:agent
```

## Environment Variables

Copy `.env.example` to `.env` and fill in your keys:

### All Services

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVICE_ROLE` | *required* | `agent`, `weather-mcp`, or `flight-mcp` |
| `PORT` | `3000` | HTTP port (3000/3001/3002 per service) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |

### Agent Service

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | *required* | OpenAI API key (for gpt-4o-mini) |
| `LANGSMITH_API_KEY` | *required* | LangSmith API key for observability |
| `OAUTH_SECRET` | *required* | JWT signing secret (min 32 chars) |
| `WEATHER_MCP_URL` | `http://localhost:3001/mcp` | Weather MCP server URL |
| `FLIGHT_MCP_URL` | `http://localhost:3002/mcp` | Flight MCP server URL |
| `LANGCHAIN_TRACING_V2` | | Set to `true` to enable auto-tracing |
| `LANGCHAIN_API_KEY` | | Same as `LANGSMITH_API_KEY` |
| `LANGCHAIN_PROJECT` | | LangSmith project name |

### Weather MCP Service

| Variable | Default | Description |
|----------|---------|-------------|
| `WEATHERAPI_KEY` | *required* | [WeatherAPI.com](https://www.weatherapi.com/) API key |

### Flight MCP Service

| Variable | Default | Description |
|----------|---------|-------------|
| `FLIGHT_PROVIDER` | `mock` | `mock` (test data) or `flightaware` (live API) |
| `FLIGHTAWARE_API_KEY` | | Only required when `FLIGHT_PROVIDER=flightaware` |

### Test Only

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAOS_ENABLED` | | Set to `true` to enable fault injection. **Never set in production.** |

## API Usage

### 1. Authenticate

```bash
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "default-client",
    "client_secret": "<your-OAUTH_SECRET>"
  }'
```

Response:
```json
{
  "access_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### 2. Send a Chat Message

```bash
# Weather query
curl -X POST http://localhost:3000/chat \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the weather in London?", "sessionId": "my-session"}'

# Flight query (mock flights: TEST001-TEST004, UA123, BA456, DL789)
curl -X POST http://localhost:3000/chat \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the status of flight UA123?", "sessionId": "my-session"}'

# Combined query
curl -X POST http://localhost:3000/chat \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"message": "Weather in NYC and status of flight UA123?", "sessionId": "my-session"}'
```

Response:
```json
{
  "response": "The weather in London is currently 12°C with partly cloudy conditions..."
}
```

### 3. Health Check

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"agent","uptime":42.5}
```

## Docker Commands Reference

```bash
# Full lifecycle
docker compose build              # Build all images
docker compose up -d              # Start all services
docker compose ps                 # Check status & health
docker compose logs -f agent      # Follow agent logs
docker compose logs -f --tail=50  # Follow all logs

# Individual service management
docker compose stop weather-mcp   # Stop weather service
docker compose start weather-mcp  # Restart weather service
docker compose restart agent      # Restart agent

# Dev mode with hot reload
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Teardown
docker compose down               # Stop all services
docker compose down -v            # Stop and remove volumes
```

## Testing

### TDD Workflow

```bash
npm run test:watch           # Watch mode for TDD (red-green-refactor)
```

### Unit Tests

```bash
npm run test:unit            # Fast tests, no Docker needed
```

### Integration Tests

```bash
# Requires Redis running
docker compose up -d redis
npm run test:integration
```

### Chaos Tests

```bash
# Fault injection testing
CHAOS_ENABLED=true npm run test:chaos
```

### All Tests

```bash
npm run test                 # Run all test suites
```

### Quality Checks

```bash
npx tsc --noEmit             # Type check (zero errors required)
npm run lint                 # Lint check (zero warnings required)
```

## Evaluation Guide

The evaluation suite validates tool-calling accuracy, latency budgets, resilience, and response quality before deployment.

### Running Evaluations

```bash
npm run eval:quick           # Tool-calling only (~1 min)
npm run eval:resilience      # Resilience checks only
npm run eval                 # Full suite (~5 min)
```

### Pass Criteria

- **Tool accuracy** >= 90% (correct tool selection for each query type)
- **Zero critical failures** (no stack traces, no forbidden content leaks)

### Datasets

| Dataset | Cases | Description |
|---------|-------|-------------|
| `tool-calling.json` | 30 | Weather, flight, combined, ambiguous, no-tool queries |
| `edge-cases.json` | 16 | Prompt injection, SQL injection, XSS, gibberish, special chars |
| `e2e-flows.json` | 15 | Multi-turn conversation flows (follow-ups, session memory, cache hits, mixed queries) |

### Evaluators

| Evaluator | What It Checks |
|-----------|---------------|
| **tool-selection** | Correct tools called (1.0 exact, 0.5 partial, 0.0 wrong) |
| **latency-budget** | Response time within budget (200ms none, 1s single, 1.5s combined) |
| **resilience** | No stack traces, proper HTTP status codes, safe error messages |
| **response-quality** | LLM-judged helpfulness, relevance, correctness (1-3 scale) |

### Adding Test Cases

Add entries to `tests/eval/datasets/tool-calling.json`:

```json
{
  "input": "What's the weather like in Berlin?",
  "expected_tools": ["get_weather"],
  "category": "weather-only"
}
```

### LangSmith Integration

Push evaluation results to LangSmith as an experiment:

```bash
npm run eval -- --langsmith
```

This creates a dataset and experiment in your LangSmith project, allowing you to track evaluation results over time and compare across runs.

## Monitoring & Observability

### LangSmith Tracing

All agent invocations are traced to LangSmith when `LANGCHAIN_TRACING_V2=true`:

- Root trace: `LangGraph` run with full message history
- Child traces: `route` (LLM decision), `execute_tools` (MCP calls), `respond` (final generation)
- Tags: `user:<id>`, `session:<id>`, `tool:<name>`, `cache:hit/miss`
- Metadata: latency, tools called, cache hit status, error codes

View traces at [smith.langchain.com](https://smith.langchain.com).

### Structured Logging

All services use pino for JSON structured logging:

```bash
# Follow agent logs
docker compose logs -f agent

# Example log entry
# {"level":"info","time":1772388600,"service":"agent-http","userId":"client","sessionId":"s1","msg":"Processing chat request"}
```

### Metrics

The agent tracks:
- Cache hit/miss rates
- Error counts by type
- Circuit breaker state transitions
- Request latency

### Health Checks

Every service exposes `GET /health`:

```json
{"status": "ok", "service": "agent", "uptime": 42.5}
```

Docker Compose uses these for container orchestration — the agent waits for MCP servers and Redis to be healthy before starting.

## Deployment Guide

### Container-Level Deployment

Each service can be deployed independently. They communicate over HTTP:

```bash
# Build production image
docker build -t mcp-chatbot .

# Run individual services
docker run -e SERVICE_ROLE=weather-mcp -e PORT=3001 -e WEATHERAPI_KEY=... \
  -p 3001:3001 mcp-chatbot node dist/entrypoints/weather-mcp.js

docker run -e SERVICE_ROLE=flight-mcp -e PORT=3002 -e FLIGHT_PROVIDER=mock \
  -p 3002:3002 mcp-chatbot node dist/entrypoints/flight-mcp.js

docker run -e SERVICE_ROLE=agent -e PORT=3000 \
  -e OPENAI_API_KEY=... -e LANGSMITH_API_KEY=... -e OAUTH_SECRET=... \
  -e WEATHER_MCP_URL=http://weather-host:3001/mcp \
  -e FLIGHT_MCP_URL=http://flight-host:3002/mcp \
  -e REDIS_URL=redis://redis-host:6379 \
  -p 3000:3000 mcp-chatbot node dist/entrypoints/agent.js
```

### Scaling

- **MCP servers** are stateless — scale horizontally behind a load balancer
- **Agent** maintains session state in Redis — scales horizontally with shared Redis
- **Redis** can be replaced with Redis Cluster for high availability

### Pre-Deploy Checklist

```bash
# Run the full quality gate (must pass before merge)
npm run predeploy  # typecheck + lint + all tests + full eval
```

### Production Considerations

- Set `NODE_ENV=production`
- Use a real Redis instance (not redis-stack)
- Configure CORS origins appropriately (not `*`)
- Rotate `OAUTH_SECRET` periodically
- Set `FLIGHT_PROVIDER=flightaware` with a valid API key for real flight data
- **Never** set `CHAOS_ENABLED=true` in production

## Tech Stack

| Category | Technology |
|----------|-----------|
| Runtime | Node.js 20, TypeScript 5.x (strict mode) |
| Agent | LangGraphJS, gpt-4o-mini via @langchain/openai |
| MCP | @modelcontextprotocol/sdk (Streamable HTTP transport) |
| HTTP | Express, helmet, cors |
| Auth | OAuth 2.1 (client_credentials), jose (JWT) |
| Cache | Redis (ioredis), cosine similarity embeddings |
| Resilience | opossum (circuit breaker), custom retry with jitter |
| Observability | LangSmith, pino (structured logging) |
| Testing | vitest, fault injection (chaos framework) |
| Validation | zod |

## Project Structure

```
src/
  entrypoints/     One file per Docker container
  config/          Env validation (zod), Redis client
  auth/            OAuth 2.1 JWT issuance + middleware
  agent/           LangGraphJS graph, nodes, state
  mcp/             MCP servers + client, zod schemas
  resilience/      Circuit breaker, retry, rate limiter, timeout
  chaos/           Fault injection (dev/test only, excluded from prod build)
  cache/           Semantic cache, session store
  observability/   LangSmith tracing, metrics, pino logger
  utils/           Custom errors, health endpoint, graceful shutdown
tests/
  unit/            Fast tests, no Docker needed
  integration/     Needs Redis + MCP servers
  chaos/           Failure injection scenarios
  eval/            Pre-deployment evaluation suite
    datasets/      Test case JSON files
    evaluators/    Scoring functions
fixtures/
  flights/         Mock flight API responses
```

## License

MIT
