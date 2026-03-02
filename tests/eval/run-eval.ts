import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateToolSelection } from './evaluators/tool-selection.js';
import { evaluateLatencyBudget } from './evaluators/latency-budget.js';
import { evaluateResilience } from './evaluators/resilience.js';
import { evaluateResponseQuality } from './evaluators/response-quality.js';
import type { QualityJudge } from './evaluators/response-quality.js';
import { formatReportTable, writeReportToFile } from './report.js';
import type { EvalSummary, CriticalFailure } from './report.js';

const currentDir = dirname(fileURLToPath(import.meta.url));

export interface ToolCallingTestCase {
  input: string;
  expected_tools: string[];
  expected_params_subset?: Record<string, unknown>;
  category: string;
}

interface EdgeCaseTestCase {
  input: string;
  category: string;
  assertions: {
    should_respond?: boolean;
    should_not_contain?: string[];
    should_handle_gracefully?: boolean;
    no_stack_trace?: boolean;
    expected_tools?: string[];
  };
}

interface AgentInvokeResult {
  response: string;
  toolsCalled: string[];
  latencyMs: number;
  cacheHit: boolean;
  error?: string;
  statusCode: number;
  rawBody: Record<string, unknown>;
}

interface AgentRunner {
  invoke: (message: string, sessionId?: string) => Promise<AgentInvokeResult>;
}

interface EvalConfig {
  runner: AgentRunner;
  qualityJudge?: QualityJudge;
  pushToLangSmith?: boolean;
}

