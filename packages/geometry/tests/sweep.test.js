// Sweeps and lofts against closed forms: volumes, areas, ring positions and normals, on solids that must also be closed
// and face outward.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CatmullRomCurve3, EllipseCurve, LineCurve3, Path, Shape, tubeGeometry } from '../dist/index.js';
import { Curve } from '../dist/index.js';
import { loftGeometry, sweepGeometry } from '../dist/sweep.js';
import { assertValid, close, point, signedVolume, surfaceArea, vertexCount, watertight } from './support/mesh-checks.js';

const line = (length = 10) => new LineCurve3([0, 0, 0], [0, 0, length]);
const square = (size = 1) => [
  [-size, -size],
  [size, -size],
  [size, size],
  [-size, size],
];
const circle = (corners, radius = 1) =>
  Array.from({ length: corners }, (_, i) => [
    Math.cos((i / corners) * Math.PI * 2) * radius,
    Math.sin((i / corners) * Math.PI * 2) * radius,
  ]);
const polygonArea = (corners, radius = 1) => (corners / 2) * radius * radius * Math.sin((2 * Math.PI) / corners);

class Ring extends Curve {
  constructor(radius) {
    super();
    this.radius = radius;
  }
  getPoint(t) {
    const a = t * Math.PI * 2;
    return [Math.cos(a) * this.radius, 0, Math.sin(a) * this.radius];
  }
}

class Helix extends Curve {
  getPoint(t) {
    const a = t * Math.PI * 4;
    return [Math.cos(a) * 3, t * 6, Math.sin(a) * 3];
  }
}

function solid(data, label) {
  assertValid(data, label);
  watertight(data, label);
}

test('a square swept straight is a box with hard edges and caps', () => {
  const box = sweepGeometry(square(), line(), { steps: 4 });
  solid(box, 'box');
  close(signedVolume(box), 40, 1e-5, 'volume');
  close(surfaceArea(box), 4 * 2 * 10 + 8, 1e-4, 'area');
  assert.deepEqual(
    box.groups.map((g) => g.materialIndex),
    [0, 1],
  );
  assert.equal(box.groups[0].count, 12);
  const start = box.groups[1].start;
  for (let i = start; i < box.indices.length; i++) {
    const v = box.indices[i],
      n = [box.normals[v * 3], box.normals[v * 3 + 1], box.normals[v * 3 + 2]];
    assert.ok(Math.abs(n[2]) < 1e-6, 'walls are square to the path');
    assert.ok(Math.max(Math.abs(n[0]), Math.abs(n[1])) > 1 - 1e-6, `normal ${n} points straight out of a flat wall`);
  }
});

test('a fine ring swept straight is a smooth cylinder with no seam', () => {
  const cylinder = sweepGeometry(circle(64), line(), { steps: 8 });
  solid(cylinder, 'cylinder');
  close(signedVolume(cylinder), polygonArea(64) * 10, 1e-3, 'volume');
  const start = cylinder.groups[1].start;
  for (let i = start; i < cylinder.indices.length; i++) {
    const v = cylinder.indices[i],
      [x, y] = point(cylinder, v),
      r = Math.hypot(x, y);
    close(cylinder.normals[v * 3], x / r, 1e-5, 'radial x');
    close(cylinder.normals[v * 3 + 1], y / r, 1e-5, 'radial y');
  }
});

test('scale tapers: a frustum, a cone to a point, and each axis apart', () => {
  const frustum = sweepGeometry(square(), line(6), { steps: 12, scale: (t) => 1 + t });
  solid(frustum, 'frustum');
  // Sides of 2 and 4 over a height of 6.
  close(signedVolume(frustum), (6 / 3) * (4 + 16 + 8), 1e-4, 'frustum volume');
  const cone = sweepGeometry(square(), line(6), { steps: 12, scale: (t) => 1 - t });
  solid(cone, 'cone');
  close(signedVolume(cone), (6 / 3) * 4, 1e-4, 'pyramid volume');
  assert.equal(cone.groups[0].count, 6, 'the point needs no cap');
  const wide = sweepGeometry(square(), line(5), { steps: 2, scale: [3, 0.5] });
  close(signedVolume(wide), 6 * 1 * 5, 1e-4, 'scaled per axis');
});

