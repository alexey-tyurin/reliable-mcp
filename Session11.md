Final Integration & README

Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.


Do a final integration review of the entire project. 

1) Full Docker deployment test: docker compose build && docker compose up — all 4 containers start, health checks pass for all services within 30s.
2) Test the full flow via Docker: authenticate → send combined weather+flight query to agent container → get response → verify LangSmith trace shows tools called via HTTP to MCP containers.
3) Test session memory: ask about UA123, then in a new session ask 'is my flight still on time?' and verify it remembers UA123.
4) Test partial degradation via Docker: stop weather-mcp container → verify agent still answers flight queries. Stop flight-mcp → verify agent still answers weather queries. Restart both → verify recovery.
5) Run the full evaluation suite (npm run eval) and verify all thresholds pass — fix any failures.
6) Run eval with --langsmith flag and verify the experiment appears in the LangSmith dashboard.
7) Write a comprehensive README.md with: project overview, architecture diagram (mermaid showing all 4 containers and their connections), setup instructions (Docker and local dev), environment variables per service, Docker commands reference, API usage examples with curl, testing instructions, evaluation guide (how to run evals, add test cases, interpret results), monitoring/observability guide, deployment guide (how to deploy containers individually, how to scale).
