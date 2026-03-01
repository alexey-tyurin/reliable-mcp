import { describe, it, expect } from 'vitest';
import { loadDataset, computePercentiles, type ToolCallingTestCase } from '../eval/run-eval.js';

interface E2eFlowEntry {
  name: string;
  turns: { role: string; content: string }[];
}

interface EdgeCaseEntry {
  input: string;
  category: string;
}

describe('Eval Runner - Dataset Loading', () => {
  it('loads tool-calling dataset from JSON', () => {
    const dataset = loadDataset<ToolCallingTestCase>('tool-calling');

    expect(Array.isArray(dataset)).toBe(true);
    expect(dataset.length).toBeGreaterThanOrEqual(30);
  });

  it('each tool-calling entry has input and expected_tools', () => {
    const dataset = loadDataset<ToolCallingTestCase>('tool-calling');

    for (const entry of dataset) {
      expect(typeof entry.input).toBe('string');
      expect(Array.isArray(entry.expected_tools)).toBe(true);
    }
  });

  it('loads e2e-flows dataset from JSON', () => {
    const dataset = loadDataset<E2eFlowEntry>('e2e-flows');

    expect(Array.isArray(dataset)).toBe(true);
    expect(dataset.length).toBeGreaterThanOrEqual(15);
  });

  it('loads edge-cases dataset from JSON', () => {
    const dataset = loadDataset<EdgeCaseEntry>('edge-cases');

    expect(Array.isArray(dataset)).toBe(true);
    expect(dataset.length).toBeGreaterThanOrEqual(15);
  });
});

describe('Eval Runner - Percentile Computation', () => {
  it('computes p50 of sorted array', () => {
    const values = [100, 200, 300, 400, 500];
    expect(computePercentiles(values, 50)).toBe(300);
  });

  it('computes p95 of array', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
    expect(computePercentiles(values, 95)).toBe(950);
  });

  it('returns single value for single-element array', () => {
    expect(computePercentiles([42], 50)).toBe(42);
  });

  it('returns 0 for empty array', () => {
    expect(computePercentiles([], 50)).toBe(0);
  });
});