test('twist turns the profile by the given angle and keeps its area', () => {
  const twisted = sweepGeometry(square(), line(), { steps: 128, twist: Math.PI / 2 });
  solid(twisted, 'twisted');
  // Every slice of the true solid has the square's area. Flat triangles cut the corner of each twisted quad, by an
  // amount that falls with the step.
  const error = (steps) => 40 - signedVolume(sweepGeometry(square(), line(), { steps, twist: Math.PI / 2 }));
  assert.ok(error(128) < 0.2, 'close at 128 steps');
  close(error(128) / error(512), 4, 0.1, 'the error falls with the step');
  const byFunction = sweepGeometry(square(), line(), { steps: 4, twist: (t) => (t < 0.5 ? 0 : Math.PI / 4) });
  const last = vertexCount(byFunction) - 1;
  assert.ok(Number.isFinite(byFunction.positions[last * 3]));
  const end = sweepGeometry(square(), line(), { steps: 3, twist: Math.PI / 2, caps: false });
  const rows = new Set();
  for (let i = 0; i < vertexCount(end); i++) rows.add(point(end, i)[2].toFixed(3));
  assert.equal(rows.size, 4);
  const top = [];
  for (let i = 0; i < vertexCount(end); i++) if (Math.abs(point(end, i)[2] - 10) < 1e-6) top.push(point(end, i));
  const base = sweepGeometry(square(), line(), { steps: 3, caps: false }),
    bottom = [];
  for (let i = 0; i < vertexCount(base); i++) if (Math.abs(point(base, i)[2] - 10) < 1e-6) bottom.push(point(base, i));
  // A quarter turn maps the square's corners onto each other in the same plane.
  for (const p of top)
    assert.ok(
      bottom.some((q) => Math.abs(q[0] - p[0]) < 1e-5 && Math.abs(q[1] - p[1]) < 1e-5),
      'corner lands on a corner',
    );
});

test('a closed path gives a torus by the closed form, with no caps and no seam', () => {
  const torus = sweepGeometry(circle(32, 0.5), new Ring(3), { steps: 128, closed: true });
  solid(torus, 'torus');
  assert.equal(torus.groups, undefined);
  const expected = 2 * Math.PI ** 2 * 3 * 0.25;
  close(signedVolume(torus) / expected, 1, 0.01, 'volume');
  // The first and last rows share normals.
  const keys = new Map();
  for (let i = 0; i < vertexCount(torus); i++) {
    const k = point(torus, i)
      .map((x) => x.toFixed(4))
      .join();
    const n = [torus.normals[i * 3], torus.normals[i * 3 + 1], torus.normals[i * 3 + 2]];
    if (!keys.has(k)) keys.set(k, n);
    else keys.get(k).forEach((x, c) => close(x, n[c], 1e-5, 'normals match across the seam'));
  }
});

test('a circle along a helix matches tubeGeometry', () => {
  const path = new Helix(),
    swept = sweepGeometry(circle(12, 0.3), path, { steps: 96, caps: false }),
    tube = tubeGeometry(path, 96, 0.3, 12);
  close(surfaceArea(swept) / surfaceArea(tube), 1, 1e-3, 'area');
  const capped = sweepGeometry(circle(12, 0.3), path, { steps: 96 });
  solid(capped, 'helix rail');
});

test('up holds the profile level along a rail', () => {
  const path = new Helix(),
    rail = sweepGeometry(square(0.2), path, { steps: 40, up: [0, 1, 0], caps: false }),
    wide = sweepGeometry(
      [
        [-1, 0],
        [1, 0],
      ],
      new CatmullRomCurve3([
        [0, 0, 0],
        [5, 0, 5],
        [10, 0, 0],
        [15, 0, 5],
      ]),
      { steps: 40, up: [0, 1, 0], closedProfile: false },
    );
  assertValid(rail, 'rail');
  for (let i = 0; i < vertexCount(wide); i++) close(point(wide, i)[1], 0, 1e-5, 'a flat ribbon stays flat');
  assert.throws(() => sweepGeometry(square(), line(), { up: [0, 0, 0] }), RangeError);
  const straightUp = sweepGeometry(square(), line(), { up: [0, 0, 1], steps: 2 });
  solid(straightUp, 'up along the path');
});

