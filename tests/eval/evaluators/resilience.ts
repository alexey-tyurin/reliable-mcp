interface ResilienceInput {
  responseBody: Record<string, unknown>;
  statusCode: number;
  faultType: string;
}

interface ResilienceResult {
  pass: boolean;
  hasUserFriendlyMessage: boolean;
  hasStackTrace: boolean;
  hasPartialResults: boolean;
  faultType: string;
}

const STACK_TRACE_PATTERN = /at\s+[\w.<>]+\s*\(.*:\d+:\d+\)/;

const FRIENDLY_MESSAGE_PATTERNS = [
  /temporarily unavailable/i,
  /try again/i,
  /please try again/i,
  /something went wrong/i,
  /too many requests/i,
  /couldn'?t understand/i,
  /could you rephrase/i,
];

function containsStackTrace(body: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(body);
  return STACK_TRACE_PATTERN.test(serialized);
}

function containsFriendlyMessage(body: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(body);
  return FRIENDLY_MESSAGE_PATTERNS.some((pattern) => pattern.test(serialized));
}

function containsPartialResults(body: Record<string, unknown>): boolean {
  const responseText = typeof body['response'] === 'string' ? body['response'] : '';
  if (responseText.length === 0) {
    return false;
  }

  const hasPositiveContent = /\d+°?[CF]?|\bweather\b|\bflight\b|\blanded\b|\bon.time\b/i.test(responseText);
  const hasErrorContent = /unavailable|error|failed/i.test(responseText);

  return hasPositiveContent && hasErrorContent;
}

export function evaluateResilience(input: ResilienceInput): ResilienceResult {
  const hasStackTrace = containsStackTrace(input.responseBody);
  const hasUserFriendlyMessage = containsFriendlyMessage(input.responseBody);
  const hasPartialResults = containsPartialResults(input.responseBody);

  const hasContent = Object.keys(input.responseBody).length > 0;
  const pass = hasContent && !hasStackTrace && hasUserFriendlyMessage;

  return {
    pass,
    hasUserFriendlyMessage,
    hasStackTrace,
    hasPartialResults,
    faultType: input.faultType,
  };
}
