import { test } from "node:test";
import assert from "node:assert/strict";
import { byteRange } from "../app/lib/byte-range.ts";
import { ENVIRONMENTS, childRooms, taskRoom, roomTrail, validRoomPath, generationPrompt } from "../app/lib/task-rooms.ts";

test("every room has ten stable children anchored to its original environment", () => {
  for (const environment of Object.keys(ENVIRONMENTS)) {
    let parent = taskRoom(environment);
    for (let depth = 0; depth < 6; depth++) {
      const children = childRooms(parent);
      assert.equal(children.length, 10);
      assert.equal(new Set(children.map(child => child.path)).size, 10);
      assert.deepEqual(children.map(child => child.relation), ["similar", "similar", "similar", "similar", "subskill", "subskill", "harder", "harder", "variation", "variation"]);
      for (const child of children) {
        assert.equal(child.environment, environment);
        assert.equal(child.parentPath, parent.path);
        assert.equal(child.depth, parent.depth + 1);
        assert.deepEqual(taskRoom(environment, child.path), child);
        assert.ok(generationPrompt(child).includes(ENVIRONMENTS[environment].context));
      }
      parent = children[depth % 10];
    }
    assert.equal(roomTrail(parent).length, 7);
  }
});

test("invalid and oversized room paths cannot select a task or source file", () => {
  for (const path of ["../.env", "0/1", "10", "0..1", "", "root.0", "0.".repeat(65) + "0"]) assert.equal(validRoomPath(path), false);
  assert.equal(validRoomPath("0.9.4.2"), true);
  assert.throws(() => taskRoom("kitchen", "../.env"));
});

test("media ranges support browser seeking and suffix requests", () => {
  assert.equal(byteRange(null, 1000), null);
  assert.deepEqual(byteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(byteRange("bytes=100-", 1000), { start: 100, end: 999 });
  assert.deepEqual(byteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange("bytes=900-2000", 1000), { start: 900, end: 999 });
  for (const range of ["bytes=1000-", "bytes=3-1", "bytes=-0", "bytes=0-1,4-5", "bytes=-", "bytes=9e9-", "bytes=9007199254740992-"]) assert.throws(() => byteRange(range, 1000), RangeError);
});
