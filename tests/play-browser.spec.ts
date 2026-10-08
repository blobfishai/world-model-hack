import { test, expect, type Page } from "@playwright/test";
import * as THREE from "three";

type Family = "dishes" | "laundry" | "drawing";
const canvas = (page: Page) => page.locator('canvas[aria-label^="Walkable task world"]');

async function open(page: Page) {
  await page.goto("/play");
  await page.getByRole("button", { name: "Skip & enter the world" }).click();
  await expect(canvas(page)).toHaveAttribute("data-room", "dishes");
}

async function station(page: Page, family: Family) {
  if (await canvas(page).getAttribute("data-station")) await page.getByRole("button", { name: /Return to walking/ }).click();
  if (await canvas(page).getAttribute("data-room") !== family) {
    await page.getByRole("button", { name: `Walk to ${family[0].toUpperCase()+family.slice(1)}`, exact: true }).click();
    await expect(canvas(page)).toHaveAttribute("data-room", family, { timeout: 20_000 });
    await expect.poll(async () => Number((await canvas(page).getAttribute("data-position"))?.split(",")[1]), { timeout: 20_000 }).toBeGreaterThan(2.5);
  }
  await page.getByRole("button", { name: new RegExp(`Use ${family} station`) }).click();
  await expect(canvas(page)).toHaveAttribute("data-station", family);
  await page.waitForTimeout(850);
}

async function point(page: Page, family: Family, xyz: number[]) {
  await canvas(page).scrollIntoViewIfNeeded();
  const bounds = (await canvas(page).boundingBox())!;
  const x = family === "dishes" ? -7 : family === "drawing" ? 7 : 0;
  const close = family === "drawing";
  const position = close ? [x-.15, 3.55, 2.1] : [x, 2.55, family === "laundry" ? 2.7 : 3];
  const target = close ? [x-.15, 4.45, .94] : [x, 4.45, family === "laundry" ? .66 : .95];
  const camera = new THREE.PerspectiveCamera(66, 1280/704, .035, 70);
  camera.position.set(position[0], position[2], -position[1]);
  camera.lookAt(target[0], target[2], -target[1]); camera.updateMatrixWorld();
  const p = new THREE.Vector3(xyz[0], xyz[2], -xyz[1]).project(camera);
  return { x: bounds.x + (p.x+1)/2*bounds.width, y: bounds.y + (1-p.y)/2*bounds.height };
}

async function drag(page: Page, family: Family, start: number[], end: number[], hold = 150) {
  const a = await point(page, family, start), b = await point(page, family, end);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 16 }); await page.waitForTimeout(hold); await page.mouse.up();
}

async function scrub(page: Page) {
  const a = await point(page, "dishes", [-7.7, 4.5, .955]);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
    const dx = (col - 3)*.048, dy = (row - 3)*.048;
    if (Math.hypot(dx, dy) > .185) continue;
    const p = await point(page, "dishes", [-7.7+dx, 4.5+dy, .955]);
    await page.mouse.move(p.x, p.y); await page.waitForTimeout(45);
  }
  await page.mouse.up();
}

async function drawingStroke(page: Page, from: number[], to: number[]) {
  const a = await point(page, "drawing", [6.85+(from[0]-.5)*.84, 4.45+(from[1]-.5)*.98, .941]);
  const b = await point(page, "drawing", [6.85+(to[0]-.5)*.84, 4.45+(to[1]-.5)*.98, .941]);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= 22; i++) {
    await page.mouse.move(a.x+(b.x-a.x)*i/22, a.y+(b.y-a.y)*i/22); await page.waitForTimeout(35);
  }
  await page.mouse.up();
}

