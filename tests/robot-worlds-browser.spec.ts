import { test, expect } from "@playwright/test";
import { worldChildren, worldRoom } from "../app/lib/robot-worlds";
import { physicsRenderPrompt, RENDER_LOOKS } from "../app/worlds/physics-render";

test("walk, control the robot, finish physical tasks, and export a training gym", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/worlds?mode=physics");
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByText("Physics live", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Enter / })).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Enter The Glasshouse", exact: true })).toHaveCount(0);
  const before = await page.locator("canvas").getAttribute("data-camera-position");
  await page.locator("canvas").focus();
  await page.keyboard.down("w");
  try {
    await expect(page.locator("canvas")).not.toHaveAttribute("data-camera-position", before!);
  } finally {
    await page.keyboard.up("w");
  }
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Open gripper", exact: false })).toBeVisible();
  const distance = await page.getByTestId("goal-distance").innerText();
  await page.keyboard.down("ArrowRight");
  try {
    await expect(page.getByTestId("goal-distance")).not.toHaveText(distance);
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  await page.getByRole("button", { name: "Watch demo", exact: false }).click();
  await expect(page.getByText("Task complete", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset task", exact: false }).click();
  await expect(page.getByText("Task complete", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Enter Sunday Kitchen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sunday Kitchen", exact: true })).toBeVisible();
  await expect(page.getByText("Physics live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Watch demo", exact: false }).click();
  await expect(page.getByText("Task complete", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export training gym", exact: false }).click();
  expect((await download).suggestedFilename()).toBe("kitchen-robot-gym.zip");
  await page.getByRole("button", { name: "Return to parent world", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The Glasshouse", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Sunday Kitchen", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile controls and recursive doors use distinct rooms", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/worlds?room=1&mode=physics");
  await expect(page.getByRole("heading", { name: "Cargo Hall", exact: true })).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await page.getByRole("button", { name: "Show connected robot rooms", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Enter / })).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Enter Cargo Hall", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Enter Pelagic Outpost", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pelagic Outpost", exact: true })).toBeVisible();
  await expect(page.getByText("Physics live", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/room=1\.4(?:&|$)/);
  const before = await page.getByTestId("goal-distance").innerText();
  const control = page.getByRole("button", { name: "Raise gripper", exact: true });
  await control.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch" });
  await page.waitForTimeout(550);
  await control.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch" });
  await expect(page.getByTestId("goal-distance")).not.toHaveText(before);
  await page.screenshot({ path: ".task-rooms/qa/robot-worlds-mobile.png" });
});

test("all room images and Reactor outputs are served and support seeking", async ({ request }) => {
  const themes = await (await request.get("/robot-worlds/worlds.json")).json();
  expect(themes).toHaveLength(11);
  for (const theme of themes) {
    expect((await request.head(`/robot-worlds/${theme.id}.png`)).status()).toBe(200);
    const video = await request.get(`/robot-worlds/${theme.id}.mp4`, { headers: { Range: "bytes=0-1023" } });
    expect(video.status()).toBe(206);
    expect((await video.body()).byteLength).toBe(1024);
  }
});

test("Reactor edits preserve the robot, contacts and camera in every lab", () => {
  for (const room of [worldRoom(), ...worldChildren("root"), ...worldChildren("1.2")]) {
    for (const look of Object.keys(RENDER_LOOKS) as (keyof typeof RENDER_LOOKS)[]) {
      const prompt = physicsRenderPrompt(room, look, "Brushed metal and soft inspection lighting.");
      expect(prompt).toContain(room.theme.name);
      expect(prompt).toContain(room.theme.object);
      expect(prompt).toContain("contact points");
      expect(prompt).toContain("camera perspective");
      expect(prompt.length).toBeLessThanOrEqual(2000);
    }
  }
});

test("an unavailable Reactor render keeps the physical task playable and the selected gym linked", async ({ page }) => {
  let tokens = 0;
  await page.route("**/api/reactor/token?model=sana-streaming", route => {
    tokens++;
    return route.fulfill({ status: 503, json: { error: "Rendering temporarily unavailable" } });
  });
  await page.route(/https:\/\/.*reactor\.inc\//, route => route.abort());
  await page.goto("/worlds?room=1&mode=physics");
  await expect(page.getByText("Physics live", { exact: true })).toBeVisible();
  const camera = page.locator("canvas");
  expect(await camera.evaluate(canvas => [canvas.width, canvas.height])).toEqual([1280, 704]);
  await page.getByRole("button", { name: "Start high fidelity view ↗", exact: true }).click();
  const layer = page.getByTestId("reactor-physics");
  await expect(layer).toHaveAttribute("data-phase", "error");
  await expect(layer.getByRole("alert")).toContainText("Rendering temporarily unavailable");
  await expect(layer).toHaveAttribute("data-frames", "0");
  expect(tokens).toBe(1);
  const movement = page.waitForResponse(response => {
    if (!response.url().includes("/api/robot-worlds/sessions/") || response.request().method() !== "POST") return false;
    const command = response.request().postDataJSON()?.command;
    return command?.type === "action" && command.action[0] > 0;
  });
  await page.keyboard.down("ArrowRight");
  const moved = await movement;
  await page.keyboard.up("ArrowRight");
  expect(moved.status()).toBe(200);
  expect((await moved.json()).state.robot.steps).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: "Footage → Playground pipeline ↗" })).toHaveAttribute("href", /from=1(?:&|$)/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await camera.evaluate(canvas => [canvas.width, canvas.height])).toEqual([1280, 704]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
