import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("task-rooms:auto-generate", "false"));
});

test("walk through a doorway, descend again, and retrace the room trail", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => { if (response.status() >= 400 && response.url().includes("/_next/static/")) pageErrors.push(`Missing asset: ${response.url()}`); });
  await page.goto("/explore");
  await expect(page.getByRole("heading", { name: "Wash a plate", exact: true })).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^Walk into room/ })).toHaveCount(10);
  await page.getByRole("button", { name: "Walk into room 1: Place the plate on the counter" }).click();
  await expect(page.getByRole("heading", { name: "Place the plate on the counter", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/environment=kitchen&room=0$/);
  await expect(page.getByRole("button", { name: /^Walk into room/ })).toHaveCount(10);
  await page.getByRole("button", { name: "Walk into room 5: Practice the first grasp" }).click();
  await expect(page.getByRole("heading", { name: "Practice the first grasp", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/room=0.4$/);
  await page.getByRole("button", { name: "Return to parent room" }).click();
  await expect(page.getByRole("heading", { name: "Place the plate on the counter", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Place the plate on the counter", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Task details", exact: true }).click();
  await expect(page.getByText("All descendants use this original environment.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open robot gym" })).toBeEnabled();
  await page.getByRole("button", { name: "Close task details" }).click();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Practice the first grasp", level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Place the plate on the counter", level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Wash a plate", level: 1 })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Place the plate on the counter", level: 1 })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("keyboard walking moves the map marker and video playback opens", async ({ page }) => {
  await page.goto("/explore");
  await expect(page.locator("canvas")).toBeVisible();
  const marker = page.locator('svg[aria-label="Map of this room with ten connected doorways"] > g:last-child');
  await expect(marker).toHaveAttribute("transform", /translate/);
  const before = await marker.getAttribute("transform");
  await page.locator("canvas").focus();
  await page.keyboard.down("w");
  await page.waitForTimeout(700);
  await page.keyboard.up("w");
  await expect.poll(() => marker.getAttribute("transform")).not.toBe(before);
  await page.getByRole("button", { name: "Open footage player" }).click();
  await expect(page.locator("dialog video")).toBeVisible();
  await page.getByRole("button", { name: "Close footage player" }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
});

test("mobile room directory and map navigation work", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/explore");
  await page.getByRole("button", { name: "Show connected rooms" }).click();
  await expect(page.getByRole("button", { name: /^Walk into room/ })).toHaveCount(10);
  await page.getByRole("button", { name: "Walk into room 2: Rinse the plate" }).click();
  await expect(page.getByRole("heading", { name: "Rinse the plate", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Walk forward", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show connected rooms" })).toBeVisible();
});

test("a completed experiment updates footage without moving the walking camera", async ({ page }) => {
  await page.goto("/explore");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 20_000 });
  await page.locator("canvas").focus();
  await page.keyboard.down("w");
  await page.waitForTimeout(600);
  await page.keyboard.up("w");
  // Let the map's 100 ms position sampling settle after movement stops.
  await page.waitForTimeout(150);
  const marker = page.locator('svg[aria-label="Map of this room with ten connected doorways"] > g:last-child');
  const pose = await marker.getAttribute("transform");
  await page.getByRole("button", { name: "Pause footage", exact: true }).click();
  await page.route("**/api/rooms/experiments", route => route.fulfill({ json: { experiment: {
    id: "a".repeat(24), status: "ready", message: "Saved test fixture", attempt: 1,
    assetUrl: "/api/rooms/media/kitchen-source?qa=1", error: null,
    review: { verdict: "mismatch", observedActions: "Repeated source action.", reasons: [] },
  } } }));
  await page.getByRole("button", { name: /^(Generate experiment|Run again)$/ }).click();
  await expect(page.getByText("TASK MISMATCH", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause footage", exact: true })).toBeVisible();
  await expect(marker).toHaveAttribute("transform", pose!);
});

test("media seeking is bounded and invalid experiment requests make no provider call", async ({ request, baseURL }) => {
  const range = await request.get("/api/rooms/media/kitchen-source", { headers: { Range: "bytes=0-1023" } });
  expect(range.status()).toBe(206);
  expect((await range.body()).byteLength).toBe(1024);
  expect(range.headers()["content-range"]).toMatch(/^bytes 0-1023\//);
  expect((await request.get("/api/rooms/media/kitchen-source", { headers: { Range: "bytes=999999999999-" } })).status()).toBe(416);
  expect((await request.get("/api/rooms/media/credentials")).status()).toBe(404);
  expect((await request.post("/api/rooms/experiments", { data: { environment: "kitchen", room: "../../.env" } })).status()).toBe(400);
  expect((await request.post("/api/rooms/experiments", { headers: { Origin: baseURL! }, data: { environment: "kitchen", room: "../../.env" } })).status()).toBe(400);
  expect((await request.post("/api/rooms/experiments", { headers: { Origin: "https://unrelated.example" }, data: { environment: "kitchen", room: "3" } })).status()).toBe(403);
});
