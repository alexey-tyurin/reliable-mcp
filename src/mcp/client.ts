import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCircuitBreaker } from '../resilience/circuit-breaker.js';
import { withRetry } from '../resilience/retry.js';
import { withTimeout } from '../resilience/timeout.js';
import { createLogger } from '../observability/logger.js';

interface McpClientLike {
  connect: (transport: unknown) => Promise<void>;
  close: () => Promise<void>;
  listTools: () => Promise<{ tools: McpToolDefinition[] }>;
  callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<McpCallResult>;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  toolName: string;
  content: string;
  isError: boolean;
}

interface McpCallResult {
  content: readonly { type: string; text?: string }[];
  isError?: boolean;
}

interface ServerConnection {
  name: string;
  url: string;
  client: McpClientLike;
  connected: boolean;
  tools: McpToolDefinition[];
}

export interface McpClientManagerConfig {
  weatherMcpUrl: string;
  flightMcpUrl: string;
  clientFactory?: (url: string) => McpClientLike;
}

export interface McpClientManager {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  callTool: (toolCall: McpToolCall) => Promise<McpToolResult>;
  listAllTools: () => Promise<McpToolDefinition[]>;
}

interface CallToolParams { name: string; arguments: Record<string, unknown> }

function createResilientCallTool(
  sdkClient: Client,
  url: string,
): (params: CallToolParams) => Promise<McpCallResult> {
  const rawCallTool = async (params: CallToolParams): Promise<McpCallResult> => {
    const result = await sdkClient.callTool({
      name: params.name,
      arguments: params.arguments,
    });
    return result as McpCallResult;
  };

  const withTimeoutFn = withTimeout(rawCallTool, 10000, `mcp-call-${url}`);
  const withRetryFn = withRetry(withTimeoutFn, { maxRetries: 1 });
  return createCircuitBreaker(withRetryFn, { name: `mcp-${url}` });
}

function extractTextContent(result: McpCallResult): string {
  const textItem = result.content.find((item) => item.type === 'text');
  return textItem?.text ?? '';
}

