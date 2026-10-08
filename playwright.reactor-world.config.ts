import { defineConfig } from "@playwright/test";

const baseURL = process.env.WORLD_TEST_URL ?? "http://127.0.0.1:3011";
const port = new URL(baseURL).port || "3011";

// Every /api/worlds and Reactor token request is mocked in the spec, so no paid session can start.
export default defineConfig({
  testDir: "./tests",
  testMatch: "reactor-world-browser.spec.ts",
  timeout: 90_000,
  use: { baseURL, viewport: { width: 1440, height: 960 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: `TASK_ROOM_NEXT_DIST_DIR=.task-rooms/next-world-test pnpm dev --port ${port}`,
    url: `${baseURL}/world`, reuseExistingServer: true, timeout: 180_000 },
});
