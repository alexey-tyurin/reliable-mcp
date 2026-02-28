import { z } from 'zod';

const SERVICE_ROLES = ['agent', 'weather-mcp', 'flight-mcp'] as const;
type ServiceRole = (typeof SERVICE_ROLES)[number];

const PORT_DEFAULTS: Record<ServiceRole, number> = {
  agent: 3000,
  'weather-mcp': 3001,
  'flight-mcp': 3002,
};

const baseSchema = z.object({
  SERVICE_ROLE: z.enum(SERVICE_ROLES),
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

const agentSchema = baseSchema.extend({
  SERVICE_ROLE: z.literal('agent'),
  PORT: z.coerce.number().int().positive().default(PORT_DEFAULTS['agent']),
  OPENAI_API_KEY: z.string().min(1),
  LANGSMITH_API_KEY: z.string().min(1),
  OAUTH_SECRET: z.string().min(1),
  WEATHER_MCP_URL: z.string().url().default('http://localhost:3001/mcp'),
  FLIGHT_MCP_URL: z.string().url().default('http://localhost:3002/mcp'),
});

const weatherMcpSchema = baseSchema.extend({
  SERVICE_ROLE: z.literal('weather-mcp'),
  PORT: z.coerce.number().int().positive().default(PORT_DEFAULTS['weather-mcp']),
  WEATHERAPI_KEY: z.string().min(1),
});

const flightMcpMockSchema = baseSchema.extend({
  SERVICE_ROLE: z.literal('flight-mcp'),
  PORT: z.coerce.number().int().positive().default(PORT_DEFAULTS['flight-mcp']),
  FLIGHT_PROVIDER: z.literal('mock').default('mock'),
  FLIGHTAWARE_API_KEY: z.string().optional(),
});

const flightMcpFlightawareSchema = baseSchema.extend({
  SERVICE_ROLE: z.literal('flight-mcp'),
  PORT: z.coerce.number().int().positive().default(PORT_DEFAULTS['flight-mcp']),
  FLIGHT_PROVIDER: z.literal('flightaware'),
  FLIGHTAWARE_API_KEY: z.string().min(1),
});

function parseFlightMcpEnv(): FlightMcpEnv {
  const provider = process.env['FLIGHT_PROVIDER'] ?? 'mock';

  if (provider === 'flightaware') {
    return flightMcpFlightawareSchema.parse(process.env);
  }

  return flightMcpMockSchema.parse({
    ...process.env,
    FLIGHT_PROVIDER: provider,
  });
}

export type AgentEnv = z.infer<typeof agentSchema>;
export type WeatherMcpEnv = z.infer<typeof weatherMcpSchema>;
export type FlightMcpEnv = z.infer<typeof flightMcpMockSchema> | z.infer<typeof flightMcpFlightawareSchema>;
export type AppEnv = AgentEnv | WeatherMcpEnv | FlightMcpEnv;

export function loadEnv(): AppEnv {
  const rawRole = process.env['SERVICE_ROLE'];

  const roleResult = z.enum(SERVICE_ROLES).safeParse(rawRole);
  if (!roleResult.success) {
    throw new Error(
      `Invalid SERVICE_ROLE: "${String(rawRole)}". Must be one of: ${SERVICE_ROLES.join(', ')}`,
    );
  }

  const role = roleResult.data;

  switch (role) {
    case 'agent':
      return agentSchema.parse(process.env);
    case 'weather-mcp':
      return weatherMcpSchema.parse(process.env);
    case 'flight-mcp':
      return parseFlightMcpEnv();
  }
}
