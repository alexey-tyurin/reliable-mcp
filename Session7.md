OAuth & HTTP Layer

Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Create using TDD: 
1) src/auth/oauth-server.ts — minimal OAuth 2.1 token endpoint that issues JWTs (for dev/test). 
Support client_credentials grant. 
Use jose library. Write tests first: valid grant returns JWT, invalid client_id rejected, missing fields rejected. 
2) src/auth/oauth-middleware.ts — Express middleware that validates JWT from Authorization Bearer header, extracts user_id, attaches to req. 
Write tests first: valid JWT passes, expired JWT returns 401 with clear message, malformed token returns 401, missing header returns 401. 
Never log the token value itself — only metadata. 
3) Wire the Express app in src/entrypoints/agent.ts with: helmet (with strict CSP), cors (specific origins, not *), JSON body parser (with size limit: 10kb), auth middleware, rate limiter middleware, POST /chat endpoint that runs the agent, GET /health using shared handler. 
Register Express server cleanup in shutdown registry with connection draining. 
Run npm run lint and fix any warnings.