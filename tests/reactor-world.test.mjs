import { test } from "node:test";
import assert from "node:assert/strict";
import { IDLE_AXES, actionString, axesFromInput, diffAxes, isTypingTarget, rotationSpeedFor } from "../app/world/lib/controls.ts";
import { BACK_RING, DOOR_RING, ENTER_RADIUS, ORIGIN, doorAhead, doorLayout, integrate, nearestDoor, normalizeDegrees,
  parseAction, projectBearing, relativeBearing, simulatedChunk, spreadBearings } from "../app/world/lib/navigation.ts";

const close = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≉ ${expected}`);

test("keys and drags map onto LingBot axes; opposing keys cancel", () => {
  assert.deepEqual(axesFromInput([]), IDLE_AXES);
  assert.deepEqual(axesFromInput(["W", "d", "ArrowLeft", "r"]),
    { move_longitudinal: "forward", move_lateral: "strafe_right", look_horizontal: "left", look_vertical: "up" });
  assert.equal(axesFromInput(["w", "s"]).move_longitudinal, "idle");
  assert.equal(axesFromInput(["ArrowUp"]).move_longitudinal, "forward");
  assert.equal(axesFromInput(["ArrowDown", "a"]).move_lateral, "strafe_left");
  const dragged = axesFromInput(["ArrowLeft"], { dx: 12, dy: -9 });
  assert.equal(dragged.look_horizontal, "right");
  assert.equal(dragged.look_vertical, "up");
  assert.equal(axesFromInput([], { dx: 2, dy: 1 }).look_horizontal, "idle");
});

test("only changed axes become commands, in a stable order", () => {
  assert.deepEqual(diffAxes(IDLE_AXES, IDLE_AXES), []);
  const walking = axesFromInput(["w"]);
  assert.deepEqual(diffAxes(IDLE_AXES, walking), [{ method: "setMoveLongitudinal", params: { move_longitudinal: "forward" } }]);
  const turning = axesFromInput(["w", "arrowright"]);
  assert.deepEqual(diffAxes(walking, turning), [{ method: "setLookHorizontal", params: { look_horizontal: "right" } }]);
  assert.deepEqual(diffAxes(turning, IDLE_AXES).map(command => command.method), ["setMoveLongitudinal", "setLookHorizontal"]);
  assert.equal(rotationSpeedFor(false), 5);
  assert.equal(rotationSpeedFor(true), 10);
  assert.equal(actionString(turning), "w+right");
  assert.equal(actionString(IDLE_AXES), "still");
});

test("typing targets and dialogs never steer the world", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "textarea" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON", closest: selector => selector.includes("dialog") ? {} : null }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON", closest: () => null }), false);
  assert.equal(isTypingTarget(null), false);
});

test("dead reckoning follows reported chunk actions; right turns are positive like door bearings", () => {
  assert.deepEqual(parseAction("w+left"), { forward: 1, strafe: 0, turn: -1, tilt: 0 });
  assert.deepEqual(parseAction("still"), { forward: 0, strafe: 0, turn: 0, tilt: 0 });
  let pose = integrate(ORIGIN, { active_action: "w", frames_emitted: 12 }, 5);
  close(pose.x, 0); close(pose.z, 0.42);
  pose = integrate(pose, { active_action: "right", frames_emitted: 24 }, 5); // one 0.5 s chunk: 3 latent frames × 5°
  close(pose.yaw, 15);
  pose = integrate({ ...ORIGIN, yaw: 90 }, { active_action: "w", frames_emitted: 12 }, 5);
  close(pose.x, 0.42); close(pose.z, 0);
  pose = integrate(ORIGIN, { active_action: "d", frames_emitted: 12 }, 5);
  close(pose.x, 0.42); close(pose.z, 0);
  const diagonal = integrate(ORIGIN, { active_action: "w+d", frames_emitted: 12 }, 5);
  close(Math.hypot(diagonal.x, diagonal.z), 0.42);
  let tilted = ORIGIN;
  for (let i = 0; i < 20; i++) tilted = integrate(tilted, { active_action: "up", frames_emitted: 12 }, 30);
  assert.equal(tilted.pitch, 60);
  let far = ORIGIN;
  for (let i = 0; i < 100; i++) far = integrate(far, { active_action: "w", frames_emitted: 12 }, 5);
  assert.ok(Math.hypot(far.x, far.z) <= 4.6 + 1e-9);
  assert.equal(normalizeDegrees(190), -170);
  assert.equal(normalizeDegrees(-180), 180);
});

test("doors sit on a ring at their bearings with a back door behind child rooms", () => {
  const children = spreadBearings(6).map((bearing, index) => ({ path: String(index), label: `Room ${index}`, bearing }));
  assert.deepEqual(spreadBearings(6), [-75, -45, -15, 15, 45, 75]);
  const doors = doorLayout(children, { path: "root", label: "Back", bearing: 0 });
  assert.equal(doors.length, 7);
  for (const door of doors.slice(0, 6)) close(Math.hypot(door.x, door.z), DOOR_RING);
  const back = doors.at(-1);
  assert.equal(back.kind, "back"); assert.equal(back.bearing, 180); close(back.z, -BACK_RING);
  // Rooms with a Back door keep children ahead; the hub (no parent) can place doors behind the player.
  assert.equal(doorLayout([{ path: "0", label: "Far", bearing: 170 }], { path: "root", label: "Back", bearing: 0 })[0].bearing, 75);
  const behind = doorLayout([{ path: "0", label: "Behind", bearing: 165 }], null)[0];
  assert.equal(behind.bearing, 165);
  assert.ok(behind.z < 0);
  const right = doors[3]; // +15°
  close(right.x, DOOR_RING * Math.sin(15 * Math.PI / 180));
  close(relativeBearing(ORIGIN, right), 15);
  close(relativeBearing({ ...ORIGIN, yaw: 15 }, right), 0);
});

test("walking into a door's radius enters it; the nearest door ahead is offered", () => {
  const doors = doorLayout([{ path: "2", label: "Ahead", bearing: 0 }, { path: "3", label: "Right", bearing: 45 }], null);
  let pose = ORIGIN;
  let entered = null;
  for (let i = 0; i < 40 && !entered; i++) {
    pose = integrate(pose, simulatedChunk("w"), 5);
    entered = nearestDoor(pose, doors);
  }
  assert.equal(entered?.path, "2");
  assert.ok(Math.hypot(pose.x - entered.x, pose.z - entered.z) <= ENTER_RADIUS);
  assert.equal(nearestDoor(ORIGIN, doors), null);
  assert.equal(doorAhead({ x: 0, z: 1.6, yaw: 0, pitch: 0 }, doors)?.path, "2");
  assert.equal(doorAhead({ x: 0, z: 1.6, yaw: 180, pitch: 0 }, doors), null);
});

test("bearings project into a 70° view and vanish outside it", () => {
  close(projectBearing(0), 0.5);
  close(projectBearing(35), 1);
  close(projectBearing(-35), 0);
  assert.ok(projectBearing(10) > 0.5 && projectBearing(10) < 1);
  assert.equal(projectBearing(36), null);
  assert.equal(projectBearing(-120), null);
});

// --- Robot task simulation, Reactor render policy, and training-gym badges ---
import { ROBOT_IDLE, contactLabel, coverRect, robotAxesFromKeys, robotTaskTitle, sameAxes, simulationPrompt, stepSummary,
  taskProgram } from "../app/world/lib/robot.ts";
import { CAPACITY_RETRY_SECONDS, capacityRetryDelay, formatCost, isCapacityError } from "../app/world/lib/reactor.ts";
import { gymCatalog, roomBadges } from "../app/world/lib/rooms.ts";

const placeTask = {
  title: "Put the sponge beside the bowl", goal: "The sponge rests next to the bowl.",
  objects: [{ id: "green_sponge", label: "green sponge", kind: "box", size: [0.09, 0.06, 0.04] },
    { id: "white_bowl", label: "white bowl", kind: "bowl", size: [0.2, 0.2, 0.08] }],
  robot_task: { kind: "place", object: "green_sponge", anchor: "white_bowl", relation: "beside", feasible: true, reason: null },
};

test("arrows, R and F drive the gripper in the robot frame; opposing keys cancel", () => {
  assert.deepEqual(robotAxesFromKeys([]), ROBOT_IDLE);
  assert.deepEqual(robotAxesFromKeys(["ArrowUp"]), { x: 1, y: 0, z: 0 });
  assert.deepEqual(robotAxesFromKeys(["arrowdown", "ArrowLeft", "r"]), { x: -1, y: 1, z: 1 });
  assert.deepEqual(robotAxesFromKeys(["ArrowRight", "f"]), { x: 0, y: -1, z: -1 });
  assert.deepEqual(robotAxesFromKeys(["ArrowUp", "ArrowDown", "r", "f"]), ROBOT_IDLE);
  assert.ok(sameAxes({ x: 1, y: 0, z: 0 }, robotAxesFromKeys(["arrowup"])));
  assert.ok(!sameAxes(ROBOT_IDLE, { x: 0, y: 0, z: 1 }));
});

test("robot task titles and the step program use labels and mirror the server's program", () => {
  assert.equal(robotTaskTitle(placeTask), "Place the green sponge beside the white bowl");
  assert.equal(robotTaskTitle({ ...placeTask, robot_task: { kind: "lift", object: "green_sponge", anchor: null, relation: null, feasible: true, reason: null } }),
    "Lift the green sponge");
  assert.equal(robotTaskTitle({ ...placeTask, objects: [], robot_task: { ...placeTask.robot_task, object: "dish_soap" } }),
    "Place the dish soap beside the white bowl");
  assert.equal(robotTaskTitle({ ...placeTask, robot_task: null }), null);
  const place = taskProgram(placeTask);
  assert.deepEqual(place.map(step => step.kind), ["reach", "grasp", "lift", "carry", "place", "release"]);
  assert.equal(place[0].title, "Reach the green sponge");
  assert.equal(place[3].title, "Carry it next to the white bowl");
  assert.equal(place[4].title, "Set it down beside the white bowl");
  assert.deepEqual(place.map(step => step.current), [true, false, false, false, false, false]);
  const lift = taskProgram({ ...placeTask, robot_task: { kind: "lift", object: "green_sponge", anchor: null, relation: null, feasible: true, reason: null } });
  assert.deepEqual(lift.map(step => step.id), ["reach", "grasp", "lift", "hold"]);
  assert.equal(lift[2].title, "Lift it 15 cm off the surface");
});

test("step summaries, contact labels and the Reactor canvas fit", () => {
  const steps = taskProgram(placeTask).map((step, index) => ({ ...step, done: index < 2, current: index === 2 }));
  assert.deepEqual(stepSummary(steps), { done: 2, total: 6, current: 2, complete: false });
  assert.equal(stepSummary(steps.map(step => ({ ...step, done: true, current: false }))).complete, true);
  assert.equal(contactLabel({ contact: "both fingers", gripper: "closed" }), "Grasped");
  assert.equal(contactLabel({ contact: "one finger", gripper: "closed" }), "One finger");
  assert.equal(contactLabel({ contact: "none", gripper: "open" }), "Ready to grasp");
  // 960×540 MuJoCo frames cover the fixed 1280×704 SANA camera track, cropping 8 px top and bottom.
  assert.deepEqual(coverRect(960, 540, 1280, 704), { x: 0, y: -8, width: 1280, height: 720 });
  const tall = coverRect(704, 1280, 1280, 704);
  assert.equal(tall.width, 1280);
  assert.ok(tall.height > 704 && tall.y < 0);
  const prompt = simulationPrompt({ prompt: "A sunlit tiled kitchen.", task: placeTask }, "kitchen_counter");
  assert.ok(prompt.startsWith("Photorealistic footage of this room: A sunlit tiled kitchen."));
  assert.ok(prompt.includes("works at the kitchen counter: Place the green sponge beside the white bowl."));
  assert.ok(prompt.includes("restyle only materials, textures and lighting"));
});

test("only Reactor capacity and quota errors are retried, after 10, 20 and 40 seconds", () => {
  assert.ok(isCapacityError('unexpected HTTP status 429 from create session: {"error":"no available capacity: no available servers"}'));
  assert.ok(isCapacityError("quota exceeded: sessions_per_minute"));
  assert.ok(isCapacityError("Reactor needs a short break before starting another world. (429 RATE_LIMITED)"));
  assert.ok(!isCapacityError("REACTOR_API_KEY is not set on the server (503)"));
  assert.ok(!isCapacityError(null));
  assert.deepEqual(CAPACITY_RETRY_SECONDS.map((_, attempt) => capacityRetryDelay(attempt)), [10, 20, 40]);
  assert.equal(capacityRetryDelay(3), null);
  assert.equal(formatCost(60, 0.0017), "$0.10");
});

test("gym badges show verified evidence only, and the catalog lists the hub first", () => {
  const job = { status: "ready", progress: 100, message: "", error: null, updated_at: null };
  const base = { path: "0", parent: "root", children: [], depth: 1, title: "t", relation: "similar", door_label: "d", bearing: 0, prompt: "p",
    camera_pitch_hint: "level", seed: 1, task: placeTask, jobs: { scan: job, physics: job, export: job, children: job, demo: job },
    media: {}, physics: null, export: null, robot_demo: null };
  assert.deepEqual(roomBadges(base), []);
  const verified = { ...base, physics: { revision: "r", objects: 3, valid: true, goal: null },
    robot_demo: { success: true, steps_completed: 6, total_steps: 6, seconds: 11.52, reactor: true, reactor_error: null, reactor_session_id: "s" },
    export: { feasible: true, reason: null, env_name: "PandaPickCubeRoom_x_0", download_url: "/x", checks: { passed: true, scripted_demo_success: true } } };
  assert.deepEqual(roomBadges(verified).map(badge => badge.label),
    ["Scripted demo verified 6/6", "Physics validated", "Playground checks passed", "Reactor render"]);
  assert.equal(roomBadges(verified)[0].detail, "11.5 s");
  assert.equal(roomBadges(verified)[2].detail, "scripted demo ✓");
  const failed = { ...verified, robot_demo: { ...verified.robot_demo, success: false, reactor: false }, export: { ...verified.export, checks: { passed: false } } };
  assert.deepEqual(roomBadges(failed).map(badge => badge.id), ["physics"]);
  const world = { rooms: { "1": { ...base, path: "1" }, "0.2": { ...base, path: "0.2" }, root: { ...base, path: "root" }, "0": base } };
  assert.deepEqual(gymCatalog(world).map(room => room.path), ["root", "0", "0.2", "1"]);
});

import { ASSIST_ANGLE, aimAssist } from "../app/world/lib/navigation.ts";

test("a 1 m enter radius plus aim assist lets a walk aimed within 25° of a door reach it", () => {
  assert.equal(ENTER_RADIUS, 1);
  assert.equal(ASSIST_ANGLE, 25);
  const doors = doorLayout([{ path: "0", label: "Pantry", bearing: 115 }, { path: "1", label: "Hall", bearing: -60 }], null);
  const walk = { active_action: "w", frames_emitted: 24 };
  // Facing 90°, the pantry door is 25° to the right: walking straight passes it 1.35 m away.
  let straight = { x: 0, z: 0, yaw: 90, pitch: 0 }, closest = Infinity;
  for (let i = 0; i < 10; i++) {
    straight = integrate(straight, walk, 5);
    closest = Math.min(closest, Math.hypot(straight.x - doors[0].x, straight.z - doors[0].z));
  }
  assert.ok(closest > ENTER_RADIUS);
  // With the assist (steer, then step) the same walk reaches the door.
  let pose = { x: 0, z: 0, yaw: 90, pitch: 0 }, entered = null;
  for (let i = 0; i < 10 && !entered; i++) {
    pose = integrate(aimAssist(pose, walk, doors), walk, 5);
    entered = nearestDoor(pose, doors);
  }
  assert.equal(entered?.path, "0");
  // At most 8° per 0.5 s chunk, only while walking forward, only within ±25°.
  close(aimAssist({ x: 0, z: 0, yaw: 100, pitch: 0 }, walk, doors).yaw, 108);
  close(aimAssist({ x: 0, z: 0, yaw: 112, pitch: 0 }, walk, doors).yaw, 115);
  assert.equal(aimAssist({ x: 0, z: 0, yaw: 90, pitch: 0 }, { active_action: "still", frames_emitted: 24 }, doors).yaw, 90);
  assert.equal(aimAssist({ x: 0, z: 0, yaw: 90, pitch: 0 }, { active_action: "s", frames_emitted: 24 }, doors).yaw, 90);
  assert.equal(aimAssist({ x: 0, z: 0, yaw: 85, pitch: 0 }, walk, doorLayout([{ path: "0", label: "P", bearing: 115 }], null)).yaw, 85);
});
