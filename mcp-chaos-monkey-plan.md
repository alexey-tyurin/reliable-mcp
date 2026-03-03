# Plan: `mcp-chaos-monkey` — Open-Source Chaos/Fault Injection for MCP

## Context

The `reliable-mcp` project has a chaos/fault injection framework in `src/chaos/` (9 files, ~703 LOC) that injects faults at the transport level so resilience wrappers (circuit breakers, retries, timeouts) exercise naturally. The framework is already well-isolated with minimal coupling to the host project. We will extract it into a standalone open-source library called `mcp-chaos-monkey` in a separate Git repository, with implementations for both Node.js/TypeScript and Python. Then replace the inline code in `reliable-mcp` with the published package.

**Only abstraction needed (TypeScript):** Replace `createLogger` (pino) dependency with a pluggable `ChaosLogger` interface. Everything else ports nearly as-is, with `FaultTarget` generalized from a 9-member union to open `string`.

---

## Repository Structure (Monorepo)

```
mcp-chaos-monkey/
  README.md                     # Root README: project overview, links to both packages
  LICENSE                       # MIT
  typescript/                   # Node.js/TypeScript implementation
    src/
    tests/
    package.json
    tsconfig.json
    vitest.config.ts
    README.md
  python/                       # Python implementation (placeholder)
    src/mcp_chaos_monkey/
    tests/
    pyproject.toml
    README.md
```

---

## Part 1: TypeScript Implementation (`typescript/`)

### Step 1.1 — Repository scaffolding

Create a new repo `mcp-chaos-monkey` with the TypeScript package under `typescript/`:

```
typescript/
  src/
    index.ts                    # Barrel export (public API)
    guard.ts                    # assertChaosAllowed() — from src/chaos/guard.ts
    fault-types.ts              # FaultTarget = string, FaultConfig union, isFaultTarget()
    controller.ts               # ChaosController singleton — from src/chaos/controller.ts
    logger.ts                   # ChaosLogger interface + default console logger
    scenarios.ts                # ChaosScenario interface + defineScenario() helper
    admin-endpoint.ts           # registerChaosEndpoint() — from src/chaos/admin-endpoint.ts
    cli.ts                      # runCli() — from src/chaos/cli.ts
    interceptors/
      http-interceptor.ts       # createChaosAwareFetch() — from src/chaos/interceptors/
      redis-interceptor.ts      # wrapRedisWithChaos() — from src/chaos/interceptors/
      auth-interceptor.ts       # chaosAuthMiddleware + createChaosAuthMiddleware() — from src/chaos/interceptors/
  tests/
    guard.test.ts               # Ported from tests/unit/chaos-guard.test.ts
    controller.test.ts          # Ported from tests/unit/chaos-controller.test.ts
    http-interceptor.test.ts    # Ported from tests/unit/chaos-http-interceptor.test.ts
    redis-interceptor.test.ts   # Ported from tests/unit/chaos-redis-interceptor.test.ts
    auth-interceptor.test.ts    # Ported + new test for createChaosAuthMiddleware(target)
    admin-endpoint.test.ts      # New
    cli.test.ts                 # New
    scenarios.test.ts           # New
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
```

