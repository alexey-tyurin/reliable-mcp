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
