import type { AgentState } from '../agent/state.js';
import { createLogger } from './logger.js';

const logger = createLogger('langsmith');

export interface LangSmithClientLike {
  createRun: (params: RunCreateParams) => Promise<void>;
  updateRun: (runId: string, params: RunUpdateParams) => Promise<void>;
}

interface RunCreateParams {
  name: string;
  id: string;
  run_type: string;
  inputs: Record<string, unknown>;
  extra?: Record<string, unknown>;
  tags?: string[];
  start_time: number;
}

interface RunUpdateParams {
  end_time: number;
  outputs?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  error?: string;
}

interface TraceOptions {
  cacheHit: boolean;
}

type InvokeFn = (input: AgentState) => Promise<AgentState>;
type TracedInvokeFn = (input: AgentState, options: TraceOptions) => Promise<AgentState>;

export function buildRunTags(userId: string, sessionId: string, cacheHit: boolean): string[] {
  return [
    `user:${userId}`,
    `session:${sessionId}`,
    cacheHit ? 'cache:hit' : 'cache:miss',
  ];
}

function buildResultTags(result: AgentState): string[] {
  const tags: string[] = [];

  for (const tr of result.toolResults) {
    tags.push(`tool:${tr.toolName}`);
  }

  if (result.error) {
    tags.push(`error:${result.error.code}`);
  }

  return tags;
}

function buildResultMetadata(
  input: AgentState,
  result: AgentState,
  cacheHit: boolean,
  latencyMs: number,
): Record<string, unknown> {
  return {
    user_id: input.userId,
    session_id: input.sessionId,
    cache_hit: cacheHit,
    tools_called: result.toolResults.map((tr) => tr.toolName),
    latency_ms: latencyMs,
    error: result.error?.code ?? null,
  };
}

export function createTracedInvoke(
  invoke: InvokeFn,
  client: LangSmithClientLike,
): TracedInvokeFn {
  return async function tracedInvoke(input: AgentState, options: TraceOptions): Promise<AgentState> {
    const runId = crypto.randomUUID();
    const startTime = Date.now();
    const tags = buildRunTags(input.userId, input.sessionId, options.cacheHit);

    try {
      await client.createRun({
        name: 'agent-run',
        id: runId,
        run_type: 'chain',
        inputs: { message: input.messages[input.messages.length - 1]?.content ?? '' },
        tags,
        start_time: startTime,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message }, 'Failed to create LangSmith run');
    }

    let result: AgentState;
    try {
      result = await invoke(input);
    } catch (error: unknown) {
      const endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : String(error);

      try {
        await client.updateRun(runId, {
          end_time: endTime,
          error: errorMessage,
        });
      } catch (updateError: unknown) {
        const msg = updateError instanceof Error ? updateError.message : String(updateError);
        logger.warn({ error: msg }, 'Failed to update LangSmith run on error');
      }

      throw error;
    }

    const endTime = Date.now();
    const latencyMs = endTime - startTime;
    const resultTags = buildResultTags(result);
    const metadata = buildResultMetadata(input, result, options.cacheHit, latencyMs);

    try {
      await client.updateRun(runId, {
        end_time: endTime,
        outputs: { response: result.messages[result.messages.length - 1]?.content ?? '' },
        extra: {
          metadata,
          tags: [...tags, ...resultTags],
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message }, 'Failed to update LangSmith run');
    }

    return result;
  };
}
