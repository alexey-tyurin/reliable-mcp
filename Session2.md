Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Follow the pattern in .claude/skills/resilience-wrapper.md. Create the resilience layer using TDD — write each test file before the implementation file. 
1) src/resilience/circuit-breaker.ts — a factory function that wraps any async function with opossum circuit breaker using these settings: [paste config]. 
2) src/resilience/retry.ts — exponential backoff with jitter, configurable max retries, base delay, jitter factor. Should accept a predicate for retryable errors. 
3) src/resilience/rate-limiter.ts — Redis-backed sliding window rate limiter using rate-limiter-flexible, keyed by user ID, 30 req/min default. 
4) src/resilience/timeout.ts — wraps any promise with a timeout that rejects with a TimeoutError. 
For each utility: write the test file first covering success, failure, and edge cases, then implement. 
No any types. 
Use custom error classes (TimeoutError, CircuitOpenError, RateLimitError) from src/utils/errors.ts. 
Keep each file under 100 lines — these are focused utilities.