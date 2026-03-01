import { describe, it, expect } from 'vitest';
import { evaluateLatencyBudget } from '../eval/evaluators/latency-budget.js';

describe('Latency Budget Evaluator', () => {
  it('passes for cache hit under 3s', () => {
    const result = evaluateLatencyBudget(2000, true, 'single');

    expect(result.pass).toBe(true);
    expect(result.actualMs).toBe(2000);
    expect(result.budgetMs).toBe(3000);
  });

  it('fails for cache hit over 3s', () => {
    const result = evaluateLatencyBudget(4000, true, 'single');

    expect(result.pass).toBe(false);
    expect(result.actualMs).toBe(4000);
    expect(result.budgetMs).toBe(3000);
  });

  it('passes for single tool call under 8s', () => {
    const result = evaluateLatencyBudget(7000, false, 'single');

    expect(result.pass).toBe(true);
    expect(result.budgetMs).toBe(8000);
  });

  it('fails for single tool call over 8s', () => {
    const result = evaluateLatencyBudget(9000, false, 'single');

    expect(result.pass).toBe(false);
    expect(result.budgetMs).toBe(8000);
  });

  it('passes for combined tool call under 12s', () => {
    const result = evaluateLatencyBudget(11000, false, 'combined');

    expect(result.pass).toBe(true);
    expect(result.budgetMs).toBe(12000);
  });

  it('fails for combined tool call over 12s', () => {
    const result = evaluateLatencyBudget(13000, false, 'combined');

    expect(result.pass).toBe(false);
    expect(result.budgetMs).toBe(12000);
  });

  it('always fails above absolute max of 15s', () => {
    const result = evaluateLatencyBudget(16000, false, 'single');

    expect(result.pass).toBe(false);
    expect(result.budgetMs).toBe(15000);
  });

  it('passes for no-tool call under 8s', () => {
    const result = evaluateLatencyBudget(5000, false, 'none');

    expect(result.pass).toBe(true);
    expect(result.budgetMs).toBe(8000);
  });
});