test('a Shape with a hole keeps its hole; an open Path is a ribbon', () => {
  const frame = new Shape(square(2));
  frame.holes.push(new Path(square(1)));
  const pipe = sweepGeometry(frame, line(3), { steps: 2 });
  solid(pipe, 'square pipe');
  close(signedVolume(pipe), (16 - 4) * 3, 1e-4, 'volume');
  const round = new Shape();
  round.absarc(0, 0, 1, 0, Math.PI * 2, false);
  solid(sweepGeometry(round, line(3), { steps: 2, curveSegments: 32 }), 'curved shape');
  const ribbon = sweepGeometry(new Path([[-1, 0], [0, 0.5], [1, 0]]), line(4), { steps: 4, closedProfile: false });
  assert.equal(ribbon.groups, undefined);
  assert.equal(ribbon.indices.length / 3, 2 * 2 * 4);
  assertValid(ribbon, 'ribbon');
});

test('reversed rings still face out, and repeated points are ignored', () => {
  close(signedVolume(sweepGeometry(square().reverse(), line(), { steps: 2 })), 40, 1e-5, 'reversed');
  const closedRing = [...square(), square()[0]];
  closedRing.splice(1, 0, closedRing[0]);
  close(signedVolume(sweepGeometry(closedRing, line(), { steps: 2 })), 40, 1e-5, 'repeats');
});

test('creaseAngle decides hard edges', () => {
  const smooth = sweepGeometry(square(), line(), { steps: 1, creaseAngle: 180, caps: false }),
    hard = sweepGeometry(square(), line(), { steps: 1, caps: false });
  assert.equal(vertexCount(smooth), 2 * 5);
  assert.equal(vertexCount(hard), 2 * 8);
});

test('sweep rejects what it cannot build', () => {
  assert.throws(() => sweepGeometry([[0, 0], [1, 0]], line()), RangeError);
  assert.throws(() => sweepGeometry([[0, 0], [1, NaN], [1, 1]], line()), RangeError);
  assert.throws(() => sweepGeometry({}, line()), TypeError);
  assert.throws(() => sweepGeometry(square(), line(), { steps: 0 }), RangeError);
  assert.throws(() => sweepGeometry(square(), line(), { scale: -1 }), RangeError);
  assert.throws(() => sweepGeometry(square(), line(), { scale: () => NaN }), RangeError);
  assert.throws(() => sweepGeometry(square(), line(), { twist: () => NaN }), RangeError);
  assert.throws(() => sweepGeometry(square(), line(), { creaseAngle: -1 }), RangeError);
});

test('two equal sections loft into a prism, smooth or not', () => {
  for (const smooth of [true, false]) {
    const prism = loftGeometry([square(), square()], { smooth });
    solid(prism, `prism ${smooth}`);
    close(signedVolume(prism), 4, 1e-5, 'volume');
  }
});

test('a loft from square to circle keeps both shapes at the ends', () => {
  const corners = 48,
    shape = loftGeometry(
      [
        { profile: square(1), position: [0, 0, 0] },
        { profile: circle(corners, 1), position: [0, 0, 4] },
      ],
      { smooth: false, steps: 4 },
    );
  solid(shape, 'square to circle');
  const bottom = [],
    top = [];
  for (let i = 0; i < vertexCount(shape); i++) {
    const p = point(shape, i);
    if (p[2] === 0) bottom.push(p);
    if (Math.abs(p[2] - 4) < 1e-6) top.push(p);
  }
  for (const [x, y] of square(1))
    assert.ok(
      bottom.some((p) => Math.abs(p[0] - x) < 1e-6 && Math.abs(p[1] - y) < 1e-6),
      `corner ${x}, ${y} kept`,
    );
  for (const p of top) close(Math.hypot(p[0], p[1]) <= 1 + 1e-6 ? 1 : 0, 1, 0, 'top stays on the circle');
  const areaBottom = 4,
    areaTop = polygonArea(corners);
  const volume = signedVolume(shape);
  assert.ok(volume > 4 * areaTop && volume < 4 * areaBottom, `volume ${volume} lies between the two ends`);
});

test('sections with different point counts and starts do not twist', () => {
  const first = square(1),
    turned = [...square(1).slice(2), ...square(1).slice(0, 2)];
  const straight = loftGeometry([first, first], { steps: 1, smooth: false }),
    restarted = loftGeometry([first, turned], { steps: 1, smooth: false });
  close(signedVolume(restarted), signedVolume(straight), 1e-5, 'alignment undoes a changed start');
  const twisted = loftGeometry([first, turned], { steps: 1, smooth: false, align: false });
  assert.ok(signedVolume(twisted) < signedVolume(straight) - 0.1, 'without it the prism wrings itself');
  const stepped = loftGeometry([circle(7), circle(40), circle(13)], { steps: 4 });
  solid(stepped, 'mixed counts');
});

test('smooth lofts pass through every section', () => {
  const radii = [1, 1.6, 0.7, 1.2],
    bottle = loftGeometry(
      radii.map((r, i) => ({ profile: circle(32, r), position: [0, 0, i * 2] })),
      { steps: 6 },
    );
  solid(bottle, 'bottle');
  radii.forEach((r, i) => {
    const row = [];
    for (let v = 0; v < vertexCount(bottle); v++) if (Math.abs(point(bottle, v)[2] - i * 2) < 1e-5) row.push(point(bottle, v));
    assert.ok(row.length >= 32, `section ${i} is a row`);
    for (const p of row) assert.ok(Math.hypot(p[0], p[1]) <= r + 1e-5, `section ${i} stays inside its ring`);
    assert.ok(
      row.some((p) => Math.abs(Math.hypot(p[0], p[1]) - r) < 1e-5),
      `section ${i} reaches its ring`,
    );
  });
});

test('sections can face any way, and a closed loft makes a ring', () => {
  const sections = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    sections.push({
      profile: circle(16, 0.5),
      position: [Math.cos(a) * 3, Math.sin(a) * 3, 0],
      normal: [-Math.sin(a), Math.cos(a), 0],
    });
  }
  const torus = loftGeometry(sections, { closed: true, steps: 4 });
  solid(torus, 'lofted torus');
  assert.equal(torus.groups, undefined);
  close(signedVolume(torus) / (2 * Math.PI * 3 * polygonArea(16, 0.5)), 1, 0.005, 'volume');
});

test('rings of 3D points are used as they are, in either direction', () => {
  const ring = (z, reverse) => {
    const r = circle(8, 1).map(([x, y]) => [x, y, z]);
    return reverse ? r.reverse() : r;
  };
  const a = loftGeometry([ring(0, false), ring(2, false)], { smooth: false }),
    b = loftGeometry([ring(0, true), ring(2, false)], { smooth: false }),
    c = loftGeometry([ring(2, false), ring(0, false)], { smooth: false });
  for (const shape of [a, b, c]) {
    solid(shape, '3D rings');
    close(signedVolume(shape), polygonArea(8) * 2, 1e-5, 'volume');
  }
});

test('segments resamples evenly; caps can be left off', () => {
  const even = loftGeometry([square(), circle(5)], { segments: 40, steps: 1, smooth: false, caps: false });
  assert.equal(even.indices.length / 3, 2 * 40);
  assert.equal(even.groups, undefined);
});

test('loft rejects what it cannot build', () => {
  assert.throws(() => loftGeometry([square()]), RangeError);
  assert.throws(() => loftGeometry([square(), square()], { closed: true }), RangeError);
  assert.throws(() => loftGeometry([square(), square()], { steps: 0 }), RangeError);
  assert.throws(() => loftGeometry([square(), square()], { segments: 1.5 }), RangeError);
  const holed = new Shape(square(2));
  holed.holes.push(new Path(square(1)));
  assert.throws(() => loftGeometry([holed, square()]), RangeError);
  assert.throws(() => loftGeometry([{ profile: square(), normal: [0, 0, 0] }, square()]), RangeError);
});

test('every curve type drives a sweep', () => {
  const flat = new EllipseCurve(0, 0, 5, 3, 0, Math.PI, false);
  solid(sweepGeometry(square(0.2), flat, { steps: 32 }), '2D path');
});
