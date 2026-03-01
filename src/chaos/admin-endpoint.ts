import type { Express, Request, Response } from 'express';
import { assertChaosAllowed } from './guard.js';
import { ChaosController } from './controller.js';
import type { FaultTarget, FaultConfig } from './fault-types.js';
import { createLogger } from '../observability/logger.js';

const logger = createLogger('chaos-admin');

interface InjectBody {
  target: string;
  config: { type: string; [key: string]: unknown };
  durationMs?: number;
}

export function registerChaosEndpoint(app: Express): void {
  assertChaosAllowed();

  app.get('/chaos/status', (_req: Request, res: Response) => {
    try {
      const controller = ChaosController.getInstance();
      const faults = controller.getActiveFaults();
      res.json({ faults });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Chaos status failed');
      res.status(500).json({ error: 'Failed to get chaos status' });
    }
  });

  app.post('/chaos/inject', (req: Request, res: Response) => {
    try {
      const body = req.body as InjectBody;
      const controller = ChaosController.getInstance();
      const faultId = controller.inject(
        body.target as FaultTarget,
        body.config as FaultConfig,
        body.durationMs,
      );
      res.json({ faultId });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Chaos inject failed');
      res.status(500).json({ error: 'Failed to inject fault' });
    }
  });

  app.post('/chaos/clear', (req: Request, res: Response) => {
    try {
      const { faultId } = req.body as { faultId: string };
      const controller = ChaosController.getInstance();
      controller.clear(faultId);
      res.json({ cleared: faultId });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Chaos clear failed');
      res.status(500).json({ error: 'Failed to clear fault' });
    }
  });

  app.post('/chaos/clear-all', (_req: Request, res: Response) => {
    try {
      const controller = ChaosController.getInstance();
      controller.clearAll();
      res.json({ cleared: 'all' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Chaos clear-all failed');
      res.status(500).json({ error: 'Failed to clear all faults' });
    }
  });

  logger.info('Chaos admin endpoints registered at /chaos/*');
}
