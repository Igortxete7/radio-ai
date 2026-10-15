import { defineConfig, devices } from '@playwright/test';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100';
const origin = new URL(baseURL);
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 30000,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: `npm run dev -w @radio/web -- --port ${origin.port || 3100}`,
    url: `${origin.origin}/api/session`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      ADMIN_TOKEN: 'radio-e2e-test-token-with-sufficient-length',
      ADMIN_ORIGIN: origin.origin,
    },
  },
});
