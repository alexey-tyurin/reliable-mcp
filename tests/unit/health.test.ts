import { describe, it, expect } from 'vitest';
import { createHealthHandler } from '../../src/utils/health.js';

function createMockResponse(): {
  statusCode: number | undefined;
  body: unknown;
  status: (code: number) => { json: (data: unknown) => void };
  json: (data: unknown) => void;
} {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return { json: (data: unknown) => { res.body = data; } };
    },
    json(data: unknown) {
      res.body = data;
    },
  };
  return res;
}

describe('createHealthHandler', () => {
  it('returns status ok with service name', () => {
    const handler = createHealthHandler('weather-mcp');
    const req = {};
    const res = createMockResponse();

    handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'weather-mcp',
    });
  });

  it('includes uptime as a number', () => {
    const handler = createHealthHandler('agent');
    const req = {};
    const res = createMockResponse();

    handler(req as never, res as never);

    const body = res.body as { uptime: number };
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('works with different service names', () => {
    const handler = createHealthHandler('flight-mcp');
    const req = {};
    const res = createMockResponse();

    handler(req as never, res as never);

    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'flight-mcp',
    });
  });
});
