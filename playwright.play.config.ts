import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAY_TEST_URL ?? "http://127.0.0.1:3107";
const apiURL = process.env.PLAY_TEST_API_URL ?? "http://127.0.0.1:8012";

export default defineConfig({
  testDir: "./tests", testMatch: "play-browser.spec.ts", workers: 1, timeout: 150_000,
  outputDir: ".task-rooms/world/browser-tests",
  use: { baseURL, viewport: { width: 1480, height: 1120 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: [
    { command: "uv run rooms-server", url: `${apiURL}/health`, reuseExistingServer: !!process.env.PLAY_TEST_API_URL, timeout: 60_000,
      env: { ROOM_SIM_PORT: new URL(apiURL).port, ROOM_SIM_HOME: ".task-rooms/play-tests/rooms", ROOM_SIM_EXTRA_ORIGINS: baseURL } },
    { command: `pnpm dev --port ${new URL(baseURL).port}`, url: `${baseURL}/play`, reuseExistingServer: !!process.env.PLAY_TEST_URL, timeout: 90_000,
      env: { ROOM_SIM_URL: apiURL, NEXT_PUBLIC_ROOM_SIM_WS_URL: apiURL.replace(/^http/, "ws"), TASK_ROOM_NEXT_DIST_DIR: ".next-play-tests" } },
  ],
});
