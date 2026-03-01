import { SignJWT } from 'jose';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '../observability/logger.js';

const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600;

const logger = createLogger('oauth-server');

const tokenRequestSchema = z.object({
  grant_type: z.string(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

export interface OAuthServerConfig {
  jwtSecret: string;
  clients: Map<string, string>;
  tokenExpirySeconds?: number;
}

type TokenHandler = (req: Request, res: Response) => Promise<void>;

export function createTokenEndpoint(config: OAuthServerConfig): TokenHandler {
  const expirySeconds = config.tokenExpirySeconds ?? DEFAULT_TOKEN_EXPIRY_SECONDS;
  const secret = new TextEncoder().encode(config.jwtSecret);

  return async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');

    const parsed = tokenRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const { grant_type, client_id, client_secret } = parsed.data;

    if (grant_type !== 'client_credentials') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    const storedSecret = config.clients.get(client_id);
    if (storedSecret === undefined || storedSecret !== client_secret) {
      logger.warn({ clientId: client_id }, 'Invalid client credentials');
      res.status(401).json({ error: 'invalid_client' });
      return;
    }

    try {
      const jwt = await new SignJWT({ sub: client_id })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(`${expirySeconds}s`)
        .sign(secret);

      logger.info({ clientId: client_id }, 'Token issued');

      res.status(200).json({
        access_token: jwt,
        token_type: 'Bearer',
        expires_in: expirySeconds,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Token signing failed');
      res.status(500).json({ error: 'server_error' });
    }
  };
}
