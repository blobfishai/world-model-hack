// Explicit live check: one SANA session editing actual MuJoCo frames, always released.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";

for (const path of [".env.local", ".env"]) {
  try { loadEnvFile(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

const base = process.env.WORLDS_TEST_URL ?? "http://127.0.0.1:3003";
const folder = `.task-rooms/qa/reactor-physics-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ headless: true, args: process.env.REACTOR_TEST_GPU === "metal" ? ["--use-angle=metal"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const report = { model: "reactor/sana-streaming", source: "live MuJoCo Panda camera", passed: false, errors: [], sessions: [], ids: [] };
page.on("pageerror", error => report.errors.push(error.stack ?? error.message));
page.on("response", async response => {
  if (response.url() === "https://api.reactor.inc/sessions" && response.request().method() === "POST") {
    report.sessions.push(response.status());
    if (response.ok()) { const body = await response.json(); if (body.session_id) report.ids.push(body.session_id); }
  }
});
const deadline = setTimeout(() => void browser.close(), 300_000);
async function saveFrame(name) {
  const data = await page.getByLabel("Reactor enhanced physics view").evaluate(video => {
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0); return canvas.toDataURL("image/png").split(",")[1];
  });
  await writeFile(`${folder}/${name}.png`, Buffer.from(data, "base64"));
}
try {
  await page.goto(`${base}/worlds?mode=physics`, { waitUntil: "domcontentloaded" });
  await page.getByText("Physics live", { exact: true }).waitFor();
  const source = page.locator("canvas");
  report.input = await source.evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  await page.screenshot({ path: `${folder}/simulation.png` });
  await page.getByRole("button", { name: "Start high fidelity view ↗", exact: true }).click();
  await page.waitForFunction(() => {
    const layer = document.querySelector('[data-testid="reactor-physics"]');
    return layer?.dataset.phase === "error" || (layer?.dataset.phase === "live" && Number(layer.dataset.frames) >= 72);
  }, undefined, { timeout: 100_000 });
  const layer = page.getByTestId("reactor-physics");
  if (await layer.getAttribute("data-phase") === "error") throw new Error(await layer.getByRole("alert").innerText());
  report.initialFrames = Number(await layer.getAttribute("data-frames"));
  report.output = await page.getByLabel("Reactor enhanced physics view").evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, time: v.currentTime }));
  await saveFrame("generated-natural-frame");
  await page.screenshot({ path: `${folder}/reactor-natural.png` });
  const distance = await page.getByTestId("goal-distance").innerText();
  await source.focus();
  await page.keyboard.down("ArrowRight"); await page.waitForTimeout(500); await page.keyboard.up("ArrowRight");
  await page.waitForFunction(before => document.querySelector('[data-testid="goal-distance"]')?.textContent !== before, distance);
  report.physicsControlsWork = true;
  const position = await source.getAttribute("data-camera-position");
  await page.keyboard.down("w"); await page.waitForTimeout(350); await page.keyboard.up("w");
  report.walkingWorks = await source.getAttribute("data-camera-position") !== position;
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reactor-physics"]')?.dataset.renderedLook === "studio", undefined, { timeout: 90_000 });
  report.studioPromptRendered = true;
  await saveFrame("generated-studio-frame");
  await page.screenshot({ path: `${folder}/reactor-studio.png` });
  await page.getByRole("button", { name: "Simulation", exact: true }).click();
  report.compareWorks = await page.getByRole("button", { name: "Simulation", exact: true }).getAttribute("aria-pressed") === "true";
  await page.getByRole("button", { name: "Reactor view", exact: true }).click();
  report.anchors = Number(await layer.getAttribute("data-anchors"));
  report.finalFrames = Number(await layer.getAttribute("data-frames"));
  await page.getByRole("button", { name: "Enter Cargo Hall", exact: true }).click();
  await page.getByRole("heading", { name: "Cargo Hall", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="reactor-physics"]')?.dataset.renderedRoom === "1", undefined, { timeout: 90_000 });
  report.roomSwitchRendered = true;
  await saveFrame("generated-warehouse-frame");
  await page.screenshot({ path: `${folder}/reactor-warehouse.png` });
  report.passed = report.errors.length === 0 && report.sessions.length === 1 && report.walkingWorks && report.physicsControlsWork && report.compareWorks && report.studioPromptRendered && report.roomSwitchRendered;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  try { await page.screenshot({ path: `${folder}/failure.png` }); } catch {}
} finally {
  try {
    const stop = page.getByRole("button", { name: "Stop Reactor", exact: true });
    if (await stop.count()) await stop.click();
    await page.getByRole("button", { name: "Start high fidelity view ↗", exact: true }).waitFor({ timeout: 5000 });
    report.disconnected = true;
  } catch { report.disconnected = false; }
  report.terminated = [];
  for (const id of report.ids) {
    const result = await fetch(`https://api.reactor.inc/sessions/${id}`, { method: "DELETE", headers: { "Reactor-API-Key": process.env.REACTOR_API_KEY } });
    report.terminated.push({ id, status: result.status });
  }
  await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2) + "\n");
  clearTimeout(deadline); await browser.close();
  console.log(JSON.stringify(report, null, 2)); console.log(`Evidence: ${folder}`);
}
