import { test, expect } from "@playwright/test";

const idle = { status: "idle", progress: 0, message: "", error: null };
const fixture = () => ({ sources: [{ id: "3", label: "Recording 3 · doing the dishes", qc_status: "valid" }], attribution: "Footage attribution", worlds: [], tasks: [
  { id: "a:0", world_id: "0123456789abcdef", world_title: "Kitchen", title: "Lift yellow sponge", source: { id: "3", t: 1.25, task_type: "doing_the_dishes" }, grounding: "source_frame", build: idle, simulation_ready: true, training_ready: true,
    room: { path: "0", door_label: "Kitchen", jobs: { scan: { ...idle, status: "ready" }, physics: { ...idle, status: "ready" }, demo: idle, export: idle }, media: { arrival: "/robot-worlds/kitchen.png", scan: "/robot-worlds/kitchen.mp4" }, steps: [{ id: "reach" }], robot_demo: { success: true, steps_completed: 4, total_steps: 4 }, export: { download_url: "/api/worlds/example/download" }, task: { robot_task: { kind: "lift", feasible: true } } } },
  { id: "a:1", world_id: "0123456789abcdef", world_title: "Kitchen", title: "Place cup on tray", source: { id: "3", t: 6, task_type: "doing_the_dishes" }, grounding: "generated_variation", build: idle, simulation_ready: false, training_ready: false,
    room: { path: "1", door_label: "Dining room", jobs: { scan: { ...idle, status: "ready" }, physics: idle, demo: idle, export: idle }, media: { arrival: "/robot-worlds/kitchen.png" }, task: { robot_task: { kind: "place", feasible: true } } } },
] });

test("task library filters verified environments and starts a concrete build", async ({ page }) => {
  const catalog = fixture();
  await page.route("**/api/worlds/catalog", route => route.fulfill({ json: catalog }));
  let builds = 0;
  await page.route("**/api/worlds/0123456789abcdef/rooms/1/build", route => {
    builds++;
    catalog.tasks[1].build = { ...idle, status: "generating", message: "Solving the Panda task" };
    return route.fulfill({ status: 202, json: catalog.tasks[1].build });
  });
  await page.route("**/api/reactor/token**", route => route.abort());
  await page.goto("/lab");
  await expect(page.getByTestId("lab-task")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Control the robot ↗" })).toHaveAttribute("href", /view=robot/);
  await page.getByRole("button", { name: /^Training ready/ }).click();
  await expect(page.getByTestId("lab-task")).toHaveCount(1);
  await page.getByRole("button", { name: "All tasks", exact: true }).click();
  await page.getByRole("button", { name: "Build gym + render", exact: true }).click();
  await expect(page.getByText("Solving the Panda task")).toBeVisible();
  expect(builds).toBe(1);
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("missing task");
  await expect(page.getByText("No tasks match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Show all tasks" }).click();
  await expect(page.getByTestId("lab-task")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("library request failures are recoverable", async ({ page }) => {
  let fail = true;
  await page.route("**/api/worlds/catalog", route => route.fulfill(fail ? { status: 503, json: { error: "Service unavailable" } } : { json: fixture() }));
  await page.goto("/lab");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Service unavailable");
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByTestId("lab-task")).toHaveCount(2);
});
