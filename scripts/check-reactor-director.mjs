// Opt-in live verification: one connection, bounded retries, always released.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const baseURL = process.env.WORLDS_TEST_URL ?? "http://127.0.0.1:3003";
const folder = `.task-rooms/qa/reactor-director-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = { model: "reactor/lingbot-world-2", passed: false, errors: [], sessionResponses: [] };
let tokens = 0;
page.on("pageerror", error => report.errors.push(error.message));
page.on("request", request => { if (request.url().includes("/api/reactor/token")) tokens++; });
page.on("response", async response => {
  if (response.request().method() !== "POST" || response.url() !== "https://api.reactor.inc/sessions") return;
  const entry = { status: response.status() }; report.sessionResponses.push(entry);
  if (response.status() === 429) {
    const body = await response.json().catch(() => ({}));
    entry.quota = body.quota_type; entry.retryAfterSeconds = body.retry_after_seconds;
  }
  console.log(`Reactor session response: ${entry.status}${entry.quota ? ` (${entry.quota})` : ""}`);
});
const deadline = setTimeout(() => { void browser.close(); }, 300_000);

async function generated(after = 0) {
  await page.waitForFunction(previous => {
    const world = document.querySelector('[data-testid="reactor-gym"]');
    const video = world?.querySelector('video[aria-label="Live Reactor generated world"]');
    return (Number(world?.dataset.reactorFrames) >= Math.max(96, previous + 1) && video?.readyState >= 2 && video.videoWidth === 1664)
      || !!world?.querySelector('[role="alert"]')
      || [...(world?.querySelectorAll('[role="status"]') ?? [])].some(element => element.textContent.includes("Automatic retries have stopped"));
  }, after, { timeout: 130_000 });
  const alert = page.getByTestId("reactor-gym").getByRole("alert");
  if (await alert.count()) throw new Error(await alert.innerText());
  const stopped = page.getByTestId("reactor-gym").getByRole("status").filter({ hasText: "Automatic retries have stopped" });
  if (await stopped.count()) throw new Error(await stopped.innerText());
}

try {
  await page.goto(`${baseURL}/worlds?room=1.2.1.2.3`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Enter Reactor world" }).click();
  await generated();
  console.log("Live frames received; generating the complete robot task.");
  const connectedTokens = tokens;
  const world = page.getByTestId("reactor-gym");
  report.initialFrames = Number(await world.getAttribute("data-reactor-frames"));
  await page.getByRole("button", { name: "Run task with Reactor", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reactor-gym"]')?.dataset.taskPhase === "execute", undefined, { timeout: 60_000 });
  await page.screenshot({ path: `${folder}/task-executing.png` });
  await page.waitForFunction(() => document.querySelector('[data-testid="reactor-gym"]')?.dataset.sequenceComplete === "true", undefined, { timeout: 60_000 });
  report.taskSequence = { complete: true, phase: await world.getAttribute("data-task-phase"),
    generatedFrames: Number(await world.getAttribute("data-reactor-frames")) - report.initialFrames };
  await page.screenshot({ path: `${folder}/task-generated.png` });
  console.log("Task sequence generated; checking scene direction and movement interruption.");

  const direction = "Warm late-afternoon sunlight, soft long shadows and subtle dust in the light.";
  await page.getByRole("button", { name: "Direct the world" }).click();
  await page.getByRole("textbox", { name: "Describe the world" }).fill(direction);
  await page.getByRole("button", { name: "Apply to Reactor" }).click();
  await page.waitForFunction(expected => {
    const world = document.querySelector('[data-testid="reactor-gym"]');
    return world?.dataset.sceneDirection === expected && world?.dataset.renderedTaskPhase !== "pending";
  }, direction, { timeout: 30_000 });
  await generated(Number(await world.getAttribute("data-reactor-frames")) + 96);
  report.sceneDirectionAcknowledged = true;
  await page.screenshot({ path: `${folder}/directed-scene.png` });
  await page.getByRole("button", { name: "Direct the world" }).click();

  await page.getByRole("button", { name: "Run task with Reactor", exact: true }).click();
  await world.focus();
  await page.keyboard.down("w");
  await page.waitForTimeout(700);
  await page.keyboard.up("w");
  report.movementStopsSequence = await world.getAttribute("data-director-mode") === "idle";
  report.directionPreserved = await world.getAttribute("data-scene-direction") === direction;
  if (!report.movementStopsSequence || !report.directionPreserved) throw new Error("Taking control did not preserve the directed scene.");

  const task = "Rotate the power cell gently in place, then hold it still.";
  await page.getByRole("textbox", { name: "Describe a robot task" }).fill(task);
  await page.getByRole("button", { name: "Generate task" }).click();
  await page.waitForFunction(expected => {
    const world = document.querySelector('[data-testid="reactor-gym"]');
    return world?.dataset.robotInstruction === expected && world?.dataset.renderedTaskPhase === "execute";
  }, task, { timeout: 30_000 });
  report.customTaskAcknowledged = true;
  console.log("Scene and custom task prompts acknowledged; generating the doorway walk.");

  const portal = page.getByRole("button", { name: /^Walk to / });
  const destination = (await portal.getAttribute("aria-label")).replace(/^Walk to /, "");
  await portal.click();
  await page.getByRole("heading", { name: destination, exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await generated();
  report.destination = destination;
  report.reusedConnection = tokens === connectedTokens;
  report.output = await page.locator('video[aria-label="Live Reactor generated world"]').evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, time: v.currentTime }));
  await page.screenshot({ path: `${folder}/next-room.png` });
  report.passed = report.errors.length === 0 && report.reusedConnection;
  report.visualReview = "Generated frames and accepted prompts do not establish correct contacts or physical task success.";
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  try { await page.screenshot({ path: `${folder}/failure.png` }); } catch {}
} finally {
  try {
    for (const name of ["Leave Reactor", "Cancel", "Cancel automatic retry"]) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.count()) await button.click({ timeout: 5000 });
    }
    report.disconnected = await page.getByTestId("reactor-gym").getAttribute("data-reactor-status") === "disconnected";
  } catch { report.disconnected = false; }
  report.tokenRequests = tokens;
  report.finished = new Date().toISOString();
  await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2) + "\n");
  clearTimeout(deadline); await browser.close();
  console.log(JSON.stringify(report)); console.log(`Evidence: ${folder}`);
}
