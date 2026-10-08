import { test, expect } from "@playwright/test";
import { physicsRenderPrompt } from "../app/worlds/physics-render";
import { WORLD_THEMES, worldRoom } from "../app/lib/robot-worlds";

test("physics render directions preserve the robot, task objects and camera for every room", () => {
  for (let index = 0; index < WORLD_THEMES.length; index++) {
    const room = worldRoom(index === 0 ? "root" : String(index - 1));
    const prompt = physicsRenderPrompt(room, "studio", "Brushed steel workbench");
    expect(prompt).toContain(room.theme.object);
    expect(prompt).toContain("Franka Panda");
    expect(prompt).toContain("camera perspective");
    expect(prompt).toContain("all source motion and timing");
    expect(prompt).toContain("contact points");
    expect(prompt).toContain("Brushed steel workbench");
    expect(prompt.length).toBeLessThan(2000);
  }
});

test("full-screen Reactor rendering is explicit, and an unavailable renderer leaves physics playable", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/reactor/token?model=sana-streaming", route => {
    requests++;
    return route.fulfill({ status: 503, json: { error: "Renderer temporarily unavailable" } });
  });
  await page.route("https://api.reactor.inc/**", route => route.abort());
  await page.goto("/worlds?mode=physics");
  await expect(page.getByText("Physics live", { exact: true })).toBeVisible();
  const renderer = page.getByTestId("reactor-physics");
  await expect(renderer).toHaveAttribute("data-source-width", "1280");
  await expect(renderer).toHaveAttribute("data-source-height", "704");
  expect(requests).toBe(0);
  await page.getByRole("button", { name: "Start high fidelity view ↗", exact: true }).click();
  await expect(renderer.getByRole("alert")).toContainText("Renderer temporarily unavailable");
  await expect(renderer).toHaveAttribute("data-phase", "error");
  expect(requests).toBe(1);
  const before = await page.getByTestId("goal-distance").innerText();
  await page.locator("canvas").focus();
  await page.keyboard.down("ArrowRight"); await page.waitForTimeout(300); await page.keyboard.up("ArrowRight");
  await expect(page.getByTestId("goal-distance")).not.toHaveText(before);
  await page.getByRole("button", { name: "Enter Sunday Kitchen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sunday Kitchen", exact: true })).toBeVisible();
  await expect(page.getByText("Physics live", { exact: true })).toBeVisible();
  await expect(renderer).toHaveAttribute("data-phase", "error");
  await expect(page.getByRole("button", { name: "Retry Reactor render", exact: true })).toBeEnabled();
  expect(requests).toBe(1);
});
