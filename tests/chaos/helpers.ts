import { ChaosController } from '../../src/chaos/controller.js';

interface ChatResponse {
  status: number;
  body: Record<string, unknown>;
  latencyMs: number;
}

let agentBaseUrl = '';
let testToken = '';

export function setAgentBaseUrl(url: string): void {
  agentBaseUrl = url;
}

export function setTestToken(token: string): void {
  testToken = token;
}

export async function sendChatRequest(query: string, sessionId = 'chaos-test'): Promise<ChatResponse> {
  const start = Date.now();
  const response = await fetch(`${agentBaseUrl}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testToken}`,
    },
    body: JSON.stringify({ message: query, sessionId }),
  });

  const body = await response.json() as Record<string, unknown>;

  return {
    status: response.status,
    body,
    latencyMs: Date.now() - start,
  };
}

export function setupChaos(): ChaosController {
  process.env['CHAOS_ENABLED'] = 'true';
  process.env['NODE_ENV'] = 'test';
  ChaosController.reset();
  return ChaosController.getInstance();
}

export function teardownChaos(): void {
  ChaosController.reset();
}

export function assertNoStackTrace(response: ChatResponse): void {
  const bodyString = JSON.stringify(response.body);
  const stackTracePattern = /at\s+\w+\s+\(.*:\d+:\d+\)/;
  if (stackTracePattern.test(bodyString)) {
    throw new Error(`Stack trace found in response: ${bodyString}`);
  }
}