export function createMcpClientManager(
  config: McpClientManagerConfig,
): McpClientManager {
  const logger = createLogger('mcp-client');
  const servers: ServerConnection[] = [];

  function buildServers(): void {
    const entries: { name: string; url: string }[] = [
      { name: 'weather-mcp', url: config.weatherMcpUrl },
      { name: 'flight-mcp', url: config.flightMcpUrl },
    ];

    for (const entry of entries) {
      const client = config.clientFactory
        ? config.clientFactory(entry.url)
        : createDefaultClient(entry.url);

      servers.push({
        name: entry.name,
        url: entry.url,
        client,
        connected: false,
        tools: [],
      });
    }
  }

  function createDefaultClient(url: string): McpClientLike {
    const sdkClient = new Client({ name: 'agent-mcp-client', version: '1.0.0' });

    const wrappedCallTool = createResilientCallTool(sdkClient, url);

    return {
      connect: async (): Promise<void> => {
        const transport = new StreamableHTTPClientTransport(new URL(url));
        // @ts-expect-error -- StreamableHTTPClientTransport sessionId typing incompatible
        // with exactOptionalPropertyTypes. Safe at runtime.
        await sdkClient.connect(transport);
      },
      close: async (): Promise<void> => {
        await sdkClient.close();
      },
      listTools: async (): Promise<{ tools: McpToolDefinition[] }> => {
        const result = await sdkClient.listTools();
        return {
          tools: result.tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          })),
        };
      },
      callTool: wrappedCallTool,
    };
  }

  async function connectServer(server: ServerConnection): Promise<void> {
    try {
      await server.client.connect(server.url);
      server.connected = true;

      const { tools } = await server.client.listTools();
      server.tools = tools;

      logger.info({ url: server.url, toolCount: tools.length }, 'MCP server connected');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ url: server.url, error: message }, 'MCP server connection failed');
      server.connected = false;
    }
  }

  async function connect(): Promise<void> {
    if (servers.length === 0) {
      buildServers();
    }

    const connectionPromises = servers.map((server) => connectServer(server));
    await Promise.all(connectionPromises);

    const connectedCount = servers.filter((s) => s.connected).length;
    logger.info({ connectedCount, totalServers: servers.length }, 'MCP client connection complete');
  }

  async function disconnect(): Promise<void> {
    for (const server of servers) {
      if (server.connected) {
        try {
          await server.client.close();
          server.connected = false;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn({ url: server.url, error: message }, 'MCP server disconnect error');
        }
      }
    }
  }

  function findServerForTool(toolName: string): ServerConnection | undefined {
    return servers.find(
      (server) => server.connected && server.tools.some((t) => t.name === toolName),
    );
  }

  function isStaleSessionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Server not initialized') || message.includes('session');
  }

  async function reconnectServer(server: ServerConnection): Promise<boolean> {
    try {
      await server.client.close();
    } catch {
      // Ignore close errors during reconnection
    }

    try {
      await server.client.connect(server.url);
      server.connected = true;
      const { tools } = await server.client.listTools();
      server.tools = tools;
      logger.info({ url: server.url }, 'MCP server reconnected');
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ url: server.url, error: message }, 'MCP server reconnection failed');
      server.connected = false;
      return false;
    }
  }

  async function checkMcpChaos(serverName: string): Promise<void> {
    if (process.env['CHAOS_ENABLED'] !== 'true') return;

    const { ChaosController } = await import('../chaos/controller.js');
    const { isFaultTarget } = await import('../chaos/fault-types.js');
    const controller = ChaosController.getInstance();

    if (!isFaultTarget(serverName)) return;
    const fault = controller.getFault(serverName);

    if (!fault) return;

    if (fault.type === 'connection-refused') {
      throw new TypeError(`MCP server ${serverName} connection refused (chaos)`);
    }
    if (fault.type === 'error') {
      throw new Error(`MCP server ${serverName} error ${String(fault.statusCode)} (chaos)`);
    }
    if (fault.type === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, fault.hangMs));
      throw new Error(`MCP server ${serverName} timed out (chaos)`);
    }
  }

  async function callTool(toolCall: McpToolCall): Promise<McpToolResult> {
    const server = findServerForTool(toolCall.name);

    if (!server) {
      return {
        toolName: toolCall.name,
        content: `Tool '${toolCall.name}' is temporarily unavailable.`,
        isError: true,
      };
    }

    try {
      await checkMcpChaos(server.name);

      const result = await server.client.callTool({
        name: toolCall.name,
        arguments: toolCall.arguments,
      });

      return {
        toolName: toolCall.name,
        content: extractTextContent(result),
        isError: result.isError === true,
      };
    } catch (error: unknown) {
      if (isStaleSessionError(error)) {
        logger.info({ toolName: toolCall.name }, 'Stale session detected, reconnecting');
        const reconnected = await reconnectServer(server);
        if (reconnected) {
          try {
            const retryResult = await server.client.callTool({
              name: toolCall.name,
              arguments: toolCall.arguments,
            });
            return {
              toolName: toolCall.name,
              content: extractTextContent(retryResult),
              isError: retryResult.isError === true,
            };
          } catch (retryError: unknown) {
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
            logger.error({ toolName: toolCall.name, error: retryMessage }, 'MCP tool call failed after reconnect');
          }
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ toolName: toolCall.name, error: message }, 'MCP tool call failed');
      }

      return {
        toolName: toolCall.name,
        content: `Tool '${toolCall.name}' is temporarily unavailable. Try again in a few minutes.`,
        isError: true,
      };
    }
  }

  async function listAllTools(): Promise<McpToolDefinition[]> {
    const allTools: McpToolDefinition[] = [];
    for (const server of servers) {
      if (server.connected) {
        allTools.push(...server.tools);
      }
    }
    return allTools;
  }

  return { connect, disconnect, callTool, listAllTools };
}
