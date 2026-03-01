Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Create src/cache/semantic-cache.ts. 
Write unit tests first with mocked embeddings — test cache hit, cache miss, TTL expiry, timeout bypass, and similarity threshold edge cases. 
Then implement. 
On query: 
1) generate embedding via OpenAI text-embedding-3-small, 
2) search Redis for cached embeddings with cosine similarity ≥ 0.92, 
3) if hit, return cached response. 
On response: 
store embedding + response in Redis with TTL (weather queries: 30 min, flight queries: 5 min, mixed: 5 min). 
Use a 500ms timeout on all cache operations — bypass cache on timeout. 
Track cache hit/miss as metrics. 
The cosine similarity function should be its own tested utility, not inlined. 
Use explicit types for cache entries — no untyped JSON blobs in Redis.