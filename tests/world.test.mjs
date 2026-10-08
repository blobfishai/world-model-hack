import { test } from "node:test";
import assert from "node:assert/strict";
import { physicsToView, viewToPhysics, movePlayer, roomAt, walkingRoute, canStand } from "../app/play/movement.ts";

test("camera and interaction coordinates round-trip between physics and rendering", () => {
  for (const point of [[-7, 4.5, 1.1], [7, -1.5, 1.68], [0, 0, 0]]) {
    assert.deepEqual(viewToPhysics(physicsToView(point)), point);
  }
  assert.deepEqual(physicsToView([0, 2, 1]), [0, 1, -2]);
});

test("capsule movement cannot tunnel through walls and can slide along them", () => {
  const walls = [{ x: 0, y: 0, width: .2, depth: 8 }];
  const stopped = movePlayer([-1, 0, 0], 4, 0, walls);
  assert.ok(stopped[0] < -.37);
  const slid = movePlayer([-1, 0, 0], 2, 2, walls);
  assert.ok(slid[0] < -.37 && slid[1] > 1.9);
  assert.equal(canStand(0, 0, walls), false);
});

test("door openings admit the player while their walls block adjacent paths", () => {
  const doorway = [{ x: -2, y: 0, width: 2.2, depth: .18 }, { x: 2, y: 0, width: 2.2, depth: .18 }];
  assert.ok(movePlayer([0, -1, 0], 0, 3, doorway)[1] > 1.9);
  assert.ok(movePlayer([1.5, -1, 0], 0, 3, doorway)[1] < -.3);
});

test("room navigation follows the shared corridor rather than crossing partitions", () => {
  assert.deepEqual(walkingRoute([-7, 2.6, 0], 7), [[-7, .8], [-7, -1.5], [7, -1.5], [7, 2.65]]);
  assert.equal(roomAt(-7, 2), "dishes");
  assert.equal(roomAt(0, 2), "laundry");
  assert.equal(roomAt(7, 2), "drawing");
  assert.equal(roomAt(3, -1.5), null);
});
