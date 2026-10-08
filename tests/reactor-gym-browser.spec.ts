import { test, expect } from "@playwright/test";
import { composeGymPrompt, TASK_PHASES } from "../app/worlds/reactor-prompts";
import { WORLD_THEMES, worldChildren, worldRoom } from "../app/lib/robot-worlds";
import { connectionFailure } from "../app/worlds/reactor-connection";

const quota = { current: 10, error: "quota_exceeded", limit: 10, message: "quota exceeded: sessions_per_minute", model: "reactor/lingbot-world-2", quota_type: "sessions_per_minute", retry_after_seconds: 12 };

test("the actual SDK quota message retains Reactor's retry hint without displaying raw JSON", () => {
  const result = connectionFailure(new Error(`unexpected HTTP status 429 from create session: ${JSON.stringify(quota)}`));
  expect(result.retryable).toBe(true);
  expect(result.retryAfterMs).toBe(12_000);
  expect(result.message).not.toContain("quota_exceeded");
  expect(connectionFailure({ code: "RATE_LIMITED", status: 429, retry_after_ms: 15_000, message: "Busy" }).retryAfterMs).toBe(15_000);
  expect(connectionFailure({ status: 402, message: "Out of credits" }).retryable).toBe(false);
  expect(connectionFailure(new Error(`HTTP status 429: ${JSON.stringify({ ...quota, quota_type: "sessions_per_token" })}`)).retryable).toBe(false);
  const timeout = connectionFailure(new Error("timed out: no SDP answer after 1 polls"));
  expect(timeout.retryable).toBe(false);
  expect(timeout.message).toContain("Enter again to reconnect");
  expect(timeout.message).not.toContain("SDP");
});

async function mockSessionQuota(page: import("@playwright/test").Page, retrySeconds = 12, rejectAll = false) {
  let sessions = 0, tokens = 0;
  await page.route("**/api/reactor/token?model=lingbot-world-2", route => {
    tokens++;
    return route.fulfill({ status: 200, json: { jwt: "test-session-token", expires_at: Math.floor(Date.now() / 1000) + 3600 } });
  });
  await page.route("https://api.reactor.inc/**", route => {
    const request = route.request();
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST,GET,DELETE,OPTIONS", "retry-after": String(retrySeconds) };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.method() === "POST" && new URL(request.url()).pathname === "/sessions") {
      sessions++;
      return route.fulfill({ status: sessions === 1 || rejectAll ? 429 : 401, headers,
        json: sessions === 1 || rejectAll ? { ...quota, retry_after_seconds: retrySeconds } : { error: "unauthorized", message: "Stopped after the successful retry request" } });
    }
    return route.fulfill({ status: 503, headers, json: { error: "No real Reactor services are used in this test" } });
  });
  return { sessions: () => sessions, tokens: () => tokens };
}

test("delayed readiness and SDP answers keep polling one Reactor session", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const sessionPath = `/sessions/${id}`;
  const transportPath = `${sessionPath}/transport/webrtc`;
  const calls: string[] = [];
  let sessions = 0, readiness = 0, answers = 0, terminated = 0;
  await page.route("**/api/reactor/token?model=lingbot-world-2", route => route.fulfill({ json: { jwt: "test-session-token" } }));
  await page.route("https://api.reactor.inc/**", route => {
    const request = route.request(), method = request.method(), path = new URL(request.url()).pathname;
    calls.push(`${method} ${path}`);
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST,GET,DELETE,OPTIONS" };
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (method === "POST" && path === "/sessions") {
      sessions++;
      return route.fulfill({ status: 201, headers, json: { session_id: id, state: "created" } });
    }
    if (method === "GET" && path === sessionPath) {
      const ready = ++readiness >= 3;
      return route.fulfill({ headers, json: { session_id: id, state: ready ? "active" : "waiting",
        selected_transport: { protocol: "webrtc", version: "1.0" },
        ...(ready ? { server_info: { server_version: "1.0" }, capabilities: { protocol_version: "1.0", tracks: [{ name: "main_video", kind: "video", direction: "recvonly" }] } } : {}),
      } });
    }
    if (path === `${transportPath}/ice_servers`) return route.fulfill({ headers, json: { ice_servers: [] } });
    if (method === "POST" && path === `${transportPath}/connections`) return route.fulfill({ status: 201, headers, json: { connection_id: 1 } });
    if (method === "POST" && [`${transportPath}/connections/1/ice_candidates`, `${transportPath}/connections/1/sdp_params`].includes(path)) return route.fulfill({ headers, json: {} });
    if (method === "GET" && path === `${transportPath}/connections/1/sdp_params`) {
      // Two pending answers must not exhaust the transport budget. Stop on the
      // third poll so this regression test never needs a GPU or video stream.
      if (++answers < 3) return route.fulfill({ status: 202, headers, json: {} });
      return route.fulfill({ status: 400, headers, json: { error: "Test handshake stopped after delayed SDP checks" } });
    }
    if (method === "DELETE" && path === sessionPath) {
      terminated++;
      return route.fulfill({ status: 204, headers });
    }
    return route.fulfill({ status: 400, headers, json: { error: `Unexpected test request: ${method} ${path}` } });
  });
  await page.goto("/worlds");
  await page.getByRole("button", { name: "Enter Reactor world" }).click();
  const alert = page.getByTestId("reactor-gym").getByRole("alert");
  await expect(alert).toBeVisible();
  expect(await alert.innerText()).toContain("Test handshake stopped after delayed SDP checks");
  expect(readiness, JSON.stringify(calls)).toBe(3);
  expect(answers, JSON.stringify(calls)).toBe(3);
  expect(sessions).toBe(1);
  expect(terminated).toBe(1);
  await expect(page.getByTestId("reactor-gym")).toHaveAttribute("data-reactor-status", "disconnected");
  await expect(page.getByRole("button", { name: "Enter Reactor world" })).toBeEnabled();
});