test("walk through all rooms and complete nine tasks with real pointer input", async ({ page }) => {
  const errors: string[] = []; let modelCalls = 0;
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (r.url().includes("/api/reactor/token")) modelCalls++; });
  await open(page); await station(page, "dishes");
  await scrub(page);
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1", { timeout: 10_000 });
  await page.getByRole("button", { name: /02 Rinse a plate/ }).click(); await page.waitForTimeout(250);
  await drag(page, "dishes", [-6.8, 4.4, .935], [-7.7, 4.5, 1.22], 3000);
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1", { timeout: 5000 });
  await page.getByRole("button", { name: /03 Wash and stack/ }).click();
  await page.waitForTimeout(250); await scrub(page);
  await page.getByRole("button", { name: /✋ hand/i }).click();
  const plate = await point(page, "dishes", [-7.7, 4.5, .955]);
  const tap = await point(page, "dishes", [-7.7, 4.5, 1.22]);
  const stack = await point(page, "dishes", [-5.65, 4.5, 1.22]);
  await page.mouse.move(plate.x, plate.y); await page.mouse.down();
  await page.mouse.move(tap.x, tap.y, { steps: 15 }); await page.waitForTimeout(3000);
  await page.mouse.move(stack.x, stack.y, { steps: 30 }); await page.waitForTimeout(1000); await page.mouse.up();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1", { timeout: 8000 });
  await station(page, "laundry");
  await drag(page, "laundry", [-.93, 4.25, .703], [-.17, 4.25, .703]);
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: /02 Make a narrow fold/ }).click(); await page.waitForTimeout(400);
  await drag(page, "laundry", [-.93, 4.25, .703], [-.17, 4.25, .703]); await page.waitForTimeout(400);
  await drag(page, "laundry", [-.33, 4.25, .72], [-.76, 4.25, .72]);
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: /03 Fold and stack/ }).click(); await page.waitForTimeout(400);
  await drag(page, "laundry", [-.93, 4.25, .703], [-.17, 4.25, .703]); await page.waitForTimeout(400);
  await drag(page, "laundry", [-.33, 4.25, .72], [-.76, 4.25, .72]); await page.waitForTimeout(400);
  await drag(page, "laundry", [-.55, 4.25, .74], [1.1, 4.25, .99], 1100);
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1", { timeout: 8000 });
  await station(page, "drawing");
  await drawingStroke(page, [.15, .5], [.85, .5]);
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: /02 Trace a cross/ }).click();
  await drawingStroke(page, [.15, .5], [.85, .5]); await drawingStroke(page, [.5, .15], [.5, .85]);
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: /03 Shade the cross/ }).click();
  for (const offset of [.4, .46, .52, .58]) {
    await drawingStroke(page, [.15, offset], [.85, offset]);
    await drawingStroke(page, [offset, .15], [offset, .85]);
  }
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await expect(page.getByText("09 / 09", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Reset task" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "0");
  expect(errors).toEqual([]); expect(modelCalls).toBe(0);
});

test("keyboard walking, demonstrations, and mobile layout work", async ({ page }) => {
  await open(page);
  const before = await canvas(page).getAttribute("data-position");
  await canvas(page).focus(); await page.keyboard.down("s"); await page.waitForTimeout(450); await page.keyboard.up("s");
  await expect(canvas(page)).not.toHaveAttribute("data-position", before!);
  await page.getByRole("button", { name: /Watch demonstration/ }).click();
  await page.getByRole("button", { name: "Watch 10-second demo" }).click();
  await expect.poll(() => page.locator("dialog video").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close demonstration", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Walk to Laundry", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("source videos seek correctly and unknown assets stay private", async ({ request }) => {
  const response = await request.get("/api/rooms/media/play-dishes-source", { headers: { Range: "bytes=0-1023" } });
  expect(response.status()).toBe(206); expect((await response.body()).length).toBe(1024);
  expect((await request.get("/api/rooms/media/play-secrets-source")).status()).toBe(404);
  expect((await request.get("/api/rooms/media/play-dishes-source", { headers: { Range: "bytes=999999999999-" } })).status()).toBe(416);
});

test("backend failure offers a retry", async ({ page }) => {
  await page.route("**/api/task-world", route => route.fulfill({ status: 503, json: { error: "The physics service is offline." } }));
  await page.goto("/play");
  await expect(page.getByRole("alert").filter({ hasText: "offline" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
});
