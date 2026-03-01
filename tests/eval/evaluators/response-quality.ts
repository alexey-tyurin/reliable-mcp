export interface QualityScores {
  accuracy: number;
  completeness: number;
  tone: number;
}

export interface QualityJudge {
  judge: (input: { query: string; toolResults: string; response: string }) => Promise<QualityScores>;
}

interface QualityInput {
  query: string;
  toolResults: string;
  response: string;
  judge: QualityJudge;
}

interface QualityResult {
  accuracy: number;
  completeness: number;
  tone: number;
  averageScore: number;
  flagged: boolean;
  flagReasons: string[];
}

const MINIMUM_ACCEPTABLE_SCORE = 3;

export async function evaluateResponseQuality(input: QualityInput): Promise<QualityResult> {
  const scores = await input.judge.judge({
    query: input.query,
    toolResults: input.toolResults,
    response: input.response,
  });

  const flagReasons: string[] = [];
  if (scores.accuracy < MINIMUM_ACCEPTABLE_SCORE) {
    flagReasons.push('accuracy');
  }
  if (scores.completeness < MINIMUM_ACCEPTABLE_SCORE) {
    flagReasons.push('completeness');
  }
  if (scores.tone < MINIMUM_ACCEPTABLE_SCORE) {
    flagReasons.push('tone');
  }

  const averageScore = Math.round((scores.accuracy + scores.completeness + scores.tone) / 3);

  return {
    accuracy: scores.accuracy,
    completeness: scores.completeness,
    tone: scores.tone,
    averageScore,
    flagged: flagReasons.length > 0,
    flagReasons,
  };
}
