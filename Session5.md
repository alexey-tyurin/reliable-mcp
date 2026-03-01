Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Create the LangGraphJS agent in src/agent/. Write tests first for the graph structure and each node function. The graph state should track: messages array, user_id, session_id, tool_results, error state — define as a TypeScript interface, no any types. 
Define nodes: 
1) 'route' — LLM decides which tools to call, 
2) 'execute_tools' — calls MCP tools via MCP client, 
3) 'respond' — LLM generates final answer from tool results. 
Each node is a pure-ish function: takes state, returns updated state — easy to test in isolation. The agent should handle combined weather+flight queries in a single turn. Use gpt-4o-mini via @langchain/openai.

Connect to both MCP servers via src/mcp/client.ts using Streamable HTTP client transport. The client reads MCP server URLs from env vars: WEATHER_MCP_URL (default: http://localhost:3001/mcp) and FLIGHT_MCP_URL (default: http://localhost:3002/mcp). In Docker, these resolve to container hostnames (http://weather-mcp:3001/mcp). The MCP client should handle connection failures gracefully — if a server is unreachable, the agent can still use the other server for partial responses. Wrap MCP client HTTP calls in the circuit breaker from src/resilience/.

Integrate session memory from Redis — load previous context at start, save after response. Register MCP client cleanup in shutdown registry. Keep each node function in its own clearly-named function — no inline lambdas in the graph definition.

Create src/entrypoints/agent.ts that boots: env config → logger → Redis → MCP client connections → Express app (from Session 7) → graceful shutdown. This is the Docker container entrypoint for the agent service.