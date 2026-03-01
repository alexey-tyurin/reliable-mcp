import { describe, it, expect } from 'vitest';
import { createAuthMiddleware } from '../../src/auth/oauth-middleware.js';
import { SignJWT } from 'jose';

const TEST_SECRET = 'test-oauth-secret-at-least-32-chars-long!';
const secret = new TextEncoder().encode(TEST_SECRET);

async function signToken(
  claims: Record<string, unknown>,
  expiresIn = '1h',
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

function createMockRequest(authHeader?: string) {
  return {
    headers: authHeader !== undefined
      ? { authorization: authHeader }
      : {},
  } as never;
}

function createMockResponse() {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return { json: (data: unknown) => { res.body = data; } };
    },
  };
  return res;
}

describe('createAuthMiddleware', () => {
  it('passes valid JWT and attaches userId to request', async () => {
    const middleware = createAuthMiddleware({ jwtSecret: TEST_SECRET });

    const token = await signToken({ sub: 'user-123' });
    const req = createMockRequest(`Bearer ${token}`);
    const res = createMockResponse();
    let nextCalled = false;

    await middleware(req, res as never, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect((req as unknown as { userId: string }).userId).toBe('user-123');
  });

  it('returns 401 for expired JWT with clear message', async () => {
    const middleware = createAuthMiddleware({ jwtSecret: TEST_SECRET });

    const token = await signToken({ sub: 'user-123' }, '0s');
    // Wait a tiny bit to ensure the token is expired
    await new Promise((resolve) => setTimeout(resolve, 10));

    const req = createMockRequest(`Bearer ${token}`);
    const res = createMockResponse();
    let nextCalled = false;

    await middleware(req, res as never, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);

    const body = res.body as { error: string; message: string };
    expect(body.error).toBe('token_expired');
    expect(body.message).toBeDefined();
    expect(typeof body.message).toBe('string');
  });

  it('returns 401 for malformed token', async () => {
    const middleware = createAuthMiddleware({ jwtSecret: TEST_SECRET });

    const req = createMockRequest('Bearer not-a-valid-jwt');
    const res = createMockResponse();
    let nextCalled = false;

    await middleware(req, res as never, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);

    const body = res.body as { error: string };
    expect(body.error).toBe('invalid_token');
  });

  it('returns 401 for missing Authorization header', async () => {
    const middleware = createAuthMiddleware({ jwtSecret: TEST_SECRET });

    const req = createMockRequest();
    const res = createMockResponse();
    let nextCalled = false;

    await middleware(req, res as never, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);

    const body = res.body as { error: string };
    expect(body.error).toBe('missing_token');
  });

  it('returns 401 for non-Bearer scheme', async () => {
    const middleware = createAuthMiddleware({ jwtSecret: TEST_SECRET });

    const req = createMockRequest('Basic dXNlcjpwYXNz');
    const res = createMockResponse();
    let nextCalled = false;

    await middleware(req, res as never, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);

    const body = res.body as { error: string };
    expect(body.error).toBe('missing_token');
  });

  it('returns 401 for token signed with different secret', async () => {
    const middleware = createAuthMiddleware({ jwtSecret: TEST_SECRET });

    const wrongSecret = new TextEncoder().encode('wrong-secret-that-is-long-enough!');
    const token = await new SignJWT({ sub: 'user-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(wrongSecret);

    const req = createMockRequest(`Bearer ${token}`);
    const res = createMockResponse();
    let nextCalled = false;

    await middleware(req, res as never, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);

    const body = res.body as { error: string };
    expect(body.error).toBe('invalid_token');
  });

  it('returns 401 for token missing sub claim', async () => {
    const middleware = createAuthMiddleware({ jwtSecret: TEST_SECRET });

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);

    const req = createMockRequest(`Bearer ${token}`);
    const res = createMockResponse();
    let nextCalled = false;

    await middleware(req, res as never, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);

    const body = res.body as { error: string };
    expect(body.error).toBe('invalid_token');
  });
});
