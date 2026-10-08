import { test, expect } from "@playwright/test";

test("walk, control the robot, finish physical tasks, and export a training gym", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/worlds?mode=physics");
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByText("Physics live", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Enter / })).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Enter The Glasshouse", exact: true })).toHaveCount(0);
  const before = await page.locator("canvas").getAttribute("data-camera-position");
  await page.locator("canvas").focus();
  await page.keyboard.down("w"); await page.waitForTimeout(350); await page.keyboard.up("w");
  await expect(page.locator("canvas")).not.toHaveAttribute("data-camera-position", before!);
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Open gripper", exact: false })).toBeVisible();
  const distance = await page.getByTestId("goal-distance").innerText();
  await page.keyboard.down("ArrowRight"); await page.waitForTimeout(550); await page.keyboard.up("ArrowRight");
  await expect(page.getByTestId("goal-distance")).not.toHaveText(distance);
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
