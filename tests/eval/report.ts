import { writeFileSync } from 'node:fs';

export interface CriticalFailure {
  testCase: string;
  reason: string;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  toolAccuracyPct: number;
  avgQualityScore: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  criticalFailures: CriticalFailure[];
}

const TOOL_ACCURACY_THRESHOLD = 90;

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

export function formatReportTable(summary: EvalSummary): string {
  const lines: string[] = [];
  const isPass = summary.toolAccuracyPct >= TOOL_ACCURACY_THRESHOLD
    && summary.criticalFailures.length === 0;

  lines.push('');
  lines.push('='.repeat(60));
  lines.push(`  EVALUATION REPORT — ${isPass ? 'PASS' : 'FAIL'}`);
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`  ${pad('Total test cases:', 30)} ${summary.total}`);
  lines.push(`  ${pad('Passed:', 30)} ${summary.passed}`);
  lines.push(`  ${pad('Failed:', 30)} ${summary.failed}`);
  lines.push(`  ${pad('Tool accuracy:', 30)} ${summary.toolAccuracyPct}%`);
  lines.push(`  ${pad('Avg quality score:', 30)} ${summary.avgQualityScore}`);
  lines.push(`  ${pad('Latency P50:', 30)} ${summary.latencyP50Ms}ms`);
  lines.push(`  ${pad('Latency P95:', 30)} ${summary.latencyP95Ms}ms`);
  lines.push('');

  if (summary.criticalFailures.length > 0) {
    lines.push('-'.repeat(60));
    lines.push('  CRITICAL FAILURES:');
    lines.push('-'.repeat(60));
    for (const failure of summary.criticalFailures) {
      lines.push(`  - ${failure.testCase}: ${failure.reason}`);
    }
    lines.push('');
  }

  lines.push('='.repeat(60));

  return lines.join('\n');
}

export function writeReportToFile(summary: EvalSummary, filePath: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is constructed internally from resolve(), not user input
  writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf-8');
}
