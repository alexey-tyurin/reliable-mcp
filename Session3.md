Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Follow the patterns in .claude/skills/mcp-server.md and .claude/skills/docker-service.md. Create the Weather MCP server using Streamable HTTP transport. Follow TDD: write integration tests first that send HTTP requests to the MCP endpoint and assert the response shape, then implement.

Create src/mcp/weather-server.ts — an MCP server using @modelcontextprotocol/sdk with Streamable HTTP transport. The server is an Express app that:
- Mounts the MCP SDK's StreamableHTTPServerTransport at POST /mcp
- Exposes GET /health using the shared health handler
- Listens on the port from env config (default 3001)
- Registers the HTTP server in the graceful shutdown registry

It exposes one tool 'get_weather' with this schema: [paste from Section 4.1 from implementation-plan.md]. The tool handler: validates input with zod, calls WeatherAPI.com current.json endpoint (https://api.weatherapi.com/v1/current.json?key={API_KEY}&q={city}&aqi=no) wrapped in circuit breaker + retry, maps the response to the output schema, returns as TextContent.

Create src/mcp/schemas.ts with the zod schemas. Handle all errors gracefully — never crash the MCP server. Ensure the HTTP client (fetch/axios) uses AbortController so in-flight requests are cancelled on shutdown.

Create src/entrypoints/weather-mcp.ts that boots: env config → logger → weather MCP server → graceful shutdown. This is the Docker container entrypoint.

Integration tests should start the MCP server on a random port, send MCP tool calls via HTTP, and assert responses. Tests must clean up the server after each test.