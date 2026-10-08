import { defineConfig } from "@playwright/test";

const baseURL = process.env.WORLDS_TEST_URL ?? "http://127.0.0.1:3003";
export default defineConfig({
  testDir: "./tests", testMatch: ["robot-worlds-browser.spec.ts", "reactor-gym-browser.spec.ts", "reactor-director.spec.ts"], workers: 1, timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL, viewport: { width: 1440, height: 1000 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    screenshot: "only-on-failure", trace: "retain-on-failure" },
});
