interface AgentInvokeResult {
  response: string;
  toolsCalled: string[];
  latencyMs: number;
  cacheHit: boolean;
  error?: string;
  statusCode: number;
  rawBody: Record<string, unknown>;
}

interface AgentRunner {
  invoke: (message: string, sessionId?: string) => Promise<AgentInvokeResult>;
}

interface RealAgentRunnerConfig {
  baseUrl: string;
  oauthClientId: string;
  oauthClientSecret: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface ChatResponse {
  response: string;
  toolsCalled?: string[];
}

interface ErrorResponse {
  error: string;
}

async function fetchAccessToken(baseUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth token request failed with status ${String(response.status)}`);
  }

  const body = await response.json() as TokenResponse;
  return body.access_token;
}

export function createRealAgentRunner(config: RealAgentRunnerConfig): AgentRunner {
  let cachedToken: string | null = null;
  let tokenExpiresAt = 0;

  async function getToken(): Promise<string> {
    const now = Date.now();
    const bufferMs = 60_000;

    if (cachedToken && now < tokenExpiresAt - bufferMs) {
      return cachedToken;
    }

    cachedToken = await fetchAccessToken(config.baseUrl, config.oauthClientId, config.oauthClientSecret);
    tokenExpiresAt = now + 3600_000;
    return cachedToken;
  }

  return {
    invoke: async (message: string, sessionId?: string): Promise<AgentInvokeResult> => {
      const token = await getToken();
      const evalSessionId = sessionId ?? `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const startTime = Date.now();

      const response = await fetch(`${config.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          message,
          sessionId: evalSessionId,
        }),
      });

      const latencyMs = Date.now() - startTime;
      const rawBody = await response.json() as Record<string, unknown>;

      if (!response.ok) {
        const errorBody = rawBody as unknown as ErrorResponse;
        return {
          response: errorBody.error ?? '',
          toolsCalled: [],
          latencyMs,
          cacheHit: false,
          error: errorBody.error,
          statusCode: response.status,
          rawBody,
        };
      }

      const chatBody = rawBody as unknown as ChatResponse;

      return {
        response: chatBody.response,
        toolsCalled: chatBody.toolsCalled ?? [],
        latencyMs,
        cacheHit: false,
        statusCode: response.status,
        rawBody,
      };
    },
  };
}
