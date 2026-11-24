import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraConfiner } from '../dist/confine.js';
import { CameraBrain, createPose } from '../dist/brain.js';
import { createRandom } from '@margoengine/math/mathutils';

const near = (a, b, limit = 1e-9) => assert.ok(Math.abs(a - b) <= limit, `${a} is not ${b} within ${limit}`);
const fixes = (pattern) => (error) => {
  assert.ok(error instanceof RangeError, `${error.name}: ${error.message}`);
  assert.match(error.message, pattern);
  assert.match(error.message, /;/);
  return true;
};
const at = (x, y, z) => createPose({ position: [x, y, z], target: [0, 0, -100] });
/** Winding number, a test of inside that shares nothing with the even-odd rule of the code. */
function inside(polygon, x, z) {
  let turn = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i],
      [bx, bz] = polygon[(i + 1) % polygon.length];
    turn += Math.atan2((ax - x) * (bz - z) - (az - z) * (bx - x), (ax - x) * (bx - x) + (az - z) * (bz - z));
  }
  return Math.abs(turn) > Math.PI;
}
function wall(polygon, x, z) {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i],
      [bx, bz] = polygon[(i + 1) % polygon.length],
      t = Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
    best = Math.min(best, Math.hypot(x - ax - (bx - ax) * t, z - az - (bz - az) * t));
  }
  return best;
}

test('a box clamps each axis, keeps a margin, and leaves the aim alone', () => {
  const box = new CameraConfiner({ min: [-10, 0, -10], max: [10, 5, 10] }, { margin: 1 }),
    p = at(50, -3, 4);
  box.update(p);
  assert.deepEqual([...p.position], [9, 1, 4]);
  assert.deepEqual([...p.target], [0, 0, -100]);
  assert.equal(box.clamped, true);
  near(box.correction, Math.hypot(41, 4));
  const q = at(0, 2, 0);
  box.update(q);
  assert.deepEqual([...q.position], [0, 2, 0]);
  assert.equal(box.clamped, false);
  assert.equal(box.correction, 0);
});

test('an area pushes out of a wall to its nearest point, and height limits hold', () => {
  const square = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    area = new CameraConfiner({ area: square, bottom: 1, top: 4 }),
    p = at(15, 9, 5);
  area.update(p);
  assert.deepEqual([...p.position], [10, 4, 5]);
  const q = at(-3, 0, -4);
  area.update(q);
  near(q.position[0], 0);
  near(q.position[2], 0);
  assert.equal(q.position[1], 1);
});

test('either winding works, and the margin keeps the camera off the wall from inside and out', () => {
  for (const square of [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    [
      [0, 10],
      [10, 10],
      [10, 0],
      [0, 0],
    ],
  ]) {
    const area = new CameraConfiner({ area: square }, { margin: 2 });
    for (const [x, z, wantX] of [
      [9.5, 5, 8],
      [10, 5, 8],
      [30, 5, 8],
      [0, 5, 2],
    ]) {
      const p = at(x, 0, z);
      area.update(p);
      near(p.position[0], wantX);
      near(p.position[2], 5);
    }
  }
});

test('2,000 seeded points never end outside a concave level, and clear its margin wherever they can', () => {
  const level = [
      [0, 0],
      [30, 0],
      [30, 30],
      [20, 30],
      [20, 10],
      [10, 10],
      [10, 30],
      [0, 30],
    ],
    margin = 1,
    confiner = new CameraConfiner({ area: level }, { margin }),
    random = createRandom(11);
  for (let i = 0; i < 2000; i++) {
    const p = at(random() * 60 - 15, 0, random() * 60 - 15);
    confiner.update(p);
    assert.ok(inside(level, p.position[0], p.position[2]), `outside at ${i}: ${p.position}`);
    assert.ok(wall(level, p.position[0], p.position[2]) >= margin - 1e-9, `on the wall at ${i}: ${p.position}`);
  }
});

