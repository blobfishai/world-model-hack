// Live integration check. Start pnpm rooms:dev first. --reactor opts into one
// paid SANA session; normal checks do not call Reactor.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const output = ".task-rooms/playground-qa";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
let reactorCalls = 0;
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => { if (request.url().includes("/api/reactor/token")) reactorCalls++; });
const results = { checked_at: new Date().toISOString(), checks: [], reactor: null };
const note = name => { results.checks.push(name); console.log(name); };
try {
  await page.goto(`${process.env.ROOMS_TEST_URL ?? "http://127.0.0.1:3000"}/rooms/playground`, { waitUntil: "domcontentloaded" });
  const steps = page.getByTestId("episode-steps");
  const status = page.getByTestId("episode-status");
  await expect(page.getByRole("button", { name: /Close gripper/ })).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator(".robot-viewport canvas")).toBeVisible();
  const recorded = page.getByLabel("Recorded Reactor mug-lift result");
  await expect(recorded).toBeVisible();
  await recorded.evaluate(video => video.play());
  await page.waitForFunction(() => document.querySelector('video[aria-label="Recorded Reactor mug-lift result"]').currentTime > .3);
  await recorded.evaluate(video => video.pause());
  expect(reactorCalls).toBe(0);
  note("Recorded Reactor video plays without opening a paid session");
  if (!process.argv.includes("--reactor-only")) {
  const distance = await page.getByTestId("goal-distance").innerText();
  await page.getByRole("button", { name: "Move right", exact: true }).hover();
  await page.mouse.down();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="episode-steps"]').textContent.split("/")[0]) >= 5);
  await page.mouse.up();
  expect(await page.getByTestId("goal-distance").innerText()).not.toBe(distance);
  note("On-screen controls move the physical gripper");
  await page.getByRole("button", { name: /Reset episode/ }).click();
  await expect(steps).toHaveText(/0\s*\/\s*200/);
  await page.getByRole("group", { name: "Robot keyboard controls" }).focus();
  await page.keyboard.down("q");
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="episode-steps"]').textContent.split("/")[0]) >= 3);
  await page.keyboard.up("q");
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: /Open gripper/ })).toBeVisible();
  note("Keyboard XYZ controls and Space gripper toggle work");
  await page.getByRole("button", { name: /Scripted demo/ }).click();
  await expect(status).toHaveText("Task completed", { timeout: 20_000 });
  note("Scripted reach succeeds");
  await page.getByRole("button", { name: "Replay evaluation seed 10046, successful" }).click();
  await expect(steps).toHaveText(/11\s*\/\s*200/, { timeout: 60_000 });
  await expect(status).toHaveText("Task completed");
  await expect(page.getByTestId("episode-return")).toHaveText("10.848");
  note("Saved PPO seed 10046 reproduces success, 11 steps, return 10.848");
  await page.getByRole("button", { name: "Replay evaluation seed 10042, unsuccessful" }).click();
  await expect(status).toHaveText("Episode time limit reached", { timeout: 45_000 });
  await expect(steps).toHaveText(/200\s*\/\s*200/);
  await expect(page.getByTestId("episode-return")).toHaveText("-2.257");
  note("Saved PPO seed 10042 reproduces its unsuccessful 200-step episode");
  }
  await page.getByLabel("Robot task").selectOption("lift:ceramic_mug");
  await expect(steps).toHaveText(/0\s*\/\s*200/);
  await page.getByRole("button", { name: /Scripted demo/ }).click();
  await expect(status).toHaveText("Task completed", { timeout: 30_000 });
  await expect(page.getByText("Holding object", { exact: true })).toBeVisible();
  note("Scripted mug lift succeeds with two-finger contact");

  if (process.argv.includes("--reactor") || process.argv.includes("--reactor-only")) {
    await page.getByRole("button", { name: /Reset episode/ }).click();
    const prompt = "Photorealistic kitchen countertop with ceramic bowls, plates, a mug, a green dish soap bottle and a blue two-finger robot gripper. Warm daylight, realistic ceramic and metal textures. Preserve the source camera, the exact positions and shapes, and the robot's movement. Keep the gripper clearly visible. Do not add objects.";
    await page.getByLabel("APPEARANCE DIRECTION").fill(prompt);
    await page.getByRole("button", { name: /Start Reactor view/ }).click();
    note("Started one real Reactor SANA session");
    await page.waitForFunction(() => {
      const video = document.querySelector('video[aria-label="Live Reactor output"]');
      const error = document.querySelector(".reactor-room-panel [role=alert]");
      if (error) throw new Error(error.textContent);
      return video?.videoWidth > 0 && video.currentTime > 0;
    }, undefined, { timeout: 120_000 });
    await page.evaluate(() => {
      const stream = document.querySelector('video[aria-label="Live Reactor output"]').srcObject;
      window.robotReactorChunks = [];
      window.robotReactorRecorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      window.robotReactorRecorder.ondataavailable = event => { if (event.data.size) window.robotReactorChunks.push(event.data); };
      window.robotReactorRecorder.start(1000);
    });
    await page.getByRole("button", { name: /Scripted demo/ }).click();
    await expect(status).toHaveText("Task completed", { timeout: 30_000 });
    const current = await page.locator('video[aria-label="Live Reactor output"]').evaluate(video => video.currentTime);
    await page.waitForFunction(time => document.querySelector('video[aria-label="Live Reactor output"]').currentTime >= time + 5, current, { timeout: 30_000 });
    await page.screenshot({ path: `${output}/reactor-live.png`, fullPage: true });
    results.reactor = await page.locator('video[aria-label="Live Reactor output"]').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, received_seconds: video.currentTime, source: "live MuJoCo robot canvas", model: "reactor/sana-streaming" }));
    results.reactor.prompt = prompt;
    const recorded = await page.evaluate(() => new Promise(resolve => {
      window.robotReactorRecorder.onstop = async () => {
        const blob = new Blob(window.robotReactorChunks, { type: "video/webm" });
        const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.readAsDataURL(blob);
      };
      window.robotReactorRecorder.stop();
    }));
    await writeFile(`${output}/reactor-demo.webm`, Buffer.from(recorded, "base64"));
    await page.getByRole("button", { name: "Disconnect Reactor", exact: true }).click();
    await expect(page.getByTestId("reactor-status")).toHaveAttribute("data-connection-status", "disconnected");
    note("Received, recorded, and disconnected real Reactor video");
  }
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  note("Desktop and mobile layout checked");
  expect(errors).toEqual([]);
  note("No unhandled browser errors");
} catch (error) {
  results.error = String(error);
  results.browser_errors = errors;
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  console.error(String(error)); process.exitCode = 1;
} finally {
  await page.getByRole("button", { name: "Disconnect Reactor", exact: true }).click({ timeout: 1000 }).catch(() => {});
  await page.goto("about:blank").catch(() => {});
  await browser.close();
  await writeFile(`${output}/report.json`, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results));
}
