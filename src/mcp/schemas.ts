import { z } from 'zod';

export const WeatherInputSchema = z.object({
  city: z.string().describe("City name (e.g., 'New York', 'London')"),
  units: z
    .enum(['celsius', 'fahrenheit'])
    .default('celsius')
    .describe('Temperature unit'),
});

export const WeatherOutputSchema = z.object({
  city: z.string(),
  country: z.string(),
  temperature: z.number(),
  units: z.enum(['celsius', 'fahrenheit']),
  condition: z.string(),
  humidity: z.number(),
  timestamp: z.string().datetime(),
});

export const WeatherApiResponseSchema = z.object({
  location: z.object({
    name: z.string(),
    country: z.string(),
  }),
  current: z.object({
    temp_c: z.number(),
    temp_f: z.number(),
    condition: z.object({
      text: z.string(),
    }),
    humidity: z.number(),
  }),
});

export type WeatherInput = z.infer<typeof WeatherInputSchema>;
export type WeatherOutput = z.infer<typeof WeatherOutputSchema>;
export type WeatherApiResponse = z.infer<typeof WeatherApiResponseSchema>;

const FLIGHT_STATUSES = [
  'scheduled',
  'boarding',
  'in_air',
  'landed',
  'cancelled',
  'delayed',
] as const;

export const FlightInputSchema = z.object({
  flight_number: z
    .string()
    .describe("IATA flight number (e.g., 'UA123', 'BA456')"),
  date: z
    .string()
    .date()
    .optional()
    .describe('Flight date in YYYY-MM-DD format. Defaults to today.'),
});

const flightEndpointSchema = z.object({
  airport: z.string(),
  scheduled: z.string().datetime(),
  actual: z.string().datetime().nullable(),
  estimated: z.string().datetime().nullable(),
});

export const FlightOutputSchema = z.object({
  flight_number: z.string(),
  airline: z.string(),
  status: z.enum(FLIGHT_STATUSES),
  departure: flightEndpointSchema,
  arrival: flightEndpointSchema,
  delay_minutes: z.number().int().min(0),
  timestamp: z.string().datetime(),
});

export const FlightFixtureSchema = z.object({
  flight_number: z.string(),
  airline: z.string(),
  status: z.enum(FLIGHT_STATUSES),
  departure: z.object({
    airport: z.string(),
    scheduled: z.string().datetime(),
    actual: z.string().datetime().nullable(),
  }),
  arrival: z.object({
    airport: z.string(),
    scheduled: z.string().datetime(),
    estimated: z.string().datetime().nullable(),
  }),
  delay_minutes: z.number().int().min(0),
});

export type FlightInput = z.infer<typeof FlightInputSchema>;
export type FlightOutput = z.infer<typeof FlightOutputSchema>;
export type FlightFixture = z.infer<typeof FlightFixtureSchema>;
