import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/fuzz/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/setup/fixtures.global.ts'],
    testTimeout: 20000,
    pool: 'threads',
  },
});
