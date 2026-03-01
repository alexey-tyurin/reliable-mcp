import { ChaosController } from '../controller.js';
import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../../observability/logger.js';

const logger = createLogger('chaos-auth');

export function chaosAuthMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const controller = ChaosController.getInstance();
  const fault = controller.getFault('oauth-token');

  if (!fault) {
    next();
    return;
  }

  logger.debug({ faultType: fault.type }, 'Chaos auth fault triggered');

  switch (fault.type) {
    case 'error':
      res.status(fault.statusCode).json({
        error: 'token_invalid',
        message: fault.message ?? 'Authentication failed (chaos)',
      });
      return;
    case 'latency':
      setTimeout(() => { next(); }, fault.delayMs);
      return;
    case 'timeout':
      // Don't respond — let the request hang until client timeout
      return;
    default:
      next();
  }
}
