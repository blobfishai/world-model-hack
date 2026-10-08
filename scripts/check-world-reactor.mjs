// Explicit, bounded live check: this command starts one paid Reactor session.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const baseURL = process.env.PLAY_BASE_URL ?? "http://127.0.0.1:3000";
const folder = `.task-rooms/world/reactor-check-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1480, height: 1120 } });
const report = { model: "reactor/sana-streaming", input: "live Three.js avatar camera at 1280×704 / 24 fps", started: new Date().toISOString(), passed: false };
const timeout = setTimeout(() => { void browser.close(); }, 150_000);
try {
  await page.goto(`${baseURL}/play`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("button", { name: "Skip & enter the world" }).click();
  await page.getByRole("button", { name: "Start live Reactor view" }).click();
  console.log("Reactor session requested; waiting for generated camera frames.");
  await page.waitForFunction(() => {
    const preview = document.querySelector('[aria-label="Live Reactor preview"]');
    const video = document.querySelector('[aria-label="Live Reactor preview"] video');
    return (Number(preview?.dataset.reactorFrames) > 0 && video?.readyState >= 2 && video.videoWidth === 1280 && video.videoHeight === 704 && video.currentTime > 0)
      || !!document.querySelector('[aria-label="Live Reactor preview"] [role="alert"]');
  }, undefined, { timeout: 100_000 });
  const alert = page.locator('[aria-label="Live Reactor preview"] [role="alert"]');
  if (await alert.count()) throw new Error(await alert.innerText());
  report.firstOutput = await page.locator('[aria-label="Live Reactor preview"] video').evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, time: v.currentTime }));
  console.log(`Generated video received: ${report.firstOutput.width}×${report.firstOutput.height}. Walking to Laundry.`);
  await page.screenshot({ path: `${folder}/dishes.png`, fullPage: true });
  await page.getByRole("button", { name: "Walk to Laundry", exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[aria-label^="Walkable task world"]');
    return canvas?.dataset.room === "laundry" && Number(canvas.dataset.position?.split(",")[1]) > 2.5;
  }, undefined, { timeout: 20_000 });
  await page.locator('[aria-label="Live Reactor preview"] video').evaluate(v => new Promise(resolve => {
    let count = 0;
    const frame = () => { if (++count >= 24) resolve(true); else v.requestVideoFrameCallback(frame); };
    v.requestVideoFrameCallback(frame);
  }));
  report.afterWalk = await page.locator('[aria-label="Live Reactor preview"] video').evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, time: v.currentTime }));
  report.framesEmitted = Number(await page.locator('[aria-label="Live Reactor preview"]').getAttribute("data-reactor-frames"));
  await page.screenshot({ path: `${folder}/laundry.png`, fullPage: true });
  if (report.afterWalk.time <= report.firstOutput.time) throw new Error("Generated video did not advance during walking");
  report.passed = true;
} catch (error) {
  report.error = String(error.message).slice(0, 1200);
  try {
    report.status = await page.locator('[aria-label="Live Reactor preview"]').getAttribute("data-reactor-status");
    report.phase = await page.locator('[aria-label="Live Reactor preview"]').getAttribute("data-reactor-phase");
    report.preview = await page.locator('[aria-label="Live Reactor preview"]').innerText();
    await page.screenshot({ path: `${folder}/failure.png`, fullPage: true });
  } catch { /* The outer deadline may already have closed the browser. */ }
  process.exitCode = 1;
} finally {
  try {
    await page.getByRole("button", { name: "Disconnect Reactor", exact: true }).click({ timeout: 5000 });
    await page.locator('[data-reactor-status="disconnected"]').waitFor({ timeout: 10000 });
    report.disconnected = true;
  } catch { report.disconnected = report.status === "disconnected"; }
  report.finished = new Date().toISOString();
  await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2));
  clearTimeout(timeout);
  await browser.close();
  console.log(JSON.stringify(report));
  console.log(`Evidence: ${folder}`);
}
