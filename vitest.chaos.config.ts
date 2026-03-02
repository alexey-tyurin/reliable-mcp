import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/chaos/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
    fileParallelism: false,
    isolate: false,
  },
});
