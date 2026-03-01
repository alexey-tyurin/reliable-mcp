Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Follow the patterns in .claude/skills/mcp-server.md and .claude/skills/docker-service.md. Create the Flight MCP server using Streamable HTTP transport — same architecture pattern as the weather server. Follow TDD: write tests for both providers first, then implement.

Create src/mcp/flight-server.ts — MCP server with Streamable HTTP transport on port 3002 (default). Express app mounting MCP SDK at POST /mcp, GET /health, graceful shutdown.

Tool 'get_flight_status' with this schema: [paste from Section 4.2 in implementation-plan.md]. Implement a FlightProvider interface with two implementations: 
1) MockFlightProvider — reads from JSON fixtures in fixtures/flights/ directory, mapping test flight numbers (TEST001=on-time, TEST002=delayed, TEST003=cancelled, TEST004=in-air) to fixture files. 
2) FlightAwareProvider — calls FlightAware AeroAPI (https://aeroapi.flightaware.com/aeroapi/flights/{flight_number}) with x-apikey header auth, wrapped in circuit breaker + retry. Select provider via FLIGHT_PROVIDER env var (default: 'mock'). 
Create the 4 fixture JSON files with realistic flight data.

Create src/entrypoints/flight-mcp.ts that boots: env config → logger → flight MCP server → graceful shutdown.

Follow same patterns as weather server: zod validation, error handling, shutdown cleanup, AbortController for HTTP requests. The FlightProvider interface should be clean and minimal — easy to add AeroDataBox or AviationStack later. Integration tests should start the server on a random port and test via HTTP.