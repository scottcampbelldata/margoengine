// Polygon booleans and offsets against their definitions: point membership by brute force, area identities, and rings
// that really are simple. Inputs include what breaks float code: shared edges, touching corners and extreme scales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Path, Shape } from '../dist/index.js';
import { extrudeGeometry } from '../dist/extrude.js';
import { triangulateConstrained } from '../dist/delaunay.js';
import {
  polygonArea,
  polygonDifference,
  polygonIntersection,
  polygonOffset,
  polygonShapes,
  polygonStroke,
  polygonUnion,
  polygonXor,
} from '../dist/polygon.js';
import { signedVolume, watertight } from './support/mesh-checks.js';

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const square = (x, y, size) => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];
const near = (actual, expected, tolerance, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} is within ${tolerance} of ${expected}`);

function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - a[1] * b[0];
  }
  return sum / 2;
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
  }
  return inside;
}

const inPolygons = (polygons, x, y) =>
  polygons.some((p) => inRing(p.contour, x, y) && !p.holes.some((h) => inRing(h, x, y)));

function segmentDistance(a, b, x, y) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
}

function ringDistance(ring, x, y) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++)
    best = Math.min(best, segmentDistance(ring[i], ring[(i + 1) % ring.length], x, y));
  return best;
}

const allRings = (polygons) => polygons.flatMap((p) => [p.contour, ...p.holes]);

function properlyCross(a, b, c, d) {
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]),
    s1 = side(a, b, c),
    s2 = side(a, b, d),
    s3 = side(c, d, a),
    s4 = side(c, d, b);
  return s1 * s2 < 0 && s3 * s4 < 0;
}

/** Outlines counter-clockwise, holes clockwise and inside, and no two edges crossing. */
function assertValid(polygons, label = '') {
  for (const { contour, holes } of polygons) {
    assert.ok(signedArea(contour) > 0, `${label} outline runs counter-clockwise`);
    for (const hole of holes) {
      assert.ok(signedArea(hole) < 0, `${label} hole runs clockwise`);
      const mid = [(hole[0][0] + hole[1][0]) / 2, (hole[0][1] + hole[1][1]) / 2];
      assert.ok(inRing(contour, mid[0], mid[1]), `${label} hole sits inside its outline`);
    }
  }
  const edges = [];
  for (const ring of allRings(polygons))
    for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length]]);
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++)
      assert.ok(!properlyCross(...edges[i], ...edges[j]), `${label} edges ${i} and ${j} do not cross`);
}

/** A star-shaped ring with noisy radii: concave, never self-crossing. */
function blob(next, cx, cy, radius, corners) {
  const ring = [];
  for (let i = 0; i < corners; i++) {
    const angle = (i / corners) * Math.PI * 2,
      r = radius * (0.35 + 0.65 * next());
    ring.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return ring;
}

test('two overlapping squares under all four operations', () => {
  const a = square(0, 0, 2),
    b = square(1, 1, 2);
  const union = polygonUnion(a, b);
  assert.equal(union.length, 1);
  assert.equal(union[0].contour.length, 8);
  assert.equal(polygonArea(union), 7);
  assert.equal(polygonArea(polygonIntersection(a, b)), 1);
  assert.equal(polygonArea(polygonDifference(a, b)), 3);
  const xor = polygonXor(a, b);
  assert.equal(polygonArea(xor), 6);
  assert.equal(xor.length, 2, 'the two L shapes meet only at corners');
  assertValid(union);
  assertValid(xor);
});

test('disjoint, contained and identical operands', () => {
  const big = square(0, 0, 4),
    small = square(1, 1, 1),
    far = square(10, 10, 1);
  assert.equal(polygonUnion(big, far).length, 2);
  assert.deepEqual(polygonIntersection(big, far), []);
  assert.deepEqual(polygonDifference(small, big), []);
  assert.deepEqual(polygonDifference(big, big), []);
  assert.deepEqual(polygonXor(big, big), []);
  assert.equal(polygonArea(polygonIntersection(big, big)), 16);
  const hole = polygonDifference(big, small);
  assert.equal(hole.length, 1);
  assert.equal(hole[0].holes.length, 1);
  assert.equal(polygonArea(hole), 15);
  assert.deepEqual(polygonUnion([], []), []);
});

test('shared edges merge and corners that only touch stay apart', () => {
  const merged = polygonUnion(square(0, 0, 1), square(1, 0, 1));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].contour.length, 4, 'the seam and its straight runs are gone');
  assert.deepEqual(polygonIntersection(square(0, 0, 1), square(1, 0, 1)), []);
  const touching = polygonUnion(square(0, 0, 1), square(1, 1, 1));
  assert.equal(touching.length, 2);
  assert.equal(polygonArea(touching), 2);
  assertValid(touching);
});

test('a hole touching its outline at a corner comes back as a hole', () => {
  const cut = [
    [0, 0],
    [2, 1],
    [1, 2],
  ];
  const result = polygonDifference(square(0, 0, 4), cut);
  assert.equal(polygonArea(result), 16 - 1.5);
  assertValid(result);
  const { indices, contour, holes, points } = triangulateConstrained(result[0].contour, result[0].holes);
  const all = [...contour, ...holes.flat(), ...points];
  let area = 0;
  for (let t = 0; t < indices.length; t += 3)
    area += signedArea([all[indices[t]], all[indices[t + 1]], all[indices[t + 2]]]);
  near(area, 14.5, 1e-9, 'triangulated area');
});

test('a checkerboard unions into regions that meet at points', () => {
  const cells = [],
    filled = [];
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 6; x++) {
      filled.push(square(x, y, 1));
      if ((x + y) % 2 === 0) cells.push(square(x, y, 1));
    }
  const result = polygonUnion(cells);
  assert.equal(result.length, 18);
  assert.equal(polygonArea(result), 18);
  assertValid(result);
  assert.equal(polygonUnion(filled)[0].contour.length, 4, 'a full grid is one square');
});

test('ring direction does not matter and a hole cuts only its own outline', () => {
  const frame = { contour: square(0, 0, 4), holes: [square(1, 1, 2)] };
  const reversed = { contour: square(0, 0, 4).reverse(), holes: [square(1, 1, 2).reverse()] };
  assert.equal(polygonArea(polygonUnion(frame)), 12);
  assert.equal(polygonArea(polygonUnion(reversed)), 12);
  assert.equal(polygonArea(polygonUnion(frame, square(1.5, 1.5, 1))), 13, 'an island in the hole stays');
  assert.equal(polygonArea(polygonUnion([frame, square(-5, -5, 1)])), 13, 'lists are unions');
});

test('Shapes go in with their curves and holes and come back out', () => {
  const disc = new Shape();
  disc.absarc(0, 0, 2, 0, Math.PI * 2, false);
  const cut = new Path();
  cut.absarc(0, 0, 1, 0, Math.PI * 2, true);
  disc.holes.push(cut);
  const ring = polygonUnion(disc, [], { curveSegments: 64 });
  near(polygonArea(ring), Math.PI * 3, 0.01, 'ring area');
  const bar = [
    [-3, -0.25],
    [3, -0.25],
    [3, 0.25],
    [-3, 0.25],
  ];
  const halves = polygonDifference(disc, bar, { curveSegments: 64 });
  assert.equal(halves.length, 2);
  const solid = extrudeGeometry(polygonShapes(halves), { depth: 1, bevelEnabled: false, curveSegments: 1 });
  near(signedVolume(solid), polygonArea(halves), 1e-3, 'volume of the extruded result');
});

test('polygonShapes output extrudes into closed solids', () => {
  const plan = polygonDifference(polygonUnion(square(0, 0, 4), square(3, 1, 3)), square(1, 1, 1));
  const shapes = polygonShapes(plan);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].holes.length, 1);
  const solid = extrudeGeometry(shapes, { depth: 2, bevelEnabled: false });
  near(signedVolume(solid), polygonArea(plan) * 2, 1e-4, 'volume');
  watertight(solid, 'extruded plan');
});

test('fill rules decide what a self-crossing outline covers', () => {
  const bowTie = [
    [0, 0],
    [2, 2],
    [2, 0],
    [0, 2],
  ];
  assert.equal(polygonArea(polygonUnion(bowTie, [], { fillRule: 'evenodd' })), 2);
  assert.equal(polygonArea(polygonUnion(bowTie, [], { fillRule: 'nonzero' })), 2);
  const star = [];
  for (let i = 0; i < 5; i++) {
    const angle = Math.PI / 2 + (i * 4 * Math.PI) / 5;
    star.push([Math.cos(angle), Math.sin(angle)]);
  }
  const evenOdd = polygonArea(polygonUnion(star, [], { fillRule: 'evenodd' })),
    nonZero = polygonArea(polygonUnion(star, [], { fillRule: 'nonzero' }));
  assert.ok(nonZero > evenOdd, 'the middle of a pentagram is filled only by nonzero');
  near(nonZero - evenOdd, 2.5 * Math.sin((2 * Math.PI) / 5) * 0.381966 ** 2, 1e-5, 'the inner pentagon');
  assert.throws(() => polygonUnion(star, [], { fillRule: 'odd' }), RangeError);
});

test('every sampled point is in the result exactly when the operation says so', () => {
  const operations = [
    [polygonUnion, (a, b) => a || b],
    [polygonIntersection, (a, b) => a && b],
    [polygonDifference, (a, b) => a && !b],
    [polygonXor, (a, b) => a !== b],
  ];
  for (let seed = 1; seed <= 12; seed++) {
    const next = random(seed),
      a = blob(next, 0, 0, 10, 40),
      b = blob(next, 3, 2, 10, 60);
    for (const [operation, rule] of operations) {
      const result = operation(a, b);
      assertValid(result, `seed ${seed}`);
      for (let i = 0; i < 400; i++) {
        const x = next() * 24 - 12,
          y = next() * 24 - 12;
        if (Math.min(ringDistance(a, x, y), ringDistance(b, x, y)) < 1e-6) continue;
        assert.equal(inPolygons(result, x, y), rule(inRing(a, x, y), inRing(b, x, y)), `seed ${seed} at ${x}, ${y}`);
      }
    }
    const areaA = Math.abs(signedArea(a)),
      areaB = Math.abs(signedArea(b)),
      both = polygonArea(polygonIntersection(a, b));
    near(polygonArea(polygonUnion(a, b)), areaA + areaB - both, 1e-5, 'union');
    near(polygonArea(polygonDifference(a, b)), areaA - both, 1e-5, 'difference');
    near(polygonArea(polygonXor(a, b)), areaA + areaB - 2 * both, 1e-5, 'xor');
  }
});

test('the answer does not depend on scale or distance from the origin', () => {
  const next = random(7),
    a = blob(next, 0, 0, 1, 30),
    b = blob(next, 0.3, 0.2, 1, 30),
    expected = polygonArea(polygonIntersection(a, b));
  for (const [scale, shift] of [
    [1e-9, 0],
    [1e12, 0],
    [2 ** -500, 0],
    [2 ** 500, 0],
    [1, 1e7],
  ]) {
    const move = (ring) => ring.map(([x, y]) => [x * scale + shift, y * scale - shift]),
      area = polygonArea(polygonIntersection(move(a), move(b))) / scale / scale;
    near(area, expected, shift ? 1e-5 : expected * 1e-6, `scale ${scale} shift ${shift}`);
  }
});

test('vertices that do not move come back exactly as given', () => {
  const a = [
    [0.1, 0.2],
    [1.3, 0.2],
    [1.3, 1.7],
    [0.1, 1.7],
  ];
  const [first] = polygonUnion(a, square(5.1, 5.3, 1.1)).filter((p) => p.contour[0][0] < 2);
  for (const p of a)
    assert.ok(
      first.contour.some((q) => q[0] === p[0] && q[1] === p[1]),
      `${p} kept`,
    );
});

test('nearly touching and nearly parallel edges still give clean rings', () => {
  const a = square(0, 0, 1);
  for (const gap of [1e-3, 1e-7, 1e-9, 1e-12, 0, -1e-12, -1e-9, -1e-7]) {
    const result = polygonUnion(a, square(1 + gap, 0, 1));
    assertValid(result, `gap ${gap}`);
    near(polygonArea(result), 2 + Math.min(gap, 0), 1e-6, `gap ${gap}`);
    assertValid(polygonDifference(a, square(1 + gap, 0, 1)), `difference at gap ${gap}`);
  }
  const fan = [];
  for (let i = 0; i < 200; i++)
    fan.push([
      [0, 0],
      [10, i * 1e-6],
      [10, i * 1e-6 + 5e-7],
    ]);
  assertValid(polygonUnion(fan), 'needle fan');
});

test('a thousand random overlapping triangles stay right', () => {
  const next = random(31),
    triangles = [];
  for (let i = 0; i < 1000; i++) {
    const x = next() * 50,
      y = next() * 50;
    triangles.push([
      [x, y],
      [x + next() * 4 - 2, y + next() * 4 - 2],
      [x + next() * 4 - 2, y + next() * 4 - 2],
    ]);
  }
  const result = polygonUnion(triangles);
  for (let i = 0; i < 1000; i++) {
    const x = next() * 50,
      y = next() * 50;
    if (triangles.some((t) => ringDistance(t, x, y) < 1e-6)) continue;
    assert.equal(
      inPolygons(result, x, y),
      triangles.some((t) => inRing(t, x, y)),
      `at ${x}, ${y}`,
    );
  }
});

test('rejects points that are not finite', () => {
  assert.throws(
    () =>
      polygonUnion([
        [0, 0],
        [1, NaN],
        [1, 1],
      ]),
    RangeError,
  );
  assert.throws(
    () =>
      polygonUnion([
        [0, 0],
        [Infinity, 0],
        [1, 1],
      ]),
    RangeError,
  );
  assert.throws(() => polygonUnion({ nope: 1 }), TypeError);
});

test('outset of a square: miter, bevel and round corners', () => {
  const s = square(0, 0, 2);
  assert.equal(polygonArea(polygonOffset(s, 1)), 16);
  assert.equal(polygonOffset(s, 1)[0].contour.length, 4);
  assert.equal(polygonArea(polygonOffset(s, 1, { join: 'bevel' })), 14);
  near(polygonArea(polygonOffset(s, 1, { join: 'round' })), 4 + 8 + Math.PI, 0.01, 'round');
  assert.equal(polygonArea(polygonOffset(s, 1, { miterLimit: 1.2 })), 14, 'past the limit a miter is a bevel');
  assert.equal(polygonArea(polygonOffset(s, 0)), 4);
  assert.throws(() => polygonOffset(s, NaN), RangeError);
  assert.throws(() => polygonOffset(s, 1, { miterLimit: 0.5 }), RangeError);
  assert.throws(() => polygonOffset(s, 1, { join: 'pointy' }), RangeError);
});

test('inset shrinks, splits and finally removes', () => {
  assert.equal(polygonArea(polygonOffset(square(0, 0, 4), -1)), 4);
  assert.deepEqual(polygonOffset(square(0, 0, 4), -2), [], 'exactly to the middle leaves nothing');
  assert.deepEqual(polygonOffset(square(0, 0, 4), -3), []);
  const bar = [
    [4, 1.8],
    [8, 1.8],
    [8, 2.2],
    [4, 2.2],
  ];
  const dumbbell = polygonUnion([square(0, 0, 4), square(8, 0, 4), bar]);
  assert.equal(dumbbell.length, 1);
  assert.equal(polygonOffset(dumbbell, -0.5).length, 2, 'the thin bar goes and the ends part');
});

test('offsets move holes the other way', () => {
  const frame = { contour: square(0, 0, 6), holes: [square(2, 2, 2)] };
  const grown = polygonOffset(frame, 0.5);
  assert.equal(grown[0].holes.length, 1);
  assert.equal(polygonArea(grown), 49 - 1);
  assert.deepEqual(polygonOffset(frame, 1)[0].holes, [], 'a hole closes');
  assert.equal(polygonArea(polygonOffset(frame, -0.5)), 25 - 9);
});

test('corners of an L: outset leaves inner corners sharp, inset leaves outer corners sharp', () => {
  const l = [
    [0, 0],
    [4, 0],
    [4, 2],
    [2, 2],
    [2, 4],
    [0, 4],
  ];
  const out = polygonOffset(l, 1, { join: 'round' })[0].contour;
  assert.ok(
    out.some((p) => p[0] === 3 && p[1] === 3),
    'sharp inner corner on the outset',
  );
  const inner = polygonOffset(l, -0.5, { join: 'round' })[0].contour;
  assert.ok(
    inner.some((p) => p[0] === 0.5 && p[1] === 0.5),
    'sharp outer corner on the inset',
  );
  assertValid(polygonOffset(l, 1));
});

test('a round offset holds exactly the points at that distance, on random outlines', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const next = random(seed * 11),
      ring = blob(next, 0, 0, 10, 30),
      slack = 0.01;
    for (const distance of [0.7, -0.4, 2, -1.5]) {
      const result = polygonOffset(ring, distance, { join: 'round' });
      assertValid(result, `seed ${seed} distance ${distance}`);
      for (let i = 0; i < 300; i++) {
        const x = next() * 28 - 14,
          y = next() * 28 - 14,
          signed = ringDistance(ring, x, y) * (inRing(ring, x, y) ? -1 : 1);
        if (Math.abs(signed - distance) < slack) continue;
        assert.equal(inPolygons(result, x, y), signed < distance, `seed ${seed} d ${distance} at ${x}, ${y}: ${signed}`);
      }
    }
  }
});

test('an offset and its inverse with round joins bring a circle back', () => {
  const n = 64,
    circle = [];
  for (let i = 0; i < n; i++) circle.push([Math.cos((i / n) * Math.PI * 2) * 5, Math.sin((i / n) * Math.PI * 2) * 5]);
  const back = polygonOffset(polygonOffset(circle, 1, { join: 'round' }), -1, { join: 'round' });
  near(polygonArea(back), Math.abs(signedArea(circle)), 0.05, 'area');
});

test('stroke: straight bands, caps and joins', () => {
  const line = [
    [0, 0],
    [10, 0],
  ];
  const bend = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  const straight = [
    [0, 0],
    [10, 0],
    [20, 0],
  ];
  assert.equal(polygonArea(polygonStroke(line, 2)), 20);
  assert.equal(polygonArea(polygonStroke(line, 2, { cap: 'square' })), 24);
  near(polygonArea(polygonStroke(line, 2, { cap: 'round' })), 20 + Math.PI, 0.01, 'round caps');
  assert.equal(polygonArea(polygonStroke(bend, 2)), 40);
  assert.equal(polygonStroke(straight, 2)[0].contour.length, 4, 'a straight run has no joint');
  assert.deepEqual(polygonStroke(line, 0), []);
  assert.deepEqual(polygonStroke([[1, 1]], 2), []);
  assert.throws(() => polygonStroke(line, -1), RangeError);
  assert.throws(() => polygonStroke(line, 1, { cap: 'flat' }), RangeError);
});

test('stroke: closed loops have a hole and crossings merge', () => {
  const loop = polygonStroke(square(0, 0, 10), 2, { closed: true });
  assert.equal(loop.length, 1);
  assert.equal(loop[0].holes.length, 1);
  assert.equal(polygonArea(loop), 144 - 64);
  const crossing = polygonStroke(
    [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ],
    1,
  );
  assert.equal(crossing.length, 1);
  assertValid(crossing);
});

test('a stroke holds exactly the points within half its width of the line', () => {
  const next = random(5),
    line = [];
  for (let i = 0; i < 40; i++) line.push([i, Math.sin(i * 0.7) * 6 + next()]);
  const result = polygonStroke(line, 2, { join: 'round', cap: 'round' });
  assertValid(result, 'road');
  for (let i = 0; i < 2000; i++) {
    const x = next() * 44 - 2,
      y = next() * 20 - 10;
    let distance = Infinity;
    for (let j = 0; j + 1 < line.length; j++)
      distance = Math.min(distance, segmentDistance(line[j], line[j + 1], x, y));
    if (Math.abs(distance - 1) < 0.01) continue;
    assert.equal(inPolygons(result, x, y), distance < 1, `at ${x}, ${y}: ${distance}`);
  }
});

test('finely sampled outlines offset and stroke by the same rule', () => {
  const corners = 4000,
    ring = [];
  for (let i = 0; i < corners; i++) {
    const angle = (i / corners) * Math.PI * 2,
      r = 10 * (1 + 0.1 * Math.sin(angle * 37));
    ring.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  const next = random(9),
    grown = polygonOffset(ring, 0.5, { join: 'round' }),
    band = polygonStroke(ring, 1, { join: 'round', closed: true });
  for (let i = 0; i < 300; i++) {
    const x = next() * 26 - 13,
      y = next() * 26 - 13,
      distance = ringDistance(ring, x, y);
    if (Math.abs(distance - 0.5) < 0.01) continue;
    assert.equal(inPolygons(grown, x, y), inRing(ring, x, y) || distance < 0.5, `outset at ${x}, ${y}`);
    assert.equal(inPolygons(band, x, y), distance < 0.5, `band at ${x}, ${y}`);
  }
});