test('a sharp corner keeps the margin, and every result is the nearest clear point', () => {
  // The clear points of a triangle are a smaller triangle, whose corners are where the walls' margins meet.
  const margin = 1,
    random = createRandom(5),
    clearOf = (polygon) => {
      const lines = polygon.map(([ax, az], i) => {
        const [bx, bz] = polygon[(i + 1) % polygon.length],
          size = Math.hypot(bx - ax, bz - az),
          nx = (az - bz) / size,
          nz = (bx - ax) / size;
        return [nx, nz, nx * ax + nz * az + margin];
      });
      return lines.map((a, i) => {
        const b = lines[(i + 2) % 3],
          det = a[0] * b[1] - a[1] * b[0];
        return [(a[2] * b[1] - b[2] * a[1]) / det, (a[0] * b[2] - b[0] * a[2]) / det];
      });
    };
  for (const degrees of [90, 45, 20, 5]) {
    const angle = (degrees * Math.PI) / 180,
      tip = [
        [0, 0],
        [100, 0],
        [100 * Math.cos(angle), 100 * Math.sin(angle)],
      ],
      clear = clearOf(tip),
      confiner = new CameraConfiner({ area: tip }, { margin });
    for (let i = 0; i < 500; i++) {
      const x = random() * 140 - 20,
        z = random() * 140 - 20,
        p = at(x, 0, z);
      confiner.update(p);
      assert.ok(wall(tip, p.position[0], p.position[2]) >= margin - 1e-9, `${degrees} degrees: ${p.position}`);
      if (confiner.clamped) near(confiner.correction, wall(clear, x, z), 1e-6);
    }
  }
});

test('a camera held on the margin stays there, and a repeated outline point does no harm', () => {
  const square = [
      [0, 0],
      [10, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    area = new CameraConfiner({ area: square }, { margin: 1 }),
    p = at(30, 0, 30);
  area.update(p);
  near(p.position[0], 9);
  near(p.position[2], 9);
  const held = [...p.position];
  area.update(p);
  assert.deepEqual([...p.position], held);
  assert.equal(area.clamped, false);
});

test('a point already well inside does not move', () => {
  const area = new CameraConfiner({ area: [[0, 0], [10, 0], [5, 10]] }, { margin: 0.5 }),
    p = at(5, 7, 3);
  area.update(p);
  assert.deepEqual([...p.position], [5, 7, 3]);
  assert.equal(area.clamped, false);
});

test('a gap narrower than two margins still ends inside', () => {
  const thin = [
      [0, 0],
      [100, 0],
      [100, 1],
      [0, 1],
    ],
    area = new CameraConfiner({ area: thin }, { margin: 2 }),
    p = at(50, 0, 40);
  area.update(p);
  assert.ok(inside(thin, p.position[0], p.position[2] - 1e-9) || wall(thin, p.position[0], p.position[2]) < 1e-9);
});

test('in brain.stages it holds the blend between two cameras as well', () => {
  const brain = new CameraBrain({ blend: { duration: 1, ease: (u) => u } }),
    confiner = new CameraConfiner({ min: [-1, -1, -1], max: [1, 1, 20] });
  brain.stages.push(confiner);
  brain.add({ position: [0, 0, 10], target: [0, 0, 0] });
  const b = brain.add({ priority: -1, position: [40, 0, 10], target: [0, 0, 0] });
  brain.update(0);
  b.priority = 1;
  brain.update(0);
  brain.update(0.5);
  assert.equal(brain.pose.position[0], 1);
  assert.equal(confiner.clamped, true);
});

test('errors say what to pass', () => {
  const box = { min: [0, 0, 0], max: [1, 1, 1] };
  assert.throws(() => new CameraConfiner(), fixes(/shape/));
  assert.throws(() => new CameraConfiner({ area: [[0, 0], null, [1, 1]] }), fixes(/area/));
  assert.throws(() => new CameraConfiner(box, { margin: -1 }), fixes(/margin/));
  assert.throws(() => new CameraConfiner(box, { margin: 0.6 }), fixes(/bounds/));
  assert.throws(() => new CameraConfiner({ min: [1, 0, 0], max: [0, 1, 1] }), fixes(/bounds/));
  assert.throws(() => new CameraConfiner({ min: [NaN, 0, 0], max: [0, 1, 1] }), fixes(/box/));
  assert.throws(() => new CameraConfiner({ min: [0, 0, 0] }), fixes(/box/));
  assert.throws(() => new CameraConfiner({ area: [[0, 0], [1, 1]] }), fixes(/area/));
  assert.throws(() => new CameraConfiner({ area: [[0, 0], [1, 1], [NaN, 2]] }), fixes(/area/));
  assert.throws(() => new CameraConfiner({ area: [[0, 0], [1, 1], [2, 2]] }), fixes(/area/));
  assert.throws(() => new CameraConfiner({ area: [[0, 0], [1, 0], [0, 1]], bottom: 3, top: 1 }), fixes(/bounds/));
});
