type CallType = 'none' | 'single' | 'combined';

interface LatencyResult {
  pass: boolean;
  actualMs: number;
  budgetMs: number;
}

const CACHE_HIT_BUDGET_MS = 3000;
const SINGLE_TOOL_BUDGET_MS = 8000;
const COMBINED_TOOL_BUDGET_MS = 12000;
const ABSOLUTE_MAX_MS = 15000;

export function evaluateLatencyBudget(
  actualMs: number,
  cacheHit: boolean,
  callType: CallType,
): LatencyResult {
  if (actualMs > ABSOLUTE_MAX_MS) {
    return { pass: false, actualMs, budgetMs: ABSOLUTE_MAX_MS };
  }

  if (cacheHit) {
    return {
      pass: actualMs <= CACHE_HIT_BUDGET_MS,
      actualMs,
      budgetMs: CACHE_HIT_BUDGET_MS,
    };
  }

  const budgetMs = callType === 'combined' ? COMBINED_TOOL_BUDGET_MS : SINGLE_TOOL_BUDGET_MS;

  return {
    pass: actualMs <= budgetMs,
    actualMs,
    budgetMs,
  };
}
