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

async function runToolCallingEval(
  dataset: ToolCallingTestCase[],
  runner: AgentRunner,
): Promise<{
  results: { input: string; score: number; reason: string; latencyMs: number }[];
  criticalFailures: CriticalFailure[];
}> {
  const results: { input: string; score: number; reason: string; latencyMs: number }[] = [];
  const criticalFailures: CriticalFailure[] = [];

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

      if (!latencyResult.pass) {
        criticalFailures.push({
          testCase: testCase.input.slice(0, 60),
          reason: `Latency ${latencyResult.actualMs}ms exceeded budget ${latencyResult.budgetMs}ms`,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ input: testCase.input, score: 0, reason: `Error: ${message}`, latencyMs: 0 });
      criticalFailures.push({
        testCase: testCase.input.slice(0, 60),
        reason: `Execution error: ${message}`,
      });
    }
  }

  return { results, criticalFailures };
}

async function runEdgeCaseEval(
  dataset: EdgeCaseTestCase[],
  runner: AgentRunner,
): Promise<{ criticalFailures: CriticalFailure[] }> {
  const criticalFailures: CriticalFailure[] = [];

  for (const testCase of dataset) {
    const input = expandLongInput(testCase.input);

    if (testCase.assertions.should_handle_gracefully && input.length === 0) {
      continue;
    }

    try {
      const agentResult = await runner.invoke(input);
      const bodyString = JSON.stringify(agentResult.rawBody);

      if (testCase.assertions.no_stack_trace) {
        const stackPattern = /at\s+\w+\s*\(.*:\d+:\d+\)/;
        if (stackPattern.test(bodyString)) {
          criticalFailures.push({
            testCase: `edge:${testCase.category}`,
            reason: 'Stack trace leaked in response',
          });
        }
      }

      if (testCase.assertions.should_not_contain) {
        for (const forbidden of testCase.assertions.should_not_contain) {
          if (bodyString.toLowerCase().includes(forbidden.toLowerCase())) {
            criticalFailures.push({
              testCase: `edge:${testCase.category}`,
              reason: `Response contains forbidden content: "${forbidden}"`,
            });
          }
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      criticalFailures.push({
        testCase: `edge:${testCase.category}`,
        reason: `Execution error: ${message}`,
      });
    }
  }

  return { criticalFailures };
}

async function runResilienceEval(
  runner: AgentRunner,
): Promise<{ criticalFailures: CriticalFailure[] }> {
  const criticalFailures: CriticalFailure[] = [];

  const scenarioInputs = [
    'What is the weather in London?',
    'Check flight TEST001',
    'Weather in Paris and status of TEST002',
  ];

  for (const input of scenarioInputs) {
    try {
      const agentResult = await runner.invoke(input);
      const resilienceResult = evaluateResilience({
        responseBody: agentResult.rawBody,
        statusCode: agentResult.statusCode,
        faultType: 'resilience-eval',
      });

      if (resilienceResult.hasStackTrace) {
        criticalFailures.push({
          testCase: `resilience:${input.slice(0, 40)}`,
          reason: 'Stack trace leaked',
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      criticalFailures.push({
        testCase: `resilience:${input.slice(0, 40)}`,
        reason: `Execution error: ${message}`,
      });
    }
  }

  return { criticalFailures };
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

  return {
    total: 3,
    passed: 3 - resilienceResult.criticalFailures.length,
    failed: resilienceResult.criticalFailures.length,
    toolAccuracyPct: 100,
    avgQualityScore: 0,
    latencyP50Ms: 0,
    latencyP95Ms: 0,
    criticalFailures: resilienceResult.criticalFailures,
  };
}

const TOOL_ACCURACY_THRESHOLD = 90;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isQuick = args.includes('--quick');
  const isResilience = args.includes('--resilience');
  const writeReport = args.includes('--report');

  process.env['FLIGHT_PROVIDER'] = process.env['FLIGHT_PROVIDER'] ?? 'mock';

  const { createMockAgentRunner } = await import('./mock-agent-runner.js');
  const runner = createMockAgentRunner();

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
