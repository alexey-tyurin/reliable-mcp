interface ToolSelectionResult {
  score: 1.0 | 0.5 | 0.0;
  reason: string;
}

export function evaluateToolSelection(
  actualTools: string[],
  expectedTools: string[],
): ToolSelectionResult {
  const actualSet = new Set(actualTools);
  const expectedSet = new Set(expectedTools);

  if (actualSet.size === 0 && expectedSet.size === 0) {
    return { score: 1.0, reason: 'No tools expected or called — exact match' };
  }

  if (expectedSet.size === 0 && actualSet.size > 0) {
    return { score: 0.0, reason: `No tools expected but called: ${[...actualSet].join(', ')}` };
  }

  const allExpectedPresent = [...expectedSet].every((t) => actualSet.has(t));

  if (!allExpectedPresent) {
    const missing = [...expectedSet].filter((t) => !actualSet.has(t));
    return { score: 0.0, reason: `Tools missing: ${missing.join(', ')}` };
  }

  const extraTools = [...actualSet].filter((t) => !expectedSet.has(t));
  if (extraTools.length > 0) {
    return { score: 0.5, reason: `Correct tools called but extra: ${extraTools.join(', ')}` };
  }

  return { score: 1.0, reason: 'Tools exact match' };
}
