// Explicit paid check. The app owns its bounded quota retries; always disconnects.
import { chromium } from "@playwright/test";
import { mkdir, stat, writeFile } from "node:fs/promises";

const baseURL = process.env.WORLDS_TEST_URL ?? "http://127.0.0.1:3003";
const folder = `.task-rooms/qa/reactor-gym-live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = { model: "reactor/lingbot-world-2", passed: false, started: new Date().toISOString(), attempts: [] };
report.http = [];
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("request", request => {
  if (request.method() === "POST" && request.url() === "https://api.reactor.inc/sessions") report.attempts.push({ requested: new Date().toISOString() });
});
page.on("response", async response => {
  const url = new URL(response.url());
  if (url.origin !== "https://api.reactor.inc" || !url.pathname.startsWith("/sessions")) return;
  const entry = { method: response.request().method(), path: url.pathname, status: response.status() };
  report.http.push(entry);
  if (/^\/sessions(?:\/[^/]+)?$/.test(url.pathname) && [200, 201].includes(response.status())) {
    try {
      const data = await response.json();
      entry.fields = Object.keys(data);
      if (typeof data.state === "string") entry.state = data.state;
      if (data.selected_transport && typeof data.selected_transport === "object") entry.transportFields = Object.keys(data.selected_transport);
    } catch {}
  }
});
const deadline = setTimeout(() => { void browser.close(); }, 180_000);

async function output(after = 0) {
  await page.waitForFunction(previous => {
    const world = document.querySelector('[data-testid="reactor-gym"]');
    const video = world?.querySelector('video[aria-label="Live Reactor generated world"]');
    return (Number(world?.dataset.reactorFrames) >= Math.max(96, previous + 1) && video?.readyState >= 2 && video.videoWidth === 1664)
      || !!world?.querySelector('[role="alert"]')
      || !!world?.querySelector('[role="status"]')?.textContent.includes("Automatic retries have stopped");
  }, after, { timeout: 120_000 });
  const alert = page.getByTestId("reactor-gym").getByRole("alert");
  if (await alert.count()) throw new Error(await alert.innerText());
  const stopped = page.getByTestId("reactor-gym").getByRole("status").filter({ hasText: "Automatic retries have stopped" });
  if (await stopped.count()) throw new Error(await stopped.innerText());
}

try {
  await page.goto(`${baseURL}/worlds?room=1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Enter Reactor world" }).click();
  await output();
  const world = page.getByTestId("reactor-gym");
  const video = page.locator('video[aria-label="Live Reactor generated world"]');
  report.firstOutput = await video.evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, time: v.currentTime }));
  await page.screenshot({ path: `${folder}/world.png` });
  let count = Number(await world.getAttribute("data-reactor-frames"));
  await world.focus();
  await page.keyboard.down("w"); await page.waitForTimeout(1000); await page.keyboard.up("w");
  await output(count);
  const instruction = "Lift the parcel slowly, move it above the receiving tray, then place it gently in the tray.";
  await page.getByRole("textbox", { name: "Describe a robot task" }).fill(instruction);
  await page.getByRole("button", { name: "Generate task", exact: false }).click();
  await page.waitForFunction(value => {
    const room = document.querySelector('[data-testid="reactor-gym"]');
    return room?.dataset.renderedTaskPhase === "execute" && room.dataset.robotInstruction === value;
  }, instruction, { timeout: 15_000 });
  count = Number(await world.getAttribute("data-reactor-frames"));
  await output(count + 48);
  report.customTask = { instruction, promptConfirmedByModel: true };
  await page.screenshot({ path: `${folder}/custom-task.png` });
  await page.getByRole("button", { name: "Reach the object", exact: false }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reactor-gym"]')?.dataset.renderedTaskPhase === "approach", undefined, { timeout: 15000 });
  count = Number(await world.getAttribute("data-reactor-frames"));
  await output(count + 48);
  await page.screenshot({ path: `${folder}/robot-reach.png` });
  await page.getByRole("button", { name: "Close the fingers", exact: false }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reactor-gym"]')?.dataset.renderedTaskPhase === "grasp", undefined, { timeout: 15000 });
  count = Number(await world.getAttribute("data-reactor-frames"));
  await output(count + 48);
  await page.getByRole("button", { name: "Lift the object", exact: false }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reactor-gym"]')?.dataset.renderedTaskPhase === "execute", undefined, { timeout: 15000 });
  count = Number(await world.getAttribute("data-reactor-frames"));
  await output(count + 48);
  await page.screenshot({ path: `${folder}/robot-lift.png` });
  const download = page.waitForEvent("download", { timeout: 45_000 });
  await page.getByRole("button", { name: "Save 10 s clip", exact: true }).click();
  const clip = await download;
  await clip.saveAs(`${folder}/reactor-task.mp4`);
  report.recording = { file: `${folder}/reactor-task.mp4`, bytes: (await stat(`${folder}/reactor-task.mp4`)).size };
  await page.getByRole("button", { name: "Enter Sunday Kitchen", exact: true }).click();
  await output();
  await page.screenshot({ path: `${folder}/second-room.png` });
  report.secondRoom = await video.evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, time: v.currentTime }));
  report.frames = Number(await world.getAttribute("data-reactor-frames"));
  report.visualSuccess = "Screenshots require review; emitted frames alone do not establish correct manipulation.";
  report.passed = errors.length === 0;
} catch (error) {
  report.error = error.message;
  try { await page.screenshot({ path: `${folder}/failure.png` }); } catch {}
  process.exitCode = 1;
} finally {
  try {
    const leave = page.getByRole("button", { name: "Leave Reactor", exact: true });
    if (await leave.count()) await leave.click({ timeout: 5000 });
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    if (await cancel.count()) await cancel.click({ timeout: 5000 });
    const retry = page.getByRole("button", { name: "Cancel automatic retry", exact: true });
    if (await retry.count()) await retry.click({ timeout: 5000 });
    await page.getByTestId("reactor-gym").evaluate(element => new Promise(resolve => {
      if (element.dataset.reactorStatus === "disconnected") return resolve(true);
      const observer = new MutationObserver(() => { if (element.dataset.reactorStatus === "disconnected") { observer.disconnect(); resolve(true); } });
      observer.observe(element, { attributes: true });
    }));
    report.disconnected = true;
  } catch { report.disconnected = false; }
  report.errors = errors;
  report.finished = new Date().toISOString();
  await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2) + "\n");
  clearTimeout(deadline); await browser.close();
  console.log(JSON.stringify(report)); console.log(`Evidence: ${folder}`);
}
