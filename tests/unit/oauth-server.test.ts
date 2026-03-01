import { describe, it, expect } from 'vitest';
import { createTokenEndpoint } from '../../src/auth/oauth-server.js';
import * as jose from 'jose';

function createMockRequest(body: Record<string, unknown>) {
  return { body } as never;
}

function createMockResponse() {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return { json: (data: unknown) => { res.body = data; } };
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value; // eslint-disable-line security/detect-object-injection
    },
  };
  return res;
}

const TEST_SECRET = 'test-oauth-secret-at-least-32-chars-long!';
const TEST_CLIENTS = new Map<string, string>([
  ['valid-client', 'valid-secret'],
]);

describe('createTokenEndpoint', () => {
  it('returns JWT for valid client_credentials grant', async () => {
    const handler = createTokenEndpoint({
      jwtSecret: TEST_SECRET,
      clients: TEST_CLIENTS,
    });

    const req = createMockRequest({
      grant_type: 'client_credentials',
      client_id: 'valid-client',
      client_secret: 'valid-secret',
    });
    const res = createMockResponse();

    await handler(req, res as never);

    expect(res.statusCode).toBe(200);

    const responseBody = res.body as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };

    expect(responseBody.token_type).toBe('Bearer');
    expect(responseBody.expires_in).toBeGreaterThan(0);
    expect(typeof responseBody.access_token).toBe('string');

    // Verify the JWT is valid and contains expected claims
    const secret = new TextEncoder().encode(TEST_SECRET);
    const { payload } = await jose.jwtVerify(responseBody.access_token, secret);

    expect(payload.sub).toBe('valid-client');
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
  });

  it('rejects invalid client_id', async () => {
    const handler = createTokenEndpoint({
      jwtSecret: TEST_SECRET,
      clients: TEST_CLIENTS,
    });

    const req = createMockRequest({
      grant_type: 'client_credentials',
      client_id: 'unknown-client',
      client_secret: 'some-secret',
    });
    const res = createMockResponse();

    await handler(req, res as never);

    expect(res.statusCode).toBe(401);

    const responseBody = res.body as { error: string };
    expect(responseBody.error).toBe('invalid_client');
  });

  it('rejects wrong client_secret', async () => {
    const handler = createTokenEndpoint({
      jwtSecret: TEST_SECRET,
      clients: TEST_CLIENTS,
    });

    const req = createMockRequest({
      grant_type: 'client_credentials',
      client_id: 'valid-client',
      client_secret: 'wrong-secret',
    });
    const res = createMockResponse();

    await handler(req, res as never);

    expect(res.statusCode).toBe(401);

    const responseBody = res.body as { error: string };
    expect(responseBody.error).toBe('invalid_client');
  });

  it('rejects missing grant_type', async () => {
    const handler = createTokenEndpoint({
      jwtSecret: TEST_SECRET,
      clients: TEST_CLIENTS,
    });

    const req = createMockRequest({
      client_id: 'valid-client',
      client_secret: 'valid-secret',
    });
    const res = createMockResponse();

    await handler(req, res as never);

    expect(res.statusCode).toBe(400);

    const responseBody = res.body as { error: string };
    expect(responseBody.error).toBe('invalid_request');
  });

  it('rejects unsupported grant_type', async () => {
    const handler = createTokenEndpoint({
      jwtSecret: TEST_SECRET,
      clients: TEST_CLIENTS,
    });

    const req = createMockRequest({
      grant_type: 'authorization_code',
      client_id: 'valid-client',
      client_secret: 'valid-secret',
    });
    const res = createMockResponse();

    await handler(req, res as never);

    expect(res.statusCode).toBe(400);

    const responseBody = res.body as { error: string };
    expect(responseBody.error).toBe('unsupported_grant_type');
  });

  it('rejects missing client_id', async () => {
    const handler = createTokenEndpoint({
      jwtSecret: TEST_SECRET,
      clients: TEST_CLIENTS,
    });

    const req = createMockRequest({
      grant_type: 'client_credentials',
      client_secret: 'valid-secret',
    });
    const res = createMockResponse();

    await handler(req, res as never);

    expect(res.statusCode).toBe(400);

    const responseBody = res.body as { error: string };
    expect(responseBody.error).toBe('invalid_request');
  });

  it('rejects missing client_secret', async () => {
    const handler = createTokenEndpoint({
      jwtSecret: TEST_SECRET,
      clients: TEST_CLIENTS,
    });

    const req = createMockRequest({
      grant_type: 'client_credentials',
      client_id: 'valid-client',
    });
    const res = createMockResponse();

    await handler(req, res as never);

    expect(res.statusCode).toBe(400);

    const responseBody = res.body as { error: string };
    expect(responseBody.error).toBe('invalid_request');
  });

  it('sets Cache-Control no-store header', async () => {
    const handler = createTokenEndpoint({
      jwtSecret: TEST_SECRET,
      clients: TEST_CLIENTS,
    });

    const req = createMockRequest({
      grant_type: 'client_credentials',
      client_id: 'valid-client',
      client_secret: 'valid-secret',
    });
    const res = createMockResponse();

    await handler(req, res as never);

    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('uses custom token expiry when configured', async () => {
    const handler = createTokenEndpoint({
      jwtSecret: TEST_SECRET,
      clients: TEST_CLIENTS,
      tokenExpirySeconds: 600,
    });

    const req = createMockRequest({
      grant_type: 'client_credentials',
      client_id: 'valid-client',
      client_secret: 'valid-secret',
    });
    const res = createMockResponse();

    await handler(req, res as never);

    expect(res.statusCode).toBe(200);
    const responseBody = res.body as { expires_in: number };
    expect(responseBody.expires_in).toBe(600);
  });
});
