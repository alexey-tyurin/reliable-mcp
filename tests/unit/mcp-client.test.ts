import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpToolCall } from '../../src/mcp/client.js';

function createMockMcpClient(): {
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
} {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: {} }],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"city":"London","temperature":15}' }],
      isError: false,
    }),
  };
}

describe('McpClientManager', () => {
  let createMcpClientManager: typeof import('../../src/mcp/client.js').createMcpClientManager;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/mcp/client.js');
    createMcpClientManager = mod.createMcpClientManager;
  });

  describe('createMcpClientManager', () => {
    it('creates a manager with weather and flight server URLs', () => {
      const manager = createMcpClientManager({
        weatherMcpUrl: 'http://localhost:3001/mcp',
        flightMcpUrl: 'http://localhost:3002/mcp',
      });

      expect(manager).toBeDefined();
      expect(typeof manager.connect).toBe('function');
      expect(typeof manager.disconnect).toBe('function');
      expect(typeof manager.callTool).toBe('function');
      expect(typeof manager.listAllTools).toBe('function');
    });
  });

  describe('listAllTools', () => {
    it('returns tools from both servers when both connected', async () => {
      const weatherClient = createMockMcpClient();
      weatherClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: {} }],
      });

      const flightClient = createMockMcpClient();
      flightClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_flight_status', description: 'Get flight status', inputSchema: {} }],
      });

      const manager = createMcpClientManager({
        weatherMcpUrl: 'http://localhost:3001/mcp',
        flightMcpUrl: 'http://localhost:3002/mcp',
        clientFactory: (url: string) => {
          if (url.includes('3001')) return weatherClient;
          return flightClient;
        },
      });

      await manager.connect();
      const tools = await manager.listAllTools();

      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toContain('get_weather');
      expect(tools.map((t) => t.name)).toContain('get_flight_status');
    });

    it('returns tools from available server when one is down', async () => {
      const weatherClient = createMockMcpClient();
      weatherClient.connect.mockRejectedValue(new Error('Connection refused'));

      const flightClient = createMockMcpClient();
      flightClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_flight_status', description: 'Get flight', inputSchema: {} }],
      });

      const manager = createMcpClientManager({
        weatherMcpUrl: 'http://localhost:3001/mcp',
        flightMcpUrl: 'http://localhost:3002/mcp',
        clientFactory: (url: string) => {
          if (url.includes('3001')) return weatherClient;
          return flightClient;
        },
      });

      await manager.connect();
      const tools = await manager.listAllTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('get_flight_status');
    });
  });

  describe('callTool', () => {
    it('routes tool call to the correct server', async () => {
      const weatherClient = createMockMcpClient();
      weatherClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: {} }],
      });
      weatherClient.callTool.mockResolvedValue({
        content: [{ type: 'text', text: '{"city":"London","temperature":15}' }],
        isError: false,
      });

      const flightClient = createMockMcpClient();
      flightClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_flight_status', description: 'Get flight', inputSchema: {} }],
      });

      const manager = createMcpClientManager({
        weatherMcpUrl: 'http://localhost:3001/mcp',
        flightMcpUrl: 'http://localhost:3002/mcp',
        clientFactory: (url: string) => {
          if (url.includes('3001')) return weatherClient;
          return flightClient;
        },
      });

      await manager.connect();

      const toolCall: McpToolCall = { name: 'get_weather', arguments: { city: 'London' } };
      const result = await manager.callTool(toolCall);

      expect(result.content).toBe('{"city":"London","temperature":15}');
      expect(result.isError).toBe(false);
      expect(weatherClient.callTool).toHaveBeenCalledWith({
        name: 'get_weather',
        arguments: { city: 'London' },
      });
    });

    it('returns error result when tool server is unavailable', async () => {
      const weatherClient = createMockMcpClient();
      weatherClient.connect.mockRejectedValue(new Error('Connection refused'));

      const flightClient = createMockMcpClient();
      flightClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_flight_status', description: 'Get flight', inputSchema: {} }],
      });

      const manager = createMcpClientManager({
        weatherMcpUrl: 'http://localhost:3001/mcp',
        flightMcpUrl: 'http://localhost:3002/mcp',
        clientFactory: (url: string) => {
          if (url.includes('3001')) return weatherClient;
          return flightClient;
        },
      });

      await manager.connect();

      const toolCall: McpToolCall = { name: 'get_weather', arguments: { city: 'London' } };
      const result = await manager.callTool(toolCall);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('temporarily unavailable');
    });

    it('returns error result for unknown tool name', async () => {
      const weatherClient = createMockMcpClient();
      weatherClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: {} }],
      });

      const flightClient = createMockMcpClient();
      flightClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_flight_status', description: 'Get flight', inputSchema: {} }],
      });

      const manager = createMcpClientManager({
        weatherMcpUrl: 'http://localhost:3001/mcp',
        flightMcpUrl: 'http://localhost:3002/mcp',
        clientFactory: (url: string) => {
          if (url.includes('3001')) return weatherClient;
          return flightClient;
        },
      });

      await manager.connect();

      const toolCall: McpToolCall = { name: 'unknown_tool', arguments: {} };
      const result = await manager.callTool(toolCall);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('unknown_tool');
    });

    it('handles tool call failure gracefully', async () => {
      const weatherClient = createMockMcpClient();
      weatherClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: {} }],
      });
      weatherClient.callTool.mockRejectedValue(new Error('MCP call failed'));

      const flightClient = createMockMcpClient();
      flightClient.listTools.mockResolvedValue({
        tools: [{ name: 'get_flight_status', description: 'Get flight', inputSchema: {} }],
      });

      const manager = createMcpClientManager({
        weatherMcpUrl: 'http://localhost:3001/mcp',
        flightMcpUrl: 'http://localhost:3002/mcp',
        clientFactory: (url: string) => {
          if (url.includes('3001')) return weatherClient;
          return flightClient;
        },
      });

      await manager.connect();

      const toolCall: McpToolCall = { name: 'get_weather', arguments: { city: 'London' } };
      const result = await manager.callTool(toolCall);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('temporarily unavailable');
    });
  });

  describe('disconnect', () => {
    it('closes all connected clients', async () => {
      const weatherClient = createMockMcpClient();
      weatherClient.listTools.mockResolvedValue({ tools: [] });

      const flightClient = createMockMcpClient();
      flightClient.listTools.mockResolvedValue({ tools: [] });

      const manager = createMcpClientManager({
        weatherMcpUrl: 'http://localhost:3001/mcp',
        flightMcpUrl: 'http://localhost:3002/mcp',
        clientFactory: (url: string) => {
          if (url.includes('3001')) return weatherClient;
          return flightClient;
        },
      });

      await manager.connect();
      await manager.disconnect();

      expect(weatherClient.close).toHaveBeenCalled();
      expect(flightClient.close).toHaveBeenCalled();
    });

    it('handles disconnect errors gracefully', async () => {
      const weatherClient = createMockMcpClient();
      weatherClient.listTools.mockResolvedValue({ tools: [] });
      weatherClient.close.mockRejectedValue(new Error('Close failed'));

      const flightClient = createMockMcpClient();
      flightClient.listTools.mockResolvedValue({ tools: [] });

      const manager = createMcpClientManager({
        weatherMcpUrl: 'http://localhost:3001/mcp',
        flightMcpUrl: 'http://localhost:3002/mcp',
        clientFactory: (url: string) => {
          if (url.includes('3001')) return weatherClient;
          return flightClient;
        },
      });

      await manager.connect();
      await expect(manager.disconnect()).resolves.toBeUndefined();
    });
  });
});
