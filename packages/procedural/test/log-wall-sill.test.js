// KB-CABIN-SIDEWALL-LEAK1: Cabin Hearth's side walls start half a log up, notched over the front and back walls' logs
// as a log cabin's corners are, and only the corner posts reached the ground, so the room's firelight showed on the
// snow through the half-log gap under each side wall. A wall raised by less than a log now stands on a sill log hewn
// flat underneath (the half-log starter course). These tests build the cabin's four walls as the demo does and cast
// segments from points inside the room to the ground outside, under every wall; none may get out except through the
// door.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLogWall } from '../dist/index.js';

/** Möller-Trumbore on the segment o + t e, 0 <= t <= 1: does it cross a triangle of `g`? */
function crosses(g, o, e) {
  const p = g.positions;
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = g.indices[t] * 3,
      b = g.indices[t + 1] * 3,
      c = g.indices[t + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
      e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const h = [e[1] * e2[2] - e[2] * e2[1], e[2] * e2[0] - e[0] * e2[2], e[0] * e2[1] - e[1] * e2[0]],
      det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = [o[0] - p[a], o[1] - p[a + 1], o[2] - p[a + 2]],
      u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]],
      v = (e[0] * q[0] + e[1] * q[1] + e[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const k = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (k >= 0 && k <= 1) return true;
  }
  return false;
}

// Cabin Hearth's walls (examples/cabin-hearth/main.ts): x -3 to 3, z -2.5 to 2.5, 0.3 m logs, 9 courses; the side
// walls sit half a log higher with a gable of shortening courses; the door at x -2.1 to -1.1 up to 2.15 m.
const width = 6,
  depth = 5,
  log = 0.3,
  rows = 9,
  door = [-2.1, -1.1, -Infinity, 2.15],
  pitch = Math.PI / 6,
  course = (half) => (half > 0.2 ? [-half, half] : [0, 0]),
  gable = Array.from({ length: 4 }, (_, r) => course(depth / 2 - (log / 2 + r * log) / Math.tan(pitch) - 0.05));

function cabin(sideOptions = {}) {
  return {
    front: generateLogWall({
      courses: Array.from({ length: rows }, () => course(width / 2 + 0.25)),
      diameter: log,
      openings: [[0.6, 1.8, 0.95, 2.05], door],
    }),
    back: generateLogWall({ courses: Array.from({ length: rows }, () => course(width / 2 + 0.25)), diameter: log }),
    side: generateLogWall({
      courses: [...Array.from({ length: rows }, () => course(depth / 2 + 0.25)), ...gable],
      diameter: log,
      bottom: log,
      ...sideOptions,
    }),
  };
}

/** Segments from inside the room to the ground outside each wall, in that wall's frame (the wall along x, its
 * thickness on z, the room at z < 0); `along` is the inside span of the wall, `open(x)` the door's span. */
function escapes(wall, along, open = () => false) {
  let out = 0,
    cast = 0;
  for (let i = 0; i <= 24; i++) {
    const x = -along + (i / 24) * 2 * along;
    for (const height of [0.01, 0.05, 0.12, 0.2, 0.35, 0.6, 1])
      for (const inside of [0.25, 0.6, 1.5])
        for (const outside of [0.2, 0.5, 1.5, 4])
          for (const slide of [-0.4, 0, 0.4]) {
            const end = Math.min(along, Math.max(-along, x + slide));
            // Skip a segment that passes the wall's plane inside the door.
            const at = x + ((end - x) * inside) / (inside + outside);
            if (open(at, x, end)) continue;
            cast++;
            if (!crosses(wall, [x, height, -inside], [end - x, -height, inside + outside])) out++;
          }
  }
  return { out, cast };
}

