import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  // Playwright empties outputDir before each run; keep it away from native test records.
  outputDir: "test-results/playwright",
  workers: 1,
  use: {
    channel: "msedge",
    baseURL: "http://localhost:1420",
    viewport: { width: 1000, height: 720 },
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
  },
});
