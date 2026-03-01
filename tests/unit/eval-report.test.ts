import { describe, it, expect } from 'vitest';
import { formatReportTable, type EvalSummary } from '../eval/report.js';

function createBaseSummary(overrides?: Partial<EvalSummary>): EvalSummary {
  return {
    total: 30,
    passed: 28,
    failed: 2,
    toolAccuracyPct: 93.3,
    avgQualityScore: 4.2,
    latencyP50Ms: 1500,
    latencyP95Ms: 7000,
    criticalFailures: [],
    ...overrides,
  };
}

describe('Eval Report', () => {
  it('formats summary as a table string', () => {
    const summary = createBaseSummary();
    const output = formatReportTable(summary);

    expect(output).toContain('30');
    expect(output).toContain('28');
    expect(output).toContain('93.3');
    expect(output).toContain('4.2');
    expect(output).toContain('1500');
    expect(output).toContain('7000');
  });

  it('includes critical failures in output when present', () => {
    const summary = createBaseSummary({
      criticalFailures: [
        { testCase: 'prompt-injection-1', reason: 'Stack trace leaked' },
      ],
    });
    const output = formatReportTable(summary);

    expect(output).toContain('prompt-injection-1');
    expect(output).toContain('Stack trace leaked');
  });

  it('shows PASS when no critical failures and accuracy above threshold', () => {
    const summary = createBaseSummary();
    const output = formatReportTable(summary);

    expect(output).toContain('PASS');
  });

  it('shows FAIL when tool accuracy below 90%', () => {
    const summary = createBaseSummary({ toolAccuracyPct: 85.0 });
    const output = formatReportTable(summary);

    expect(output).toContain('FAIL');
  });

  it('shows FAIL when critical failures exist', () => {
    const summary = createBaseSummary({
      criticalFailures: [{ testCase: 'edge-1', reason: 'Crash' }],
    });
    const output = formatReportTable(summary);

    expect(output).toContain('FAIL');
  });
});
