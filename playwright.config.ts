import { defineConfig } from "@playwright/test";

const baseURL = process.env.ROOMS_TEST_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests",
  testMatch: "rooms-browser.spec.ts",
  timeout: 60_000,
  use: { baseURL, viewport: { width: 1440, height: 1000 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: `pnpm dev --port ${new URL(baseURL).port || "3000"}`, url: `${baseURL}/explore`, reuseExistingServer: true, timeout: 90_000 },
});