test("a real SDK 429 waits for the quota hint and repeated clicks cannot create extra sessions", async ({ page }) => {
  await page.clock.install();
  const calls = await mockSessionQuota(page);
  await page.goto("/worlds");
  await page.getByRole("button", { name: "Enter Reactor world" }).click();
  const retry = page.getByRole("button", { name: /^Retrying in/ });
  await expect(retry).toBeDisabled();
  expect(calls.sessions()).toBe(1);
  expect(calls.tokens()).toBe(1);
  await retry.evaluate(button => { for (let i = 0; i < 20; i++) (button as HTMLButtonElement).click(); });
  await page.clock.fastForward(11_000);
  expect(calls.sessions()).toBe(1);
  await expect(page.getByTestId("reactor-gym").getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: ".task-rooms/qa/reactor-quota-cooldown.png" });
  await page.clock.fastForward(2000);
  await expect.poll(calls.sessions).toBe(2);
  await expect(page.getByTestId("reactor-gym")).toHaveAttribute("data-reactor-status", "disconnected");
  await expect(page.getByTestId("reactor-gym").getByRole("alert")).toBeVisible();
  await page.clock.fastForward(60_000);
  expect(calls.sessions()).toBe(2);
});

test("cancel and reload preserve the cooldown without reconnecting automatically", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const calls = await mockSessionQuota(page);
  await page.goto("/worlds");
  await page.getByRole("button", { name: "Enter Reactor world" }).click();
  await expect(page.getByRole("button", { name: "Cancel automatic retry" })).toBeVisible();
  await page.screenshot({ path: ".task-rooms/qa/reactor-quota-mobile.png" });
  await page.getByRole("button", { name: "Cancel automatic retry" }).click();
  await expect(page.getByRole("button", { name: /^Available in/ })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: /^Available in/ })).toBeDisabled();
  const otherTab = await page.context().newPage();
  await otherTab.goto("/worlds");
  await expect(otherTab.getByRole("button", { name: /^Available in/ })).toBeDisabled();
  await otherTab.close();
  await page.clock.fastForward(20_000);
  await expect(page.getByRole("button", { name: "Enter Reactor world" })).toBeEnabled();
  expect(calls.sessions()).toBe(1);
  expect(calls.tokens()).toBe(1);
});

test("persistent Reactor quotas stop after two automatic retries", async ({ page }) => {
  await page.clock.install();
  const calls = await mockSessionQuota(page, 1, true);
  await page.goto("/worlds");
  await page.getByRole("button", { name: "Enter Reactor world" }).click();
  await expect(page.getByRole("button", { name: /^Retrying in/ })).toBeDisabled();
  await page.clock.fastForward(7000);
  await expect.poll(calls.sessions).toBe(2);
  await expect(page.getByRole("status").filter({ hasText: "Retrying automatically (2/2)" })).toBeVisible();
  await page.clock.fastForward(13_000);
  await expect.poll(calls.sessions).toBe(3);
  await expect(page.getByRole("status").filter({ hasText: "Automatic retries have stopped" })).toBeVisible();
  await page.clock.fastForward(90_000);
  expect(calls.sessions()).toBe(3);
  await expect(page.getByRole("button", { name: "Enter Reactor world" })).toBeEnabled();
});

