import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { z } from 'zod';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { createHealthHandler } from '../utils/health.js';
import { createTokenEndpoint } from '../auth/oauth-server.js';
import { createAuthMiddleware } from '../auth/oauth-middleware.js';
import { createRateLimiter } from '../resilience/rate-limiter.js';
import { RateLimitError } from '../utils/errors.js';
import { createLogger } from '../observability/logger.js';
import type { AgentState } from './state.js';

const logger = createLogger('agent-http');

const chatRequestSchema = z.object({
  message: z.string().min(1).max(1000),
  sessionId: z.string().min(1).max(100),
});

interface AuthenticatedRequest extends Request {
  userId: string;
}

interface AgentGraphLike {
  invoke: (input: AgentState) => Promise<AgentState>;
}

export interface AgentAppConfig {
  agentGraph: AgentGraphLike;
  oauthSecret: string;
  oauthClients: Map<string, string>;
  corsOrigins: string[];
  rateLimiterPoints: number;
  rateLimiterDuration: number;
}

function createRateLimiterMiddleware(
  checkLimit: (key: string) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authedReq = req as AuthenticatedRequest;
    const key = authedReq.userId;

    checkLimit(key)
      .then(() => { next(); })
      .catch((error: unknown) => {
        if (error instanceof RateLimitError) {
          res.status(429).json({
            error: 'Too many requests. Please try again later.',
            retryAfterSeconds: error.retryAfterSeconds,
          });
          return;
        }
        next(error);
      });
  };
}

function createChatHandler(
  agentGraph: AgentGraphLike,
): (req: Request, res: Response) => void {
  return (req: Request, res: Response): void => {
    const authedReq = req as AuthenticatedRequest;

    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid request. Both message and sessionId are required.',
      });
      return;
    }

    const { message, sessionId } = parsed.data;
    const userId = authedReq.userId;

    logger.info({ userId, sessionId }, 'Processing chat request');

    const humanMessage = new HumanMessage(message);
    const input: AgentState = {
      messages: [humanMessage],
      userId,
      sessionId,
      toolResults: [],
      error: null,
    };

    agentGraph.invoke(input)
      .then((result) => {
        const lastMessage = result.messages[result.messages.length - 1];
        const responseText = lastMessage instanceof AIMessage
          ? (typeof lastMessage.content === 'string' ? lastMessage.content : '')
          : '';

        logger.info({ userId, sessionId }, 'Chat request completed');

        res.status(200).json({ response: responseText });
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ userId, sessionId, error: errorMessage }, 'Agent invocation failed');

        res.status(500).json({
          error: 'Something went wrong processing your request. Please try again.',
        });
      });
  };
}

export async function createAgentApp(config: AgentAppConfig): Promise<express.Express> {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }));

  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', createHealthHandler('agent'));

  app.post('/oauth/token', createTokenEndpoint({
    jwtSecret: config.oauthSecret,
    clients: config.oauthClients,
  }));

  const authMiddleware = createAuthMiddleware({ jwtSecret: config.oauthSecret });

  const rateLimiter = new RateLimiterMemory({
    points: config.rateLimiterPoints,
    duration: config.rateLimiterDuration,
  });
  const checkLimit = createRateLimiter(rateLimiter);
  const rateLimiterMiddleware = createRateLimiterMiddleware(checkLimit);

  const chatMiddleware: express.RequestHandler[] = [];

  if (process.env['CHAOS_ENABLED'] === 'true' && process.env['NODE_ENV'] !== 'production') {
    const { chaosAuthMiddleware } = await import('../chaos/interceptors/auth-interceptor.js');
    chatMiddleware.push(chaosAuthMiddleware as express.RequestHandler);
  }

  chatMiddleware.push(
    authMiddleware as express.RequestHandler,
    rateLimiterMiddleware,
    createChatHandler(config.agentGraph),
  );

  app.post('/chat', ...chatMiddleware);

  if (process.env['CHAOS_ENABLED'] === 'true' && process.env['NODE_ENV'] !== 'production') {
    const { registerChaosEndpoint } = await import('../chaos/admin-endpoint.js');
    registerChaosEndpoint(app);
  }

  return app;
}