test('no line from inside the cabin reaches the ground under a wall: the raised side walls stand on a sill', () => {
  const { front, back, side } = cabin(),
    // The side walls run between the front and back walls' inner faces; the front and back between the side walls'.
    sideSpan = depth / 2 - log / 2 - 0.01,
    frontSpan = width / 2 - log / 2 - 0.01,
    // In the front wall, skip every segment within 5 cm of the door's span (the door's planks close it in the demo).
    door5 = (...xs) => xs.some((x) => x > door[0] - 0.05 && x < door[1] + 0.05);
  for (const [name, wall, along, open] of [
    ['side', side, sideSpan, undefined],
    ['front', front, frontSpan, door5],
    ['back', back, frontSpan, undefined],
  ]) {
    const { out, cast } = escapes(wall, along, open);
    assert.ok(cast > 4000, `${name}: cast ${cast}`);
    assert.equal(out, 0, `${name} wall: ${out} of ${cast} lines from the room reach the snow under it`);
  }
  // Not vacuous: through the door, the room's light reaches the snow.
  assert.equal(crosses(front, [-1.6, 0.6, -1], [0, -0.6, 2]), false, 'the door is open to the snow');
});

test('the sill is a log hewn flat on the ground: nothing below y = 0, the stagger kept, the gable unchanged', () => {
  const { side } = cabin(),
    p = side.positions;
  let yMin = Infinity,
    zMax = 0,
    flat = 0;
  for (let i = 0; i < p.length; i += 3) {
    yMin = Math.min(yMin, p[i + 1]);
    zMax = Math.max(zMax, Math.abs(p[i + 2]));
    if (Math.abs(p[i + 1]) < 1e-6 && side.normals[i + 1] < -0.999) flat++;
  }
  assert.ok(Math.abs(yMin) < 1e-6, `the sill stands on y = 0 (lowest ${yMin})`);
  assert.ok(zMax <= log / 2 + 1e-6, `no wider than a log (${zMax})`);
  assert.ok(flat >= 4, 'its underside is a flat face looking down');
  // The courses keep the half-log stagger: a line at the bottom course's axis, 0.3 m, hits wood, and so does one at
  // 0.075 m, inside the sill; the front wall's bottom course has its axis at 0.15 m.
  assert.equal(crosses(side, [0, 0.3, -1], [0, 0, 2]), true);
  assert.equal(crosses(side, [0, 0.075, -1], [0, 0, 2]), true);
  // A wall standing on its own foundation keeps the gap open: sill false.
  const open = cabin({ sill: false }).side;
  assert.equal(crosses(open, [0, 0.075, -1], [0, 0, 2]), false, 'sill: false leaves the half-log gap');
  let lowest = Infinity;
  for (let i = 1; i < open.positions.length; i += 3) lowest = Math.min(lowest, open.positions[i]);
  // The lowest facet of the bottom course, centred at 0.3 m, sits r cos(pi / 14) under its axis.
  const facet = (log / 2) * Math.cos(Math.PI / 14);
  assert.ok(Math.abs(lowest - (log - facet)) < 1e-6, `sill: false starts at the bottom course (${lowest})`);
  // A gable piece set high on another wall (bottom more than a log up) gets no sill.
  const high = generateLogWall({ courses: [[-2.75, 2.75], [-2.2, 2.2]], bottom: 2.85 });
  let low = Infinity;
  for (let i = 1; i < high.positions.length; i += 3) low = Math.min(low, high.positions[i]);
  assert.ok(Math.abs(low - (2.85 - facet)) < 1e-6, `a raised gable piece starts at its own bottom course (${low})`);
});

test('a door through a sill-raised wall cuts the sill too, and the threshold is open', () => {
  const wall = generateLogWall({
    courses: Array.from({ length: 9 }, () => [-2.72, 2.72]),
    diameter: 0.26,
    bottom: 0.26,
    segments: 12,
    openings: [[-0.45, 0.45, -Infinity, 2.0]],
  });
  assert.equal(crosses(wall, [0, 0.05, -1], [0, 0, 2]), false, 'the doorway reaches the ground');
  assert.equal(crosses(wall, [1, 0.05, -1], [0, 0, 2]), true, 'beside the door the sill is there');
});
