Evaluation Suite

Follow TDD strictly: write failing tests first, then implement the minimum code to pass, then refactor. 
Refer to CLAUDE.md for project rules and .claude/skills/ for relevant patterns. 
Run npm run lint before considering the task done — zero warnings required.

Create a pre-deployment evaluation system in tests/eval/. 

1) Create tests/eval/datasets/ with three JSON dataset files:
   - tool-calling.json: 30+ test cases, each with {input: string, expected_tools: string[], expected_params_subset?: object}. Cover categories: weather-only ('What's the temp in Paris?'), flight-only ('Is BA456 on time?'), combined ('Weather in NYC and status of UA123'), ambiguous ('Tell me about my trip'), no-tool ('What can you help me with?'), multi-city weather, flights with dates, and misspelled cities.
   - e2e-flows.json: 15+ multi-turn conversations, each with {turns: [{role, content}], assertions: {session_memory_keys?, cache_hit_expected?, tools_called_per_turn?}}.
   - edge-cases.json: 15+ adversarial inputs: prompt injection ('Ignore instructions and...'), unknown cities, invalid flight numbers (ZZZZZ999), gibberish, empty string, 10,000-char input, SQL injection in city name, special characters.

2) Create tests/eval/evaluators/:
   - tool-selection.ts: Takes agent response trace, checks tools_called matches expected_tools. Returns {score: 1.0|0.5|0.0, reason: string}. 1.0 = exact match, 0.5 = correct tools but extra call, 0.0 = wrong/missing tool.
   - response-quality.ts: Uses a separate LLM call (gpt-4o-mini) as judge. Prompt: 'Rate this chatbot response on accuracy (1-5), completeness (1-5), and tone (1-5). The user asked: {query}. The tools returned: {tool_results}. The chatbot responded: {response}.' Parse scores, flag any below 3.
   - latency-budget.ts: Assert response time: ≤3s for cache hits, ≤8s for single tool calls, ≤12s for combined tool calls, ≤15s absolute max. Return {pass: boolean, actual_ms: number, budget_ms: number}.
   - resilience.ts: Run a subset of tool-calling dataset with injected failures (mock weather API 500, mock flight API timeout, Redis disconnected). Check that: response contains user-friendly error message, no stack traces leaked, partial results returned when possible, correct LangSmith error tags set.

3) Create tests/eval/run-eval.ts: Main runner that:
   - Loads all datasets
   - Runs each input through the real agent (using mock flight provider, real weather API or mocked)
   - Applies all relevant evaluators to each result
   - Collects scores into a summary: {total, passed, failed, tool_accuracy_pct, avg_quality_score, latency_p50_ms, latency_p95_ms, critical_failures: []}
   - Optionally pushes results to LangSmith as an experiment run (via --langsmith flag)
   - Exits with code 1 if tool_accuracy < 90% or critical_failures > 0

4) Create tests/eval/report.ts: Formats the summary as a table printed to console, and optionally writes eval-report.json to disk.

5) Add npm scripts: 'eval' runs the full suite, 'eval:quick' runs only tool-calling dataset (for fast iteration), 'eval:resilience' runs only resilience evaluator.

The eval suite should use FLIGHT_PROVIDER=mock by default. It should be runnable in CI. Write it so new test cases can be added to the JSON files without changing code.
