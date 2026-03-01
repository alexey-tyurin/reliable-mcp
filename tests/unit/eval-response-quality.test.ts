import { describe, it, expect, vi } from 'vitest';
import { evaluateResponseQuality } from '../eval/evaluators/response-quality.js';
import type { QualityJudge } from '../eval/evaluators/response-quality.js';

function createMockJudge(scores: { accuracy: number; completeness: number; tone: number }): QualityJudge {
  return {
    judge: vi.fn().mockResolvedValue(scores),
  };
}

describe('Response Quality Evaluator', () => {
  it('returns parsed scores from LLM judge', async () => {
    const judge = createMockJudge({ accuracy: 5, completeness: 4, tone: 5 });

    const result = await evaluateResponseQuality({
      query: 'What is the weather in London?',
      toolResults: '{"city":"London","temperature":15}',
      response: 'The weather in London is 15°C.',
      judge,
    });

    expect(result.accuracy).toBe(5);
    expect(result.completeness).toBe(4);
    expect(result.tone).toBe(5);
    expect(result.flagged).toBe(false);
  });

  it('flags when any score is below 3', async () => {
    const judge = createMockJudge({ accuracy: 2, completeness: 4, tone: 5 });

    const result = await evaluateResponseQuality({
      query: 'What is the weather in London?',
      toolResults: '{"city":"London","temperature":15}',
      response: 'I dont know.',
      judge,
    });

    expect(result.flagged).toBe(true);
    expect(result.flagReasons).toContain('accuracy');
  });

  it('flags multiple low scores', async () => {
    const judge = createMockJudge({ accuracy: 1, completeness: 2, tone: 1 });

    const result = await evaluateResponseQuality({
      query: 'Flight status?',
      toolResults: '{}',
      response: 'Error.',
      judge,
    });

    expect(result.flagged).toBe(true);
    expect(result.flagReasons).toContain('accuracy');
    expect(result.flagReasons).toContain('completeness');
    expect(result.flagReasons).toContain('tone');
  });

  it('returns averageScore computed from all three dimensions', async () => {
    const judge = createMockJudge({ accuracy: 4, completeness: 3, tone: 5 });

    const result = await evaluateResponseQuality({
      query: 'Weather?',
      toolResults: '{}',
      response: 'The weather is nice.',
      judge,
    });

    expect(result.averageScore).toBe(4);
  });

  it('passes query and response to the judge', async () => {
    const judge = createMockJudge({ accuracy: 5, completeness: 5, tone: 5 });

    await evaluateResponseQuality({
      query: 'Weather in Paris?',
      toolResults: '{"temp":20}',
      response: 'It is 20°C in Paris.',
      judge,
    });

    expect(judge.judge).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Weather in Paris?',
        response: 'It is 20°C in Paris.',
      }),
    );
  });
});
