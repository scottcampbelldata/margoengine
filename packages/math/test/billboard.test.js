import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from '../dist/index.js';
import { billboardDirection, billboardRotation } from '../dist/billboard.js';

const deg = Math.PI / 180;
// Camera world matrix the way a core camera's position/target/up describe it.
const cameraMatrix = (eye, target, up = [0, 1, 0]) =>
  new Matrix4().lookAt(new Vector3(...eye), new Vector3(...target), new Vector3(...up)).setPosition(new Vector3(...eye))
    .elements;
const rotate = (q, v) => new Vector3(...v).applyQuaternion(new Quaternion(...q)).toArray();
const near = (actual, expected, eps = 1e-6) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= eps),
    `${actual} != ${expected}`,
  );
const column = (m, c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
const unit = (v) => v.map((x) => x / Math.hypot(...v));

test('billboardRotation direction mode copies the camera orientation wherever the billboard is', () => {
  const camera = cameraMatrix([3, 4, 5], [0, 1, -2]);
  for (const position of [
    [0, 0, 0],
    [10, -3, 2],
  ]) {
    const q = billboardRotation(camera, position);
    near(rotate(q, [0, 0, 1]), column(camera, 2));
    near(rotate(q, [0, 1, 0]), column(camera, 1));
    near(rotate(q, [1, 0, 0]), column(camera, 0));
  }
});

test('billboardRotation position mode turns +Z toward the camera position', () => {
  const camera = cameraMatrix([3, 4, 5], [0, 0, 0]),
    position = [2, 0, -6],
    q = billboardRotation(camera, position, { mode: 'position' });
  near(rotate(q, [0, 0, 1]), unit([3 - 2, 4, 5 + 6]));
  // Up stays as close to the camera's up as it can: perpendicular to +Z, in the plane of +Z and camera up.
  const up = rotate(q, [0, 1, 0]),
    z = rotate(q, [0, 0, 1]),
    cameraUp = column(camera, 1),
    side = [
      z[1] * cameraUp[2] - z[2] * cameraUp[1],
      z[2] * cameraUp[0] - z[0] * cameraUp[2],
      z[0] * cameraUp[1] - z[1] * cameraUp[0],
    ];
  assert.ok(Math.abs(up[0] * side[0] + up[1] * side[1] + up[2] * side[2]) < 1e-6);
  assert.ok(up[0] * cameraUp[0] + up[1] * cameraUp[1] + up[2] * cameraUp[2] > 0);
  // A camera at the billboard's own position falls back to the camera's back axis.
  near(rotate(billboardRotation(camera, [3, 4, 5], { mode: 'position' }), [0, 0, 1]), column(camera, 2));
});

test('billboardRotation lockY keeps up at +Y and faces the horizontal direction', () => {
  const camera = cameraMatrix([3, 8, 4], [0, 0, 0]);
  for (const mode of ['direction', 'position']) {
    const position = [1, 0, -1],
      q = billboardRotation(camera, position, { mode, lockY: true });
    near(rotate(q, [0, 1, 0]), [0, 1, 0]);
    const facing = mode === 'direction' ? column(camera, 2) : [3 - 1, 8, 4 + 1];
    near(rotate(q, [0, 0, 1]), unit([facing[0], 0, facing[2]]));
  }
  // Straight down (the core camera needs up = [0, 0, -1]): the yaw comes from the camera's down axis, so the front
  // faces the bottom of the screen (+z here).
  const above = cameraMatrix([0, 10, 0], [0, 0, 0], [0, 0, -1]);
  for (const mode of ['direction', 'position']) {
    const q = billboardRotation(above, [0, 0, 0], { mode, lockY: true });
    near(rotate(q, [0, 1, 0]), [0, 1, 0]);
    near(rotate(q, [0, 0, 1]), [0, 0, 1]);
  }
});

test('billboardRotation snap rounds the yaw to the step, locked or not', () => {
  const at = (yaw, height = 0) => cameraMatrix([10 * Math.sin(yaw * deg), height, 10 * Math.cos(yaw * deg)], [0, 0, 0]);
  const yawOf = (q) => {
    const z = rotate(q, [0, 0, 1]);
    return Math.atan2(z[0], z[2]) / deg;
  };
  for (const [yaw, expected] of [
    [37, 45],
    [20, 0],
    [-100, -90],
    [170, 180],
    [-157, -135],
  ]) {
    const locked = billboardRotation(at(yaw), [0, 0, 0], { lockY: true, snap: 45 });
    assert.ok(Math.abs(((yawOf(locked) - expected + 540) % 360) - 180) < 1e-6, `${yaw} -> ${yawOf(locked)}`);
    // Unlocked keeps the pitch and roll: only the yaw about world +Y changes.
    const free = billboardRotation(at(yaw, 6), [0, 0, 0], { snap: 45 }),
      plain = billboardRotation(at(yaw, 6), [0, 0, 0]);
    assert.ok(Math.abs(((yawOf(free) - expected + 540) % 360) - 180) < 1e-6);
    assert.ok(Math.abs(rotate(free, [0, 0, 1])[1] - rotate(plain, [0, 0, 1])[1]) < 1e-9);
  }
  near(billboardRotation(at(37), [0, 0, 0], { snap: 0 }), billboardRotation(at(37), [0, 0, 0]));
  assert.throws(() => billboardRotation(at(0), [0, 0, 0], { snap: -1 }), RangeError);
  assert.throws(() => billboardRotation(at(0), [0, 0, 0], { mode: 'sideways' }), TypeError);
  assert.throws(() => billboardRotation([1, 2], [0, 0, 0]), TypeError);
});

test('billboardRotation with a parent returns the local rotation that keeps facing the camera', () => {
  const camera = cameraMatrix([3, 4, 5], [0, 1, -2]),
    parentRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1.1),
    parent = new Matrix4().compose(new Vector3(4, 0, 1), parentRotation, new Vector3(2, 2, 2)).elements;
  for (const options of [{}, { mode: 'position' }, { lockY: true, snap: 30 }]) {
    const world = billboardRotation(camera, [1, 2, 3], options),
      local = billboardRotation(camera, [1, 2, 3], { ...options, parent }),
      composed = new Quaternion().multiplyQuaternions(parentRotation, new Quaternion(...local));
    for (const axis of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
      near(rotate([composed.x, composed.y, composed.z, composed.w], axis), rotate(world, axis));
  }
});

test('billboardDirection picks the sprite-sheet direction around a full turn', () => {
  // Camera azimuth around the object, 0 in front, 90 at the object's local +X (its left): S, SW, W, NW, N, NE, E, SE.
  const order = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
  for (const facingYaw of [0, 90, 200]) {
    const f = [Math.sin(facingYaw * deg), 0, Math.cos(facingYaw * deg)],
      around = (a) => [Math.sin((facingYaw + a) * deg), 0.3, Math.cos((facingYaw + a) * deg)];
    for (let a = -179.7; a < 180; a += 1) {
      const expected = order[(Math.round(a / 45) + 8) % 8];
      assert.equal(billboardDirection(f, around(a)), expected, `facing ${facingYaw}, camera at ${a}`);
    }
    // Just either side of each 22.5-degree boundary.
    for (let k = 0; k < 8; k++) {
      const edge = 22.5 + 45 * k;
      assert.equal(billboardDirection(f, around(edge - 1e-6)), order[k]);
      assert.equal(billboardDirection(f, around(edge + 1e-6)), order[(k + 1) % 8]);
    }
  }
  assert.equal(billboardDirection([0, 0, 1], [0, 0, 5]), 'S');
  assert.equal(billboardDirection([0, 0, 1], [0, 0, -5]), 'N');
  assert.equal(billboardDirection([0, 0, 1], [5, 0, 0]), 'W');
  assert.equal(billboardDirection([0, 0, 1], [-5, 0, 0]), 'E');
  assert.equal(billboardDirection([0, 0, 1], [0, 5, 0]), 'S');
});

test('billboardDirection limits the choice to the available directions', () => {
  const four = ['N', 'E', 'S', 'W'],
    at = (a) => [Math.sin(a * deg), 0, Math.cos(a * deg)];
  assert.equal(billboardDirection([0, 0, 1], at(40), four), 'S');
  assert.equal(billboardDirection([0, 0, 1], at(50), four), 'W');
  assert.equal(billboardDirection([0, 0, 1], at(-140), four), 'N');
  // An exact tie goes to the earlier entry.
  assert.equal(billboardDirection([0, 0, 1], [1, 0, 0], ['N', 'S']), 'N');
  assert.equal(billboardDirection([0, 0, 1], [1, 0, 0], ['S', 'N']), 'S');
  assert.throws(() => billboardDirection([0, 0, 1], [1, 0, 0], []), TypeError);
  assert.throws(() => billboardDirection([0, 0, 1], [1, 0, 0], ['UP']), TypeError);
  assert.throws(() => billboardDirection([0, 1, 0], [1, 0, 0]), RangeError);
});
