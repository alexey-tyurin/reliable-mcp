import type { Request, Response } from 'express';

interface HealthResponse {
  status: string;
  service: string;
  uptime: number;
}

export function createHealthHandler(
  serviceName: string,
): (req: Request, res: Response) => void {
  const startTime = Date.now();

  return (_req: Request, res: Response): void => {
    const uptimeSeconds = (Date.now() - startTime) / 1000;

    const body: HealthResponse = {
      status: 'ok',
      service: serviceName,
      uptime: uptimeSeconds,
    };

    res.status(200).json(body);
  };
}