**package.json key fields:**
- `name`: `mcp-chaos-monkey`
- `type`: `module`
- `engines`: `node >=20`
- **Zero runtime dependencies**
- `peerDependencies` (optional): `express >=4.18.0`, `ioredis >=5.0.0`
- `devDependencies`: `@types/express`, `@types/node`, `express`, `ioredis`, `typescript`, `vitest`, `eslint`, `typescript-eslint`
- `exports` map: `.` (main), `./interceptors/http`, `./interceptors/redis`, `./interceptors/auth`, `./admin`, `./cli`
- `bin`: `{ "mcp-chaos": "./dist/cli.js" }`
- `files`: `["dist", "README.md", "LICENSE"]`
- TypeScript strict mode: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`

### Step 1.2 — Pluggable logger interface

Create `src/logger.ts`:

- `ChaosLogger` interface with `debug`, `info`, `warn`, `error` methods (pino-compatible signatures)
- `createConsoleLogger(name)` — default fallback, uses `console.*`
- `configureChaosLogger(factory)` — global setter, called once at startup by consumers
- `getLogger(name)` — internal, used by all library modules instead of pino's `createLogger`

Pino's `Logger` type satisfies `ChaosLogger` directly — no adapter needed for reliable-mcp.

### Step 1.3 — Open FaultTarget type

In `src/fault-types.ts`:

- `FaultTarget = string` (was a 9-member union)
- `isFaultTarget(value)` — validates non-empty string (consumers create stricter guards for their own targets)
- `FaultConfig` discriminated union — unchanged (8 fault types: latency, error, timeout, malformed, connection-refused, connection-drop, rate-limit, schema-mismatch)

### Step 1.4 — Port core modules

For each file, the only change is replacing `import { createLogger } from '../observability/logger.js'` with `import { getLogger } from './logger.js'`:

| Source file (reliable-mcp) | Library file | Additional changes |
|---|---|---|
| `src/chaos/guard.ts` | `src/guard.ts` | None |
| `src/chaos/controller.ts` | `src/controller.ts` | Logger swap only |
| `src/chaos/interceptors/http-interceptor.ts` | `src/interceptors/http-interceptor.ts` | Logger swap only |
| `src/chaos/interceptors/redis-interceptor.ts` | `src/interceptors/redis-interceptor.ts` | Logger swap only |
| `src/chaos/interceptors/auth-interceptor.ts` | `src/interceptors/auth-interceptor.ts` | Logger swap + add `createChaosAuthMiddleware(target)` factory for configurable target (default: `'oauth-token'`) |
| `src/chaos/admin-endpoint.ts` | `src/admin-endpoint.ts` | Logger swap only |
| `src/chaos/cli.ts` | `src/cli.ts` | Remove hardcoded `VALID_TARGETS` array, accept any string as target |
| `src/chaos/scenarios.ts` | `src/scenarios.ts` | Replace 10 hardcoded scenarios with `defineScenario()` builder + `ChaosScenario` interface |

### Step 1.5 — Barrel export (`src/index.ts`)

Export all public APIs: `ChaosController`, `assertChaosAllowed`, `FaultTarget`, `FaultConfig`, `isFaultTarget`, `ChaosLogger`, `configureChaosLogger`, `createConsoleLogger`, all 3 interceptors, `registerChaosEndpoint`, `runCli`, `defineScenario`, `ChaosScenario`.

### Step 1.6 — Unit tests

Port the 5 existing unit tests from `reliable-mcp/tests/unit/chaos-*.test.ts` with import path changes. Add 3 new test files for admin-endpoint, cli, and scenarios.

### Step 1.7 — README

Sections: what it does, installation, quick start, architecture diagram (fault position in resilience stack), API reference, custom targets with TypeScript type safety, Express admin endpoints, CLI usage, scenario builder, production safety guarantees.

### Step 1.8 — Verify Part 1

1. `npx tsc --noEmit` — zero errors
2. `npm run lint` — zero warnings
3. `npm run test` — all tests pass
4. `npm run build` — produces `dist/` with `.js` + `.d.ts`
5. `npm pack` — inspect tarball, verify no test files leak
6. `npm publish` (or `npm link` for local dev)

---

## Part 2: Reintegrate into `reliable-mcp`

### Step 2.1 — Install package

```bash
npm install mcp-chaos-monkey@1.0.0   # exact version, no ^
```

### Step 2.2 — Delete `src/chaos/` directory

Remove all 9 files + the `interceptors/` subdirectory.

### Step 2.3 — Create project-specific chaos config

**New file: `src/chaos-config.ts`**
- Defines `ReliableMcpTarget` type (the original 9-member union)
- Defines `isReliableMcpTarget()` type guard
- `initializeChaos()` — calls `configureChaosLogger()` with pino's `createLogger`

**New file: `src/chaos-scenarios.ts`**
- Moves the 10 project-specific scenarios here using `defineScenario()` from the library

### Step 2.4 — Update 5 integration point files

Each file changes its dynamic `import('../chaos/...')` to `import('mcp-chaos-monkey')`:

| File | Change |
|---|---|
| `src/mcp/client.ts` | `import('../chaos/controller.js')` + `import('../chaos/fault-types.js')` → `import('mcp-chaos-monkey')` |
| `src/mcp/weather-server.ts` | `import('../chaos/interceptors/http-interceptor.js')` → `import('mcp-chaos-monkey')` |
| `src/mcp/flightaware-provider.ts` | `import('../chaos/interceptors/http-interceptor.js')` → `import('mcp-chaos-monkey')` |
| `src/config/redis.ts` | `import('../chaos/interceptors/redis-interceptor.js')` → `import('mcp-chaos-monkey')` |
| `src/agent/agent-http.ts` | `import('../chaos/interceptors/auth-interceptor.js')` + `import('../chaos/admin-endpoint.js')` → `import('mcp-chaos-monkey')`. Add `initializeChaos()` call before other chaos imports. |

All `CHAOS_ENABLED` guards stay identical.

### Step 2.5 — Update chaos tests

- `tests/chaos/helpers.ts` — change `import { ChaosController } from '../../src/chaos/controller.js'` to `import { ChaosController } from 'mcp-chaos-monkey'`. Add `configureChaosLogger` call in harness setup.
- `tests/chaos/failure-scenarios.test.ts` and `recovery-scenarios.test.ts` — no changes needed (they import from `./helpers.js`)
- **Delete** the 5 `tests/unit/chaos-*.test.ts` files (coverage now lives in the library's own test suite)

### Step 2.6 — Update build configuration

| File | Change |
|---|---|
| `package.json` | Remove `&& rm -rf dist/chaos` from `build:prod`. Update `chaos:status`/`chaos:clear` to use `npx mcp-chaos`. |
| `tsconfig.prod.json` | Replace `src/chaos/**` exclusion with `src/chaos-config.ts`, `src/chaos-scenarios.ts` |
| `Dockerfile` | Remove `&& rm -rf dist/chaos` from build step |

### Step 2.7 — Update project docs

- `CLAUDE.md` — update file organization (remove `src/chaos/`, add `src/chaos-config.ts` and `src/chaos-scenarios.ts`), add `mcp-chaos-monkey` to tech stack
- `.claude/skills/chaos-testing.md` — update import paths in examples

### Step 2.8 — Verify Part 2

1. `npx tsc --noEmit` — zero errors
2. `npm run lint` — zero warnings
3. `npm run test:unit` — passes
4. `npm run test:integration` — passes
5. `CHAOS_ENABLED=true npm run test:chaos` — all failure + recovery scenarios pass
6. `npm run build:prod` — succeeds, `dist/` has no chaos files
7. `docker build .` — succeeds
8. `npm run predeploy` — full gate passes

---

## Part 3: Python Implementation — Placeholder (`python/`)

> **Status: Placeholder.** This section will be elaborated after Part 1 (TypeScript) is complete. The goal is to provide an equivalent chaos/fault injection framework for Python MCP projects, sharing the same concepts, fault types, and API shape as the TypeScript version.

### 3.1 — Planned structure

```
python/
  src/mcp_chaos_monkey/
    __init__.py                 # Public API exports
    guard.py                    # assert_chaos_allowed() — same env var guards
    fault_types.py              # FaultTarget (str), FaultConfig (dataclass/TypedDict union)
    controller.py               # ChaosController singleton
    logger.py                   # ChaosLogger protocol + default logging.getLogger
    scenarios.py                # ChaosScenario dataclass + define_scenario() helper
    admin_endpoint.py           # FastAPI/Flask admin routes (optional)
    cli.py                      # Click/argparse CLI tool
    interceptors/
      __init__.py
      http_interceptor.py       # Wraps httpx/aiohttp/requests
      redis_interceptor.py      # Wraps redis-py / aioredis
      auth_interceptor.py       # ASGI/WSGI middleware
  tests/
    test_guard.py
    test_controller.py
    test_http_interceptor.py
    test_redis_interceptor.py
    test_auth_interceptor.py
    test_admin_endpoint.py
    test_cli.py
    test_scenarios.py
  pyproject.toml                # PEP 621 project metadata
  README.md
```

### 3.2 — Key design decisions (to be finalized)

| Decision | Options | Notes |
|---|---|---|
| Package name on PyPI | `mcp-chaos-monkey` | Match npm name |
| Python version | `>=3.11` | For `StrEnum`, `TypedDict`, modern typing |
| HTTP interceptor target | `httpx` vs `aiohttp` vs `requests` | Likely `httpx` (sync+async) as primary, others as optional |
| Redis interceptor target | `redis-py` vs `aioredis` | `redis-py` (has async support built-in since v4.2) |
| Web framework for admin | `FastAPI` vs `Flask` vs framework-agnostic | Likely FastAPI (async-native, type-safe) |
| Type safety | `TypedDict` vs `dataclass` vs `pydantic` for FaultConfig | `dataclass` for zero deps, `pydantic` as optional |
| Testing framework | `pytest` | Standard |
| Async support | Native `asyncio` | Python MCP SDK is async |

### 3.3 — API shape (draft, mirrors TypeScript)

```python
from mcp_chaos_monkey import ChaosController, configure_logger, define_scenario
from mcp_chaos_monkey.interceptors import create_chaos_aware_client, wrap_redis_with_chaos

# Configure logger (default: logging.getLogger)
configure_logger(lambda name: structlog.get_logger(name))

# Inject faults
controller = ChaosController.get_instance()
fault_id = controller.inject("weather-api", {"type": "error", "status_code": 503})

# Wrap httpx client
client = create_chaos_aware_client("weather-api", httpx.AsyncClient())

# Wrap Redis
unwrap = wrap_redis_with_chaos(redis_client, "redis")

# Define scenarios
scenario = define_scenario(
    name="api-timeout",
    description="API hangs for 10s",
    faults=[{"target": "weather-api", "config": {"type": "timeout", "hang_ms": 10000}}],
    expected_behavior="Circuit opens after retries exhaust",
    assertions=["Circuit transitions to OPEN"],
)

# Cleanup
controller.clear(fault_id)
controller.clear_all()
```

### 3.4 — Shared concepts across TypeScript and Python

These must be consistent between both implementations:

- **Fault types:** Same 8 types (latency, error, timeout, malformed, connection-refused, connection-drop, rate-limit, schema-mismatch)
- **Production guard:** Same 2 checks (NODE_ENV/ENVIRONMENT != production, CHAOS_ENABLED == true)
- **Controller API:** inject, clear, clear_all, get_fault, get_active_faults, reset
- **Interceptor pattern:** Wrap at transport level, inside resilience stack
- **Scenario interface:** name, description, faults, expected_behavior, assertions
- **Admin endpoints:** Same 4 routes (GET /chaos/status, POST /chaos/inject, POST /chaos/clear, POST /chaos/clear-all)
- **CLI commands:** Same 4 commands (inject, clear, clear-all, status)

### 3.5 — TODO (to be elaborated)

- [ ] Finalize Python HTTP interceptor approach (httpx transport hooks vs monkey-patching)
- [ ] Decide on FaultConfig representation (dataclass vs TypedDict vs pydantic)
- [ ] Design async-first controller (Python MCP SDK is async)
- [ ] Determine if admin endpoint should use FastAPI or be framework-agnostic
- [ ] Write Python-specific README with MCP Python SDK examples
- [ ] Set up CI/CD for PyPI publishing
- [ ] Consider shared JSON schema for fault configs (cross-language validation)
