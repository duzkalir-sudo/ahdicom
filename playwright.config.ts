import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'artifacts/e2e-report.json' }]],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure' },
});