export function loadDataset<T>(name: string): T[] {
  const filePath = resolve(currentDir, 'datasets', `${name}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dataset name from internal allowlist, not user input
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T[];
}

export function computePercentiles(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  const clampedIndex = Math.max(0, Math.min(index, sorted.length - 1));
  const value = sorted.at(clampedIndex);
  return value ?? 0;
}

function expandLongInput(input: string): string {
  if (input === '__GENERATE_LONG_INPUT_10000__') {
    return 'What is the weather? '.repeat(500).trim();
  }
  return input;
}

function determineCallType(tools: string[]): 'none' | 'single' | 'combined' {
  if (tools.length === 0) {
    return 'none';
  }
  if (tools.length === 1) {
    return 'single';
  }
  return 'combined';
}

function formatToolList(tools: string[]): string {
  return tools.length === 0 ? '(none)' : `[${tools.join(', ')}]`;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + '...';
}

async function runToolCallingEval(
  dataset: ToolCallingTestCase[],
  runner: AgentRunner,
): Promise<{
  results: { input: string; score: number; reason: string; latencyMs: number }[];
  criticalFailures: CriticalFailure[];
}> {
  const results: { input: string; score: number; reason: string; latencyMs: number }[] = [];
  const criticalFailures: CriticalFailure[] = [];

  process.stdout.write('\n  TOOL CALLING EVAL\n');

  for (const testCase of dataset) {
    try {
      const agentResult = await runner.invoke(testCase.input);
      const toolResult = evaluateToolSelection(agentResult.toolsCalled, testCase.expected_tools);
      const callType = determineCallType(testCase.expected_tools);
      const latencyResult = evaluateLatencyBudget(
        agentResult.latencyMs,
        agentResult.cacheHit,
        callType,
      );

      results.push({
        input: testCase.input,
        score: toolResult.score,
        reason: toolResult.reason,
        latencyMs: agentResult.latencyMs,
      });

      const label = toolResult.score >= 1.0 ? 'PASS' : 'FAIL';
      const inputPreview = truncate(testCase.input, 55);
      const expected = formatToolList(testCase.expected_tools);
      const actual = formatToolList(agentResult.toolsCalled);

      if (toolResult.score >= 1.0) {
        process.stdout.write(`  [${label}] "${inputPreview}" → ${actual} (${String(agentResult.latencyMs)}ms)\n`);
      } else {
        process.stdout.write(`  [${label}] "${inputPreview}"\n`);
        process.stdout.write(`         expected: ${expected}  got: ${actual}\n`);
        process.stdout.write(`         reason: ${toolResult.reason}\n`);
        process.stdout.write(`         response: "${truncate(agentResult.response, 80)}"\n`);
      }

      if (!latencyResult.pass) {
        process.stdout.write(`         LATENCY EXCEEDED: ${String(latencyResult.actualMs)}ms > ${String(latencyResult.budgetMs)}ms budget\n`);
        criticalFailures.push({
          testCase: testCase.input.slice(0, 60),
          reason: `Latency ${latencyResult.actualMs}ms exceeded budget ${latencyResult.budgetMs}ms`,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`  [ERR]  "${truncate(testCase.input, 55)}"\n`);
      process.stdout.write(`         ${message}\n`);
      results.push({ input: testCase.input, score: 0, reason: `Error: ${message}`, latencyMs: 0 });
      criticalFailures.push({
        testCase: testCase.input.slice(0, 60),
        reason: `Execution error: ${message}`,
      });
    }
  }

  process.stdout.write('\n');

  return { results, criticalFailures };
}

async function runEdgeCaseEval(
  dataset: EdgeCaseTestCase[],
  runner: AgentRunner,
): Promise<{ criticalFailures: CriticalFailure[] }> {
  const criticalFailures: CriticalFailure[] = [];

  process.stdout.write('  EDGE CASE EVAL\n');

  for (const testCase of dataset) {
    const input = expandLongInput(testCase.input);

    if (testCase.assertions.should_handle_gracefully && input.length === 0) {
      continue;
    }

    try {
      const agentResult = await runner.invoke(input);
      const bodyString = JSON.stringify(agentResult.rawBody);
      let caseFailed = false;

      if (testCase.assertions.no_stack_trace) {
        const stackPattern = /at\s+\w+\s*\(.*:\d+:\d+\)/;
        if (stackPattern.test(bodyString)) {
          caseFailed = true;
          criticalFailures.push({
            testCase: `edge:${testCase.category}`,
            reason: 'Stack trace leaked in response',
          });
        }
      }

      if (testCase.assertions.should_not_contain) {
        for (const forbidden of testCase.assertions.should_not_contain) {
          if (bodyString.toLowerCase().includes(forbidden.toLowerCase())) {
            caseFailed = true;
            criticalFailures.push({
              testCase: `edge:${testCase.category}`,
              reason: `Response contains forbidden content: "${forbidden}"`,
            });
          }
        }
      }

      const label = caseFailed ? 'FAIL' : 'PASS';
      const inputPreview = truncate(input, 50);
      process.stdout.write(`  [${label}] edge:${testCase.category} "${inputPreview}" (${String(agentResult.latencyMs)}ms)\n`);
      if (caseFailed) {
        process.stdout.write(`         response: "${truncate(agentResult.response, 80)}"\n`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`  [ERR]  edge:${testCase.category} "${truncate(input, 50)}"\n`);
      process.stdout.write(`         ${message}\n`);
      criticalFailures.push({
        testCase: `edge:${testCase.category}`,
        reason: `Execution error: ${message}`,
      });
    }
  }

  process.stdout.write('\n');

  return { criticalFailures };
}

interface ResilienceScenario {
  name: string;
  description: string;
  run: (runner: AgentRunner) => Promise<ResilienceScenarioResult>;
}

interface ResilienceScenarioResult {
  passed: boolean;
  reason: string;
  latencyMs: number;
  details: string;
}

function createEndToEndScenarios(): ResilienceScenario[] {
  return [
    {
      name: 'weather-e2e',
      description: 'Weather query returns real data with correct tool',
      run: async (runner) => {
        const result = await runner.invoke('What is the weather in London?');
        const toolResult = evaluateToolSelection(result.toolsCalled, ['get_weather']);
        const hasContent = result.response.length > 0 && result.statusCode === 200;
        const passed = toolResult.score >= 1.0 && hasContent;
        return {
          passed,
          reason: passed ? 'Correct tool, valid response' : `${toolResult.reason}; status=${String(result.statusCode)}`,
          latencyMs: result.latencyMs,
          details: `tools=${formatToolList(result.toolsCalled)} response="${truncate(result.response, 80)}"`,
        };
      },
    },
    {
      name: 'flight-e2e',
      description: 'Flight query returns real data with correct tool',
      run: async (runner) => {
        const result = await runner.invoke('Check flight TEST001');
        const toolResult = evaluateToolSelection(result.toolsCalled, ['get_flight_status']);
        const hasContent = result.response.length > 0 && result.statusCode === 200;
        const passed = toolResult.score >= 1.0 && hasContent;
        return {
          passed,
          reason: passed ? 'Correct tool, valid response' : `${toolResult.reason}; status=${String(result.statusCode)}`,
          latencyMs: result.latencyMs,
          details: `tools=${formatToolList(result.toolsCalled)} response="${truncate(result.response, 80)}"`,
        };
      },
    },
    {
      name: 'combined-e2e',
      description: 'Combined query uses both tools in single request',
      run: async (runner) => {
        const result = await runner.invoke('Weather in Paris and status of TEST002');
        const toolResult = evaluateToolSelection(result.toolsCalled, ['get_weather', 'get_flight_status']);
        const hasContent = result.response.length > 0 && result.statusCode === 200;
        const passed = toolResult.score >= 1.0 && hasContent;
        return {
          passed,
          reason: passed ? 'Both tools called, valid response' : `${toolResult.reason}; status=${String(result.statusCode)}`,
          latencyMs: result.latencyMs,
          details: `tools=${formatToolList(result.toolsCalled)} response="${truncate(result.response, 80)}"`,
        };
      },
    },
    {
      name: 'no-stack-trace',
      description: 'Error responses do not leak stack traces',
      run: async (runner) => {
        const result = await runner.invoke('Check flight INVALID_999_NONEXISTENT');
        const resilienceResult = evaluateResilience({
          responseBody: result.rawBody,
          statusCode: result.statusCode,
          faultType: 'invalid-input',
        });
        const passed = !resilienceResult.hasStackTrace;
        return {
          passed,
          reason: passed ? 'No stack trace in response' : 'Stack trace leaked in response',
          latencyMs: result.latencyMs,
          details: `status=${String(result.statusCode)} response="${truncate(result.response, 80)}"`,
        };
      },
    },
    {
      name: 'rate-limit',
      description: 'Rate limiter returns 429 with friendly message under burst',
      run: async (runner) => {
        const rateLimiterPoints = Number(process.env['RATE_LIMITER_POINTS']) || 30;
        const burstSize = rateLimiterPoints + 5;
        const promises = Array.from({ length: burstSize }, (_, i) =>
          runner.invoke('Hello', `rate-limit-eval-${String(i)}`),
        );
        const startTime = Date.now();
        const results = await Promise.allSettled(promises);
        const latencyMs = Date.now() - startTime;

        const statuses = results.map((r) =>
          r.status === 'fulfilled' ? r.value.statusCode : 0,
        );
        const got429 = statuses.some((s) => s === 429);
        const rateLimitedResponses = results.filter((r) =>
          r.status === 'fulfilled' && r.value.statusCode === 429,
        );

        let friendlyMessage = true;
        for (const r of rateLimitedResponses) {
          if (r.status === 'fulfilled') {
            const res = evaluateResilience({
              responseBody: r.value.rawBody,
              statusCode: r.value.statusCode,
              faultType: 'rate-limit',
            });
            if (!res.hasUserFriendlyMessage) {
              friendlyMessage = false;
            }
          }
        }

        const passed = got429 && friendlyMessage;
        const statusSummary = `200s: ${String(statuses.filter((s) => s === 200).length)}, 429s: ${String(statuses.filter((s) => s === 429).length)}`;
        return {
          passed,
          reason: passed
            ? `Rate limiter triggered correctly (${statusSummary})`
            : got429
              ? `429 returned but missing friendly message (${statusSummary})`
              : `Rate limiter did NOT trigger after ${String(burstSize)} burst requests (${statusSummary})`,
          latencyMs,
          details: statusSummary,
        };
      },
    },
  ];
}

async function runResilienceEval(
  runner: AgentRunner,
): Promise<{ criticalFailures: CriticalFailure[]; scenarioResults: ResilienceScenarioResult[]; totalScenarios: number }> {
  const criticalFailures: CriticalFailure[] = [];
  const scenarioResults: ResilienceScenarioResult[] = [];
  const scenarios = createEndToEndScenarios();

  process.stdout.write('\n  RESILIENCE EVAL\n');

  for (const scenario of scenarios) {
    try {
      const result = await scenario.run(runner);
      scenarioResults.push(result);
      const label = result.passed ? 'PASS' : 'FAIL';
      process.stdout.write(`  [${label}] ${scenario.name}: ${scenario.description}\n`);
      process.stdout.write(`         ${result.reason} (${String(result.latencyMs)}ms)\n`);
      process.stdout.write(`         ${result.details}\n`);

      if (!result.passed) {
        criticalFailures.push({
          testCase: `resilience:${scenario.name}`,
          reason: result.reason,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`  [ERR]  ${scenario.name}: ${scenario.description}\n`);
      process.stdout.write(`         ${message}\n`);
      scenarioResults.push({ passed: false, reason: message, latencyMs: 0, details: '' });
      criticalFailures.push({
        testCase: `resilience:${scenario.name}`,
        reason: `Execution error: ${message}`,
      });
    }
  }

  process.stdout.write('\n');

  return { criticalFailures, scenarioResults, totalScenarios: scenarios.length };
}

async function runQualityEval(
  dataset: ToolCallingTestCase[],
  runner: AgentRunner,
  judge: QualityJudge,
): Promise<{ avgScore: number }> {
  const scores: number[] = [];
  const sampleSize = Math.min(10, dataset.length);
  const sample = dataset.slice(0, sampleSize);

  for (const testCase of sample) {
    try {
      const agentResult = await runner.invoke(testCase.input);
      const quality = await evaluateResponseQuality({
        query: testCase.input,
        toolResults: JSON.stringify(agentResult.rawBody),
        response: agentResult.response,
        judge,
      });
      scores.push(quality.averageScore);
    } catch {
      scores.push(0);
    }
  }

  const avgScore = scores.length > 0
    ? scores.reduce((sum, s) => sum + s, 0) / scores.length
    : 0;

  return { avgScore };
}

export async function runFullEval(config: EvalConfig): Promise<EvalSummary> {
  const toolCallingDataset = loadDataset<ToolCallingTestCase>('tool-calling');
  const edgeCaseDataset = loadDataset<EdgeCaseTestCase>('edge-cases');

  const toolCallingResult = await runToolCallingEval(toolCallingDataset, config.runner);
  const edgeCaseResult = await runEdgeCaseEval(edgeCaseDataset, config.runner);

  const allCriticalFailures = [
    ...toolCallingResult.criticalFailures,
    ...edgeCaseResult.criticalFailures,
  ];

  const totalScores = toolCallingResult.results.map((r) => r.score);
  const passed = totalScores.filter((s) => s >= 1.0).length;
  const failed = totalScores.length - passed;
  const toolAccuracyPct = totalScores.length > 0
    ? Math.round((totalScores.reduce((sum, s) => sum + s, 0) / totalScores.length) * 1000) / 10
    : 0;

  const latencies = toolCallingResult.results
    .map((r) => r.latencyMs)
    .filter((l) => l > 0);

  let avgQualityScore = 0;
  if (config.qualityJudge) {
    const qualityResult = await runQualityEval(
      toolCallingDataset,
      config.runner,
      config.qualityJudge,
    );
    avgQualityScore = qualityResult.avgScore;
  }

  return {
    total: toolCallingResult.results.length,
    passed,
    failed,
    toolAccuracyPct,
    avgQualityScore,
    latencyP50Ms: computePercentiles(latencies, 50),
    latencyP95Ms: computePercentiles(latencies, 95),
    criticalFailures: allCriticalFailures,
  };
}

export async function runQuickEval(config: EvalConfig): Promise<EvalSummary> {
  const toolCallingDataset = loadDataset<ToolCallingTestCase>('tool-calling');
  const toolCallingResult = await runToolCallingEval(toolCallingDataset, config.runner);

  const totalScores = toolCallingResult.results.map((r) => r.score);
  const passed = totalScores.filter((s) => s >= 1.0).length;
  const failed = totalScores.length - passed;
  const toolAccuracyPct = totalScores.length > 0
    ? Math.round((totalScores.reduce((sum, s) => sum + s, 0) / totalScores.length) * 1000) / 10
    : 0;

  const latencies = toolCallingResult.results
    .map((r) => r.latencyMs)
    .filter((l) => l > 0);

  return {
    total: toolCallingResult.results.length,
    passed,
    failed,
    toolAccuracyPct,
    avgQualityScore: 0,
    latencyP50Ms: computePercentiles(latencies, 50),
    latencyP95Ms: computePercentiles(latencies, 95),
    criticalFailures: toolCallingResult.criticalFailures,
  };
}

export async function runResilienceOnlyEval(config: EvalConfig): Promise<EvalSummary> {
  const resilienceResult = await runResilienceEval(config.runner);

  const passedCount = resilienceResult.scenarioResults.filter((r) => r.passed).length;
  const latencies = resilienceResult.scenarioResults
    .map((r) => r.latencyMs)
    .filter((l) => l > 0);
  const accuracyPct = resilienceResult.totalScenarios > 0
    ? Math.round((passedCount / resilienceResult.totalScenarios) * 1000) / 10
    : 0;

  return {
    total: resilienceResult.totalScenarios,
    passed: passedCount,
    failed: resilienceResult.totalScenarios - passedCount,
    toolAccuracyPct: accuracyPct,
    avgQualityScore: 0,
    latencyP50Ms: computePercentiles(latencies, 50),
    latencyP95Ms: computePercentiles(latencies, 95),
    criticalFailures: resilienceResult.criticalFailures,
  };
}

const TOOL_ACCURACY_THRESHOLD = 90;

async function pushToLangSmith(summary: EvalSummary): Promise<void> {
  const { Client } = await import('langsmith');
  const client = new Client();

  const datasetName = 'mcp-chatbot-eval';
  const experimentName = `eval-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}`;

  let dataset;
  try {
    dataset = await client.readDataset({ datasetName });
  } catch {
    dataset = await client.createDataset(datasetName, {
      description: 'MCP Chatbot tool-calling evaluation dataset',
    });
  }

  const toolCallingData = loadDataset<ToolCallingTestCase>('tool-calling');

  const existingExamples = [];
  for await (const example of client.listExamples({ datasetId: dataset.id })) {
    existingExamples.push(example);
  }

  if (existingExamples.length === 0) {
    await client.createExamples({
      inputs: toolCallingData.map((tc) => ({ message: tc.input, category: tc.category })),
      outputs: toolCallingData.map((tc) => ({ expected_tools: tc.expected_tools })),
      datasetId: dataset.id,
    });
  }

  const { evaluate } = await import('langsmith/evaluation');
  const { createRealAgentRunner } = await import('./real-agent-runner.js');
  const baseUrl = resolveBaseUrl();
  const oauthSecret = process.env['OAUTH_SECRET'] ?? '';
  const runner = createRealAgentRunner({
    baseUrl,
    oauthClientId: 'default-client',
    oauthClientSecret: oauthSecret,
  });

  await evaluate(
    async (input: Record<string, unknown>) => {
      const inputs = (input['inputs'] ?? input) as Record<string, unknown>;
      const message = String(inputs['message'] ?? '');
      const result = await runner.invoke(message);
      return { tools_called: result.toolsCalled, response: result.response };
    },
    {
      data: datasetName,
      experimentPrefix: experimentName,
      metadata: {
        tool_accuracy_pct: summary.toolAccuracyPct,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        latency_p50_ms: summary.latencyP50Ms,
        latency_p95_ms: summary.latencyP95Ms,
        critical_failures: summary.criticalFailures.length,
      },
    },
  );

  process.stdout.write(`\nLangSmith experiment "${experimentName}" pushed to dataset "${datasetName}"\n`);
}

async function waitForRateLimiter(runner: AgentRunner): Promise<void> {
  const probe = await runner.invoke('Hello', `rate-limit-probe-${Date.now()}`);
  if (probe.statusCode !== 429) {
    return;
  }

  const retryAfter = typeof probe.rawBody['retryAfterSeconds'] === 'number'
    ? probe.rawBody['retryAfterSeconds']
    : 60;
  const waitSeconds = Math.ceil(retryAfter) + 1;

  process.stdout.write(`  Rate limiter active, waiting ${String(waitSeconds)}s for reset...\n`);
  await new Promise<void>((resolve) => { setTimeout(resolve, waitSeconds * 1000); });
}

function resolveBaseUrl(): string {
  const envUrl = process.env['AGENT_BASE_URL'];
  if (envUrl && envUrl.length > 0) {
    return envUrl;
  }
  const port = process.env['PORT'] ?? '3000';
  return `http://localhost:${port}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isQuick = args.includes('--quick');
  const isResilience = args.includes('--resilience');
  const writeReport = args.includes('--report');
  const isLangSmith = args.includes('--langsmith');

  process.env['FLIGHT_PROVIDER'] = process.env['FLIGHT_PROVIDER'] ?? 'mock';

  const baseUrl = resolveBaseUrl();
  const oauthSecret = process.env['OAUTH_SECRET'] ?? '';
  if (oauthSecret.length === 0) {
    throw new Error('OAUTH_SECRET env var is required for eval. Set it in .env or export it.');
  }

  const { createRealAgentRunner } = await import('./real-agent-runner.js');
  const runner = createRealAgentRunner({
    baseUrl,
    oauthClientId: 'default-client',
    oauthClientSecret: oauthSecret,
  });

  process.stdout.write(`\nEval target: ${baseUrl}\n\n`);

  await waitForRateLimiter(runner);

  let summary: EvalSummary;

  if (isQuick) {
    summary = await runQuickEval({ runner });
  } else if (isResilience) {
    summary = await runResilienceOnlyEval({ runner });
  } else {
    summary = await runFullEval({ runner });
  }

  const report = formatReportTable(summary);
  process.stdout.write(report + '\n');

  if (writeReport) {
    writeReportToFile(summary, resolve(currentDir, '../../eval-report.json'));
  }

  if (isLangSmith) {
    await pushToLangSmith(summary);
  }

  const shouldFail = summary.toolAccuracyPct < TOOL_ACCURACY_THRESHOLD
    || summary.criticalFailures.length > 0;

  if (shouldFail) {
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1]?.endsWith('run-eval.ts')
  || process.argv[1]?.endsWith('run-eval.js');

if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Eval runner failed: ${message}\n`);
    process.exitCode = 1;
  });
}
