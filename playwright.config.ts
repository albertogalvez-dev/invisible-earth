import { defineConfig } from '@playwright/test';

// End-to-end checks run one at a time against the dev server (they share the GPU and step a fake clock).
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 240_000,
  reporter: [['list']],
  outputDir: '.cache/test-results',
  use: {
    baseURL: process.env.IE_URL ?? 'http://localhost:5178/', // IE_URL=http://localhost:4178/ checks the production build
    // The real GPU: software WebGL would make every frame take a second.
    launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] },
  },
  webServer: process.env.IE_URL ? undefined : { command: 'npm run dev', url: 'http://localhost:5178/', reuseExistingServer: true, timeout: 60_000 },
});
