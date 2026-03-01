interface AgentInvokeResult {
  response: string;
  toolsCalled: string[];
  latencyMs: number;
  cacheHit: boolean;
  statusCode: number;
  rawBody: Record<string, unknown>;
}

interface AgentRunner {
  invoke: (message: string, sessionId?: string) => Promise<AgentInvokeResult>;
}

const WEATHER_PATTERN = /weather|temperature|temp|cold|warm|hot|how.*is.*in/i;
const FLIGHT_PATTERN = /flight|status.*(?:of|for)\s+[A-Z]{2}\d|(?:TEST|BA|UA|DL|AA|LH|EK|QF)\d{2,}/i;
const FLIGHT_NUMBER_PATTERN = /\b(TEST\d{3}|[A-Z]{2}\d{2,4})\b/gi;
// eslint-disable-next-line security/detect-unsafe-regex -- bounded repetition on simple char class, not user-controlled
const CITY_PATTERN = /(?:in|for|at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/;

function extractFlightNumbers(input: string): string[] {
  const matches = input.match(FLIGHT_NUMBER_PATTERN);
  return matches ?? [];
}

function extractCity(input: string): string {
  const match = input.match(CITY_PATTERN);
  return match?.[1] ?? 'Unknown';
}

function simulateToolCalls(input: string): {
  toolsCalled: string[];
  response: string;
} {
  const wantsWeather = WEATHER_PATTERN.test(input);
  const wantsFlight = FLIGHT_PATTERN.test(input);
  const toolsCalled: string[] = [];
  const responseParts: string[] = [];

  if (wantsWeather) {
    toolsCalled.push('get_weather');
    const city = extractCity(input);
    responseParts.push(`The weather in ${city} is 15°C and partly cloudy.`);
  }

  if (wantsFlight) {
    toolsCalled.push('get_flight_status');
    const flights = extractFlightNumbers(input);
    const flightNum = flights[0] ?? 'Unknown';
    responseParts.push(`Flight ${flightNum} is on time and scheduled to arrive as planned.`);
  }

  if (toolsCalled.length === 0) {
    responseParts.push('I can help you check weather conditions and flight statuses. What would you like to know?');
  }

  return {
    toolsCalled,
    response: responseParts.join(' '),
  };
}

export function createMockAgentRunner(): AgentRunner {
  return {
    invoke: async (message: string): Promise<AgentInvokeResult> => {
      const startTime = Date.now();

      await new Promise((resolve) => {
        setTimeout(resolve, 10 + Math.random() * 50);
      });

      const { toolsCalled, response } = simulateToolCalls(message);
      const latencyMs = Date.now() - startTime;

      return {
        response,
        toolsCalled,
        latencyMs,
        cacheHit: false,
        statusCode: 200,
        rawBody: { response },
      };
    },
  };
}
