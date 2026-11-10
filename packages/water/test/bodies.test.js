import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { WaterBodies, rasterizeWaterBodies, sampleWaterBodies } from '../dist/bodies.js';

const square = (cx, cz, half) => [
  [cx - half, cz - half],
  [cx + half, cz - half],
  [cx + half, cz + half],
  [cx - half, cz + half],
];

test('an outline body holds its level inside and an exact signed distance to its edge', () => {
  const map = rasterizeWaterBodies([{ outline: square(0, 0, 10), level: 2, waves: 0.25 }], 128);
  // Corner-sampled texels: the centre and the edges are exact, so a bilinear read between texels can only err by the
  // distance field's curvature, which is zero along an edge's straight middle.
  const centre = sampleWaterBodies(map, 0, 0);
  assert.ok(Math.abs(centre.distance - 10) < 0.2, `centre ${centre.distance}`);
  assert.equal(centre.level, 2);
  assert.equal(centre.waves, 0.25);
  assert.equal(centre.body, 0);
  for (const [x, expected] of [
    [9, 1],
    [10.1, -0.1],
    [10.2, -0.2],
  ]) {
    const d = sampleWaterBodies(map, x, 0.3).distance;
    assert.ok(Math.abs(d - expected) < 1e-4, `distance at ${x}: ${d}`);
  }
  // Past its two-texel margin the map clamps, so far outside still reads outside.
  assert.ok(sampleWaterBodies(map, 500, -500).distance < 0);
});

test('a non-convex outline is inside only where its shape is', () => {
  const l = [
    [0, 0],
    [20, 0],
    [20, 6],
    [6, 6],
    [6, 20],
    [0, 20],
  ];
  const map = rasterizeWaterBodies([{ outline: l }], 256);
  assert.ok(sampleWaterBodies(map, 3, 15).distance > 2);
  assert.ok(sampleWaterBodies(map, 15, 3).distance > 2);
  assert.ok(sampleWaterBodies(map, 14, 14).distance < -7);
});

test('a river path follows its spline with its width and a falling level', () => {
  const river = {
    path: [
      [0, 10, 0],
      [20, 8, 0],
      [40, 4, 0],
    ],
    width: 6,
  };
  const map = rasterizeWaterBodies([river], 512);
  // The spline passes through its points; level and half width match there.
  for (const [x, level] of [
    [0, 10],
    [20, 8],
    [40, 4],
  ]) {
    const s = sampleWaterBodies(map, x, 0);
    assert.ok(Math.abs(s.level - level) < 0.05, `level at ${x}: ${s.level}`);
    assert.ok(Math.abs(s.distance - 3) < 0.1, `half width at ${x}: ${s.distance}`);
  }
  assert.ok(Math.abs(sampleWaterBodies(map, 20, 3).distance) < 0.1, 'bank at half width');
  assert.ok(sampleWaterBodies(map, 20, 6).distance < 0);
  // Level falls monotonically downstream.
  let last = Infinity;
  for (let x = 0; x <= 40; x += 2) {
    const s = sampleWaterBodies(map, x, 0).level;
    assert.ok(s <= last + 1e-6, `level rises at ${x}`);
    last = s;
  }
});

test('overlapping bodies: a later one covers an earlier one, with its own level and index', () => {
  const map = rasterizeWaterBodies(
    [
      { outline: square(0, 0, 20), level: 0 },
      { outline: square(5, 0, 3), level: 1, waves: 0, color: [0, 0.5, 0.2] },
    ],
    256,
  );
  assert.equal(sampleWaterBodies(map, 5, 0).body, 1);
  assert.equal(sampleWaterBodies(map, 5, 0).level, 1);
  assert.equal(sampleWaterBodies(map, -10, 0).body, 0);
});

test('bodies validate input, copy what they keep and report bounds', () => {
  const surface = new Water();
  for (const bodies of [
    [],
    [{}],
    [
      {
        outline: square(0, 0, 1),
        path: [
          [0, 0, 0],
          [1, 0, 1],
        ],
      },
    ],
    [
      {
        outline: [
          [0, 0],
          [1, 1],
        ],
      },
    ],
    [
      {
        outline: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      },
    ],
    [{ outline: square(0, 0, 1), width: 2 }],
    [{ path: [[0, 0, 0]] }],
    [
      {
        path: [
          [0, 0, 0],
          [1, 0, 1],
        ],
        level: 1,
      },
    ],
    [
      {
        path: [
          [0, 0, 0],
          [1, 0, 1],
        ],
        width: [1],
      },
    ],
    [
      {
        path: [
          [0, 0, 0],
          [1, 0, 1],
        ],
        width: 0,
      },
    ],
    [{ outline: square(0, 0, 1), waves: 2 }],
    [{ outline: square(0, 0, 1), color: [1, 1] }],
    [{ outline: square(0, 0, 1), level: NaN }],
    Array.from({ length: 65 }, () => ({ outline: square(0, 0, 1) })),
  ])
    assert.throws(() => new WaterBodies({ surface, bodies }), /water bod/i);
  assert.throws(() => new WaterBodies({ surface, bodies: [{ outline: square(0, 0, 1) }], resolution: 8 }));
  assert.throws(() => new WaterBodies({ bodies: [] }), /surface/);
  const outline = square(10, -4, 5);
  const bodies = new WaterBodies({ surface, bodies: [{ outline, level: 3 }], resolution: 64 });
  outline[0][0] = NaN;
  assert.equal(bodies.bodies[0].outline[0][0], 5);
  const { origin, size } = bodies.bounds;
  assert.ok(origin[0] < 5 && origin[1] < -9 && origin[0] + size[0] > 15 && origin[1] + size[1] > 1);
  assert.equal(bodies.sample(10, -4).level, 3);
  assert.equal(bodies.setBodies([{ outline: square(0, 0, 2), level: -1 }]), bodies);
  assert.equal(bodies.sample(0, 0).level, -1);
  bodies.dispose();
  bodies.dispose();
  assert.throws(() => bodies.sample(0, 0), { code: 'disposed' });
  surface.dispose();
});