test("every robot scene preserves input-controlled camera and stays within the model prompt budget", () => {
  const rooms = [worldRoom(), ...worldChildren("root"), ...worldChildren("0.1.2")];
  for (const room of rooms) for (const phase of TASK_PHASES) for (const moving of [true, false]) {
    const prompt = composeGymPrompt(room, phase, moving, 123);
    expect(prompt.length).toBeLessThan(2000);
    expect(prompt).toContain(room.theme.object);
    expect(prompt).toContain("Franka Panda");
    expect(prompt).toContain(moving ? "Movement input moves the observer" : "Camera position holds still");
    expect(prompt).toContain("robot base, workbench and room landmarks keep their positions");
    expect(composeGymPrompt(room, phase, moving, 123, "Lift and place carefully. ".repeat(20)).length).toBeLessThan(2000);
  }
  expect(WORLD_THEMES).toHaveLength(11);
  expect(composeGymPrompt(worldRoom("0"), "execute")).toContain("pushing the ceramic block");
  expect(composeGymPrompt(worldRoom("1"), "execute")).toMatch(/lift(?:s|ing) the parcel/);
});

test("Reactor previews are free and entering any of ten destinations requests a live session", async ({ page }) => {
  const errors: string[] = [], calls: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", request => { if (/\/api\/(reactor\/token|robot-worlds\/sessions)/.test(request.url())) calls.push(request.url()); });
  await page.route("**/api/reactor/token?model=lingbot-world-2", route => route.fulfill({
    status: 503, json: { error: "No live session starts during this preview check" },
  }));
  await page.goto("/worlds");
  await expect(page.getByTestId("reactor-gym")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter Reactor world" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reach the object", exact: false })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Describe a robot task" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Enter (?!Reactor)/ })).toHaveCount(10);
  expect(calls).toEqual([]);
  await page.getByRole("button", { name: "Enter Cargo Hall", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cargo Hall", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter Cargo Hall", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Enter (?!Reactor)/ })).toHaveCount(10);
  await expect(page.getByTestId("reactor-gym").getByRole("alert")).toContainText("No live session starts during this preview check");
  await expect(page.getByTestId("reactor-gym")).toHaveAttribute("data-reactor-status", "disconnected");
  await expect(page.getByRole("button", { name: "Lift the object", exact: false })).toBeEnabled();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "The Glasshouse", exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("/api/reactor/token");
  expect(errors).toEqual([]);
  await page.screenshot({ path: ".task-rooms/qa/reactor-gym-preview.png" });
});

test("failed Reactor authentication never reports live robot interaction", async ({ page }) => {
  let tokens = 0;
  await page.route("**/api/reactor/token?model=lingbot-world-2", route => {
    tokens++;
    return route.fulfill({ status: 503, json: { error: "Reactor is unavailable for this check" } });
  });
  await page.goto("/worlds");
  await page.getByRole("button", { name: "Enter Reactor world" }).click();
  await expect(page.getByTestId("reactor-gym").getByRole("alert")).toContainText("Reactor is unavailable for this check");
  await expect(page.getByTestId("reactor-gym")).toHaveAttribute("data-reactor-status", "disconnected");
  await expect(page.getByTestId("reactor-gym")).toHaveAttribute("data-reactor-frames", "0");
  const reach = page.getByRole("button", { name: "Reach the object", exact: false });
  await expect(reach).toBeEnabled();
  await reach.click();
  await expect.poll(() => tokens).toBe(2);
  await expect(page.getByTestId("reactor-gym").getByRole("alert")).toContainText("Reactor is unavailable for this check");
  await expect(page.getByTestId("reactor-gym")).toHaveAttribute("data-reactor-status", "disconnected");
  await expect(page.getByTestId("reactor-gym")).toHaveAttribute("data-reactor-frames", "0");
  await expect(reach).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Enter Reactor world" })).toBeEnabled();
});

test("mobile users can enter distinct rooms without creating a physics session", async ({ page }) => {
  await page.route("**/api/reactor/token?model=lingbot-world-2", route => route.fulfill({
    status: 503, json: { error: "No live session starts during this mobile check" },
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/worlds?room=1");
  await page.getByRole("button", { name: "Show connected robot rooms", exact: true }).click();
  await page.getByRole("button", { name: "Enter Pelagic Outpost", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pelagic Outpost", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter Reactor world" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".task-rooms/qa/reactor-gym-mobile.png" });
});

test("all eleven reviewed Reactor world recordings and references are available", async ({ request }) => {
  for (const theme of WORLD_THEMES) {
    const receipt = await request.get(`/reactor-gyms/${theme.id}.json`);
    expect(receipt.status()).toBe(200);
    const data = await receipt.json();
    expect(data.status).toBe("ready");
    expect(data.walk_generation.model).toBe("reactor/lingbot-world-2");
    expect(data.review.geometry_reconstructed).toBe(false);
    expect((await request.head(`/reactor-gyms/${theme.id}.jpg`)).status()).toBe(200);
    const video = await request.get(`/reactor-gyms/${theme.id}.mp4`, { headers: { Range: "bytes=0-1023" } });
    expect(video.status()).toBe(206);
    expect((await video.body()).byteLength).toBe(1024);
  }
});
