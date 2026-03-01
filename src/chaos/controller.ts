import { assertChaosAllowed } from './guard.js';
import type { FaultConfig, FaultTarget } from './fault-types.js';
import { createLogger } from '../observability/logger.js';

interface ActiveFault {
  target: FaultTarget;
  config: FaultConfig;
  activatedAt: number;
  expiresAt: number | null;
  requestCount: number;
}

const logger = createLogger('chaos-controller');

export class ChaosController {
  private faults = new Map<string, ActiveFault>();
  private static instance: ChaosController | null = null;

  constructor() {
    assertChaosAllowed();
  }

  static getInstance(): ChaosController {
    if (!ChaosController.instance) {
      ChaosController.instance = new ChaosController();
    }
    return ChaosController.instance;
  }

  inject(target: FaultTarget, config: FaultConfig, durationMs?: number): string {
    const id = `${target}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.faults.set(id, {
      target,
      config,
      activatedAt: Date.now(),
      expiresAt: durationMs !== undefined ? Date.now() + durationMs : null,
      requestCount: 0,
    });
    logger.warn({ faultId: id, target, faultType: config.type }, 'Chaos fault injected');
    return id;
  }

  clear(faultId: string): void {
    this.faults.delete(faultId);
    logger.info({ faultId }, 'Chaos fault cleared');
  }

  clearAll(): void {
    this.faults.clear();
    logger.info('All chaos faults cleared');
  }

  getFault(target: FaultTarget): FaultConfig | null {
    for (const [id, fault] of this.faults) {
      if (fault.target !== target) continue;

      if (fault.expiresAt !== null && Date.now() > fault.expiresAt) {
        this.faults.delete(id);
        logger.info({ faultId: id }, 'Chaos fault expired');
        continue;
      }

      if (fault.config.probability !== undefined && Math.random() > fault.config.probability) {
        continue;
      }

      fault.requestCount++;
      return fault.config;
    }
    return null;
  }

  getActiveFaults(): readonly {
    id: string;
    target: FaultTarget;
    type: string;
    requestCount: number;
  }[] {
    return Array.from(this.faults.entries()).map(([id, f]) => ({
      id,
      target: f.target,
      type: f.config.type,
      requestCount: f.requestCount,
    }));
  }

  static reset(): void {
    if (ChaosController.instance) {
      ChaosController.instance.clearAll();
    }
    ChaosController.instance = null;
  }
}
