LangSmith Observability

Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Create src/observability/langsmith.ts and src/observability/metrics.ts. 
Integrate LangSmith tracing into the LangGraphJS agent — every run should be traced with metadata: user_id, session_id, cache_hit (bool), tools_called (array), total_tokens, estimated_cost_usd, latency_ms, error (if any). 
Create helper functions to track: token costs per model, error counts by type, cache hit rate, circuit breaker state transitions. 
Tag LangSmith runs so they can be filtered in the dashboard.
