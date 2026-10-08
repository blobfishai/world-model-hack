import { test, expect, type Page } from "@playwright/test";

// Fully mocked: /api/worlds/** never reaches Python, the Reactor token route returns 503, and reactor.inc is blocked.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
// A 1×1 JPEG, standing in for the robot simulation's MuJoCo frames.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const WORLD_ID = "a1b2c3d4e5f60718";
// Optional QA captures: WORLD_SCREENSHOTS=.task-rooms/qa pnpm test:reactor-world-browser
const shots = process.env.WORLD_SCREENSHOTS;
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/reactor-world-${name}.png` }); };

const job = (status = "idle", progress = 0) => ({ status, progress, message: status === "generating" ? "Recording LingBot scan" : "", error: null, updated_at: null });

function room(path: string, title: string, relation: string, bearing: number, extra: Record<string, unknown> = {}) {
  const hub = path === "root";
  return {
    path, parent: hub ? null : "root", children: hub ? ["0", "1", "2", "3", "4", "5"] : [], depth: hub ? 0 : 1,
    title, relation, door_label: title, bearing, prompt: `A first-person view of ${title.toLowerCase()} in the same warm kitchen.`,
    camera_pitch_hint: "down", seed: 11,
    task: { title, goal: `${title} using what is visible in the beginning image.`,
      objects: [{ id: "sponge", label: "green sponge", kind: "box", size: [0.1, 0.07, 0.04] }],
      robot_task: { kind: "place", object: "sponge", anchor: "sink", relation: "beside", feasible: true, reason: null } },
    jobs: { scan: job("ready", 100), physics: job(), export: job(), children: job(), demo: job() },
    media: { arrival: `/api/worlds/${WORLD_ID}/rooms/${path}/media/arrival`, scan: null, storyboard: null, preview: null, demo: null, demo_reactor: null },
    physics: null, export: null, robot_demo: null, ...extra,
  };
}

const ROOMS = {
  root: room("root", "Kitchen sink", "source", 0),
  "0": room("0", "Rinse the plate", "similar", -60),
  "1": room("1", "Stack the clean plates", "similar", -30),
  "2": room("2", "Put the sponge beside the sink", "subskill", 0, {
    jobs: { scan: job("ready", 100), physics: job("ready", 100), export: job(), children: job(), demo: job() },
    physics: { revision: "abcdef1234567890", objects: 9, valid: true, goal: [0.3, 0.1, 0.92] },
  }),
  "3": room("3", "Dry a bowl", "harder", 30, {
    jobs: { scan: job("generating", 40), physics: job(), export: job(), children: job(), demo: job() },
    media: { arrival: null, scan: null, storyboard: null, preview: null, demo: null, demo_reactor: null },
  }),
  "4": room("4", "Load the drying rack", "harder", 60, {
    jobs: { scan: job("queued"), physics: job(), export: job(), children: job(), demo: job() },
    media: { arrival: null, scan: null, storyboard: null, preview: null, demo: null, demo_reactor: null },
  }),
  // A fully verified gym room: physics, a solved scripted demo with its Reactor render, and passing Playground checks.
  "5": room("5", "Wash a mug", "variation", 75, {
    jobs: { scan: job("ready", 100), physics: job("ready", 100), export: job("ready", 100), children: job(), demo: job("ready", 100) },
    media: { arrival: `/api/worlds/${WORLD_ID}/rooms/5/media/arrival`, scan: null, storyboard: null, preview: null,
      demo: `/api/worlds/${WORLD_ID}/rooms/5/media/demo`, demo_reactor: `/api/worlds/${WORLD_ID}/rooms/5/media/demo_reactor` },
    physics: { revision: "fedcba9876543210", objects: 7, valid: true, goal: [0.2, 0.3, 0.92] },
    export: { feasible: true, reason: null, env_name: "PandaPickCubeRoom_a1b2c3d4_5", download_url: `/api/worlds/${WORLD_ID}/rooms/5/playground/download`,
      checks: { passed: true, scripted_demo_success: true, compiled: true } },
    robot_demo: { success: true, steps_completed: 6, total_steps: 6, seconds: 11.52, reactor: true, reactor_error: null, reactor_session_id: "s-1" },
  }),
};

const WORLD = {
  id: WORLD_ID, version: 1, status: "ready", error: null,
  source: { id: "3", file: "data/000/3_video.mp4", t: 1, task_type: "doing_the_dishes" },
  hub_title: "Kitchen sink", summary: "A stainless sink full of dishes.",
  start_url: `/api/worlds/${WORLD_ID}/rooms/root/media/start`, rooms: ROOMS, arrival_strategy: "walk",
  created_at: "2026-10-08T17:30:00Z", updated_at: "2026-10-08T17:30:00Z",
  attribution: "Eidon AI / Solidic Labs Inc · Egocentric POV · CC-BY-4.0",
};

const STEP_IDS = ["reach", "grasp", "lift", "carry", "place", "release"];
const robotState = (done = 0) => ({
  type: "state", mode: "manual", time: 1.2 + done, ticks: 30, success: done === STEP_IDS.length,
  steps: STEP_IDS.map((id, index) => ({ id, kind: id, title: `Check ${id}`, done: index < done, current: index === done })),
  metrics: { goal_distance_m: 0.275, object_raised_m: 0, gripper_to_object_m: 0.2, contact: "none", gripper: "open" },
  gripper_target: [0.6, 0, 0.3],
});
const ROBOT_SESSION = {
  id: "robot-1", width: 960, height: 540, fps: 25, kind: "place", state: robotState(),
  layout: { spawn: [[0.5, -0.1, 0.02], [0.6, 0.1, 0.02]], goal: [[0.4, 0.1, 0.02], [0.45, 0.15, 0.02]], support: "counter", object: "sponge", base_side: "front" },
};

const SOURCES = {
  sources: [
    { id: "3", file: "data/000/3_video.mp4", label: "Recording 3", task_type: "doing_the_dishes", duration: 51.1, width: 1920, height: 1080, fps: 30,
      poster_url: "/api/worlds/sources/3/frame?t=0&w=480" },
    { id: "592", file: "data/000/592_video.mp4", label: "Recording 592", task_type: "drawing", duration: 23.3, width: 1280, height: 720, fps: 30,
      poster_url: "/api/worlds/sources/592/frame?t=0&w=480" },
  ],
  reactor_configured: true, planner_configured: true, playground_available: true,
  attribution: "Eidon AI / Solidic Labs Inc · Egocentric POV · CC-BY-4.0",
};

async function mockWorld(page: Page, calls: string[], { planningPolls = 0 } = {}) {
  const rooms: Record<string, ReturnType<typeof room>> = structuredClone(ROOMS);
  let planning = planningPolls;
  await page.route(/reactor\.inc/, route => route.abort());
  await page.route("**/api/reactor/token**", route => route.fulfill({ status: 503, json: { error: "REACTOR_API_KEY is not set on the server" } }));
  await page.route(url => url.pathname.startsWith("/api/worlds"), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/worlds/, "");
    calls.push(`${request.method()} ${path}${url.search}`);
    if (path.endsWith("/frame") || path.includes("/media/")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    if (path === "/sources") return route.fulfill({ json: SOURCES });
    if (path === "" && request.method() === "POST") return route.fulfill({ status: 202, json: { ...WORLD, status: "planning", rooms: {} } });
    if (path === `/${WORLD_ID}`) {
      if (planning > 0) { planning -= 1; return route.fulfill({ json: { ...WORLD, status: "planning", rooms: {} } }); }
      return route.fulfill({ json: { ...WORLD, rooms } });
    }
    if (/^\/[^/]+\/rooms\/[^/]+\/robot$/.test(path) && request.method() === "POST") return route.fulfill({ status: 201, json: ROBOT_SESSION });
    if (path.startsWith("/robot-sessions/") && request.method() === "DELETE") return route.fulfill({ json: { closed: true } });
    const action = path.match(/^\/[^/]+\/rooms\/([^/]+)\/(scan|physics|playground|children|demo)$/);
    if (action && request.method() === "POST") {
      const roomPath = decodeURIComponent(action[1]);
      const key = action[2] === "playground" ? "export" : action[2];
      rooms[roomPath] = { ...rooms[roomPath], jobs: { ...rooms[roomPath].jobs, [key]: job("queued") } };
      return route.fulfill({ json: rooms[roomPath] });
    }
    return route.fulfill({ status: 404, json: { detail: "Not mocked" } });
  });
}

test("pick a beginning image, walk through a door, and request a Playground export", async ({ page }) => {
  const calls: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await mockWorld(page, calls, { planningPolls: 2 });
  await page.goto("/world");

  await expect(page.getByRole("heading", { name: "Start from the first frame of a recording." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create world" })).toBeDisabled();
  await page.getByRole("button", { name: /Recording 3/ }).click();
  const slider = page.getByRole("slider", { name: "Beginning image time in seconds" });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".rw-scrubber b")).toHaveText("1.0 s");
  await expect(page.getByRole("img", { name: "Beginning image of Recording 3 at 1.0 seconds" })).toBeVisible();
  await shoot(page, "picker");

  await page.getByRole("button", { name: "Create world" }).click();
  await expect(page.getByRole("heading", { name: "Reading the beginning image…" })).toBeVisible();
  expect(calls).toContain("POST ");
  await expect(page.getByRole("heading", { level: 1, name: "Kitchen sink" })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`w=${WORLD_ID}&room=root$`));
  expect(calls.filter(call => call === `GET /${WORLD_ID}`).length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("reactor-world-status")).toContainText("Offline preview");

  // Doors are waypoints over the view: ±35° of the heading are visible, the rest wait on the compass and map.
  await expect(page.getByRole("button", { name: "Enter Put the sponge beside the sink" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter Dry a bowl" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter Rinse the plate" })).toHaveCount(0);
  await shoot(page, "hub");

  const marker = page.locator(".rw-map-player");
  const before = await marker.getAttribute("transform");
  await page.keyboard.down("w");
  await expect.poll(() => marker.getAttribute("transform")).not.toBe(before);
  await expect(page).toHaveURL(/room=2$/, { timeout: 8_000 });
  await page.keyboard.up("w");
  await expect(page.getByRole("heading", { level: 1, name: "Put the sponge beside the sink" })).toBeVisible();

  const panel = page.getByRole("complementary", { name: "Task details" });
  await expect(panel.getByRole("heading", { name: "Put the sponge beside the sink" })).toBeVisible();
  const exportButton = panel.getByRole("button", { name: "Export to MuJoCo Playground" });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect.poll(() => calls).toContain(`POST /${WORLD_ID}/rooms/2/playground`);
  await shoot(page, "room");
  await expect(panel.getByText("Queued").first()).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Kitchen sink" })).toBeVisible();
  await expect(page).toHaveURL(/room=root$/);

  await page.getByRole("button", { name: "Enter Dry a bowl" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dry a bowl" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export to MuJoCo Playground" })).toBeDisabled();
  await page.getByRole("button", { name: "Return to parent room" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Kitchen sink" })).toBeVisible();

  // Walking into a room Reactor has not finished asks the backend to prioritize its scan.
  await panel.getByRole("button", { name: "Go to Load the drying rack" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Load the drying rack" })).toBeVisible();
  if (await page.getByRole("button", { name: "Enter Reactor world" }).isEnabled()) {
    await expect.poll(() => calls).toContain(`POST /${WORLD_ID}/rooms/4/scan?priority=1`);
  }
  expect(calls.filter(call => call.includes("/sessions"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("a failed Reactor token leaves the world explorable offline", async ({ page }) => {
  const calls: string[] = [];
  await mockWorld(page, calls);
  await page.goto(`/world?w=${WORLD_ID}&room=root`);
  await expect(page.getByRole("heading", { level: 1, name: "Kitchen sink" })).toBeVisible();
  const enter = page.getByRole("button", { name: "Enter Reactor world" });
  test.skip(await enter.isDisabled(), "REACTOR_API_KEY is not configured for this dev server");
  await enter.click();
  await expect(page.getByRole("alert").filter({ hasText: /REACTOR_API_KEY|token/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Enter Put the sponge beside the sink" })).toBeVisible();
});

test("mobile layout keeps touch walking and the door list", async ({ page }) => {
  const calls: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorld(page, calls);
  await page.goto(`/world?w=${WORLD_ID}&room=root`);
  await expect(page.getByRole("heading", { level: 1, name: "Kitchen sink" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hold w" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Task details" })).toHaveCount(0);
  await page.getByRole("button", { name: "Task details" }).click();
  await page.getByRole("complementary", { name: "Task details" }).getByRole("button", { name: "Go to Wash a mug" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Wash a mug" })).toBeVisible();
  await expect(page).toHaveURL(/room=5$/);
  await shoot(page, "mobile");
  const body = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(body.width).toBeLessThanOrEqual(body.viewport);
});

test("the robot simulation streams MuJoCo frames, takes keyboard commands, and falls back from Reactor", async ({ page }) => {
  const calls: string[] = [];
  const sent: Record<string, unknown>[] = [];
  let done = 0;
  await mockWorld(page, calls);
  await page.routeWebSocket(/\/worlds\/robot-sessions\//, ws => {
    ws.onMessage(message => sent.push(JSON.parse(String(message))));
    const timer = setInterval(() => {
      ws.send(JPEG);
      ws.send(JSON.stringify(robotState(done)));
    }, 100);
    ws.onClose(() => clearInterval(timer));
  });
  await page.goto(`/world?w=${WORLD_ID}&room=2`);
  await expect(page.getByRole("heading", { level: 1, name: "Put the sponge beside the sink" })).toBeVisible();
  await page.getByRole("button", { name: "Robot simulation", exact: true }).click();

  const bar = page.getByRole("region", { name: "Your robot task" });
  await expect(bar.getByRole("heading", { name: "Place the green sponge beside the sink" })).toBeVisible();
  await expect(bar.getByText("Real task — from the beginning image of data/000/3_video.mp4")).toBeVisible();
  await expect(bar.getByText("REWARD CHECKED BY CODE — MUJOCO STEP CHECKS")).toBeVisible();
  await expect(page.getByTestId("robot-physics-status")).toContainText("Physics live");
  await expect(page.getByRole("button", { name: "Show the Reactor world" })).toBeVisible();
  expect(calls).toContain(`POST /${WORLD_ID}/rooms/2/robot`);

  await page.keyboard.down("ArrowUp");
  await expect.poll(() => sent).toContainEqual({ type: "move", axes: { x: 1, y: 0, z: 0 } });
  await page.keyboard.up("ArrowUp");
  await expect.poll(() => sent).toContainEqual({ type: "move", axes: { x: 0, y: 0, z: 0 } });
  await page.keyboard.press(" ");
  await expect.poll(() => sent).toContainEqual({ type: "gripper", closed: true });
  await expect(bar.getByRole("button", { name: /Open gripper/ })).toBeVisible();
  const pad = bar.getByRole("button", { name: "Raise (R)" });
  await pad.dispatchEvent("pointerdown", { pointerId: 1, button: 0 });
  await expect.poll(() => sent).toContainEqual({ type: "move", axes: { x: 0, y: 0, z: 1 } });
  await pad.dispatchEvent("pointerup", { pointerId: 1 });
  await bar.getByRole("button", { name: "▷ Watch demo" }).click();
  await expect.poll(() => sent).toContainEqual({ type: "demo" });

  done = STEP_IDS.length;
  await expect(bar.getByText("Task complete · 6/6 steps")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Task details" }).getByText("Task complete · 6/6 steps")).toBeVisible();

  // Reactor is mocked unavailable (token 503): the simulation stays on the physics view and says so.
  const live = page.getByRole("button", { name: "Live Reactor" });
  if (await live.isEnabled()) {
    await expect(page.getByRole("alert").filter({ hasText: "Reactor render unavailable" })).toBeVisible();
    await expect(live).toHaveAttribute("aria-pressed", "false");
  }
  await expect(page.getByRole("img", { name: /MuJoCo physics of the Franka Panda/ })).toBeVisible();
  await shoot(page, "robot");

  // Walking keys belong to the robot while the simulation has the stage; Esc hands them back to the world.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Reactor world", pressed: true })).toBeVisible();
  await expect.poll(() => calls).toContain("DELETE /robot-sessions/robot-1");
  await expect(page.getByRole("region", { name: "Your robot task" })).toHaveCount(0);
});

test("verified rooms show gym badges, demo videos, and the hub catalog", async ({ page }) => {
  const calls: string[] = [];
  await mockWorld(page, calls);
  await page.goto(`/world?w=${WORLD_ID}&room=5`);
  const panel = page.getByRole("complementary", { name: "Task details" });
  await expect(panel.getByRole("heading", { name: "Wash a mug" })).toBeVisible();
  const badges = panel.getByRole("list", { name: "Verification for Wash a mug" }).first();
  for (const label of ["Scripted demo verified 6/6", "Physics validated", "Playground checks passed", "Reactor render"]) {
    await expect(badges.getByText(label)).toBeVisible();
  }
  await expect(panel.getByText("TRAINING GYM — MUJOCO PLAYGROUND (MJX)")).toBeVisible();
  await expect(panel.getByText("REALISTIC WORLD — REACTOR LINGBOT WORLD 2")).toBeVisible();
  await expect(panel.locator("video[aria-label^='MuJoCo simulation of the scripted demo']")).toBeVisible();
  await expect(panel.locator("video[aria-label^='Reactor render of the scripted demo']")).toBeVisible();
  await expect(panel.getByText(/Scripted demo: 6\/6 steps in 11\.5 s · solved · Reactor render ready/)).toBeVisible();
  await panel.getByRole("button", { name: "Render the demo again" }).click();
  await expect.poll(() => calls).toContain(`POST /${WORLD_ID}/rooms/5/demo`);
  await shoot(page, "verified");

  await page.getByRole("button", { name: "Return to parent room" }).click();
  const catalog = panel.getByRole("list").filter({ has: page.getByText("Wash a mug") }).first();
  await expect(panel.getByText(/GYM CATALOG · 7 TASK ROOMS/)).toBeVisible();
  await expect(catalog.getByText("Scripted demo verified 6/6")).toBeVisible();
  await expect(catalog.getByText("No checks yet").first()).toBeVisible();
  await catalog.getByRole("button", { name: /Wash a mug/ }).click();
  await expect(page).toHaveURL(/room=5$/);
});
