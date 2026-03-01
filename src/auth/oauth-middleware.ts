import { jwtVerify, errors as joseErrors } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../observability/logger.js';

const logger = createLogger('oauth-middleware');

export interface AuthMiddlewareConfig {
  jwtSecret: string;
}

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (authHeader === undefined) {
    return undefined;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return undefined;
  }

  return parts[1];
}

export function createAuthMiddleware(config: AuthMiddlewareConfig): AuthMiddleware {
  const secret = new TextEncoder().encode(config.jwtSecret);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers['authorization'] as string | undefined;
    const token = extractBearerToken(authHeader);

    if (!token) {
      res.status(401).json({
        error: 'missing_token',
        message: 'Authorization header with Bearer token is required.',
      });
      return;
    }

    try {
      const { payload } = await jwtVerify(token, secret);

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        logger.warn({ hasSubject: false }, 'Token missing sub claim');
        res.status(401).json({
          error: 'invalid_token',
          message: 'Token is missing required claims.',
        });
        return;
      }

      (req as unknown as { userId: string }).userId = payload.sub;
      logger.info({ userId: payload.sub }, 'Request authenticated');
      next();
    } catch (error: unknown) {
      if (error instanceof joseErrors.JWTExpired) {
        logger.warn({ reason: 'expired' }, 'JWT verification failed');
        res.status(401).json({
          error: 'token_expired',
          message: 'Token has expired. Please obtain a new token.',
        });
        return;
      }

      logger.warn({ reason: 'invalid' }, 'JWT verification failed');
      res.status(401).json({
        error: 'invalid_token',
        message: 'Token is invalid or could not be verified.',
      });
    }
  };
}
