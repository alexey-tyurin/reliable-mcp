import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { ChaosController } from '../../src/chaos/controller.js';
import { chaosAuthMiddleware } from '../../src/chaos/interceptors/auth-interceptor.js';

function createMockReqRes() {
  const req = {} as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn();
  return { req, res, next };
}

describe('chaosAuthMiddleware', () => {
  let controller: ChaosController;

  beforeEach(() => {
    process.env['CHAOS_ENABLED'] = 'true';
    process.env['NODE_ENV'] = 'test';
    ChaosController.reset();
    controller = ChaosController.getInstance();
  });

  afterEach(() => {
    ChaosController.reset();
  });

  it('calls next when no fault is active', () => {
    const { req, res, next } = createMockReqRes();

    chaosAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  describe('error fault', () => {
    it('returns status code with error JSON', () => {
      const { req, res, next } = createMockReqRes();
      controller.inject('oauth-token', {
        type: 'error',
        statusCode: 401,
        message: 'Token expired',
      });

      chaosAuthMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'token_invalid',
        message: 'Token expired',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('uses default message when none provided', () => {
      const { req, res, next } = createMockReqRes();
      controller.inject('oauth-token', { type: 'error', statusCode: 403 });

      chaosAuthMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'token_invalid',
        message: 'Authentication failed (chaos)',
      });
    });
  });

  describe('latency fault', () => {
    it('delays then calls next', async () => {
      vi.useFakeTimers();
      const { req, res, next } = createMockReqRes();
      controller.inject('oauth-token', { type: 'latency', delayMs: 1000 });

      chaosAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1100);
      expect(next).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });
  });

  describe('timeout fault', () => {
    it('does not respond or call next (hangs)', () => {
      const { req, res, next } = createMockReqRes();
      controller.inject('oauth-token', { type: 'timeout', hangMs: 30000 });

      chaosAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  it('calls next for unsupported fault types', () => {
    const { req, res, next } = createMockReqRes();
    controller.inject('oauth-token', { type: 'connection-refused' });

    chaosAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
