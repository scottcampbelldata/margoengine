import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CatmullRomCurve3,
  extrudeGeometry,
  isClockWise,
  mergeOverlappingPoints,
  Path,
  Shape,
  shapeArea,
  shapeGeometry,
  triangulateShape,
} from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/extrude-vectors.json', import.meta.url), 'utf8')).extrude;

// ---------- helpers (first principles) ----------

const P = (d, i) => [d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function metrics(d) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < d.positions.length / 3; i++)
    P(d, i).forEach((v, k) => {
      min[k] = Math.min(min[k], v);
      max[k] = Math.max(max[k], v);
    });
  let area = 0,
    volume = 0,
    degenerate = 0,
    disagree = 0;
  for (let t = 0; t < d.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => P(d, d.indices[t + k])),
      n = crossV(sub(b, a), sub(c, a)),
      length = Math.hypot(...n);
    area += length / 2;
    volume += dot(a, crossV(b, c)) / 6;
    if (length < 1e-9) {
      degenerate++;
      continue;
    }
    for (let k = 0; k < 3; k++) {
      const i = d.indices[t + k];
      if (dot(n, [d.normals[i * 3], d.normals[i * 3 + 1], d.normals[i * 3 + 2]]) <= 0) disagree++;
    }
  }
  return {
    vertices: d.positions.length / 3,
    groups: (d.groups ?? []).map((g) => [g.start, g.count, g.materialIndex]),
    min,
    max,
    area,
    volume,
    degenerate,
    disagree,
  };
}
const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

// The shapes the vectors were recorded with: a 4 x 2.5 rectangle with a 12-gon hole and a unit square hole, and a
// 4 x 4 square with two unit square holes.
const holey = () => {
  const s = new Shape([
    [-2, -1],
    [2, -1],
    [2, 1.5],
    [-2, 1.5],
  ]);
  const circle = Array.from({ length: 13 }, (_, i) => [
    -0.8 + 0.4 * Math.cos((i / 12) * 2 * Math.PI),
    0.2 + 0.4 * Math.sin((i / 12) * 2 * Math.PI),
  ]);
  s.holes = [
    new Path(circle),
    new Path([
      [0.5, -0.5],
      [1.5, -0.5],
      [1.5, 0.5],
      [0.5, 0.5],
    ]),
  ];
  return s;
};
const square = (h, cx = 0, cy = 0) => [
  [cx - h, cy - h],
  [cx + h, cy - h],
  [cx + h, cy + h],
  [cx - h, cy + h],
];
const squareWithHoles = (reversed = false) => {
  const f = (ring) => (reversed ? ring.slice().reverse() : ring),
    s = new Shape(f(square(2)));
  s.holes = [new Path(f(square(0.5, -1, -1))), new Path(f(square(0.5, 1, 1)))];
  return s;
};

const cases = {
  'shape holey 6': () => shapeGeometry(holey(), 6),
  'shape square with 2 square holes': () => shapeGeometry(squareWithHoles()),
  'shape array of two': () => shapeGeometry([squareWithHoles(), new Shape(square(1, 6, 0))]),
  'extrude holey bevel': () =>
    extrudeGeometry(holey(), { curveSegments: 6, depth: 0.5, bevelSegments: 2, bevelThickness: 0.1, bevelSize: 0.05 }),
  'extrude holey flat': () => extrudeGeometry(holey(), { curveSegments: 6, depth: 0.7, steps: 2, bevelEnabled: false }),
  'extrude sq defaults': () => extrudeGeometry(squareWithHoles()),
  'extrude sq flat steps 3': () => extrudeGeometry(squareWithHoles(), { bevelEnabled: false, steps: 3, depth: 2 }),
  'extrude sq bevel 4': () => extrudeGeometry(squareWithHoles(), { steps: 2, bevelSegments: 4 }),
  'extrude sq reversed rings': () => extrudeGeometry(squareWithHoles(true), { bevelEnabled: false }),
  'extrude along path': () =>
    extrudeGeometry(new Shape(square(0.3)), {
      steps: 40,
      extrudePath: new CatmullRomCurve3([
        [0, 0, 0],
        [2, 3, 1],
        [5, 3, -2],
        [8, 0, 0],
      ]),
    }),
};

// ---------- recorded vectors ----------

test('shape and extrude geometry match the recorded counts, groups, bounds, area and volume', () => {
  for (const [name, build] of Object.entries(cases)) {
    const g = build(),
      m = metrics(g),
      v = vectors[name],
      // The path sweep's frame start is free; it is bound only to 1e-3.
      rel = name.includes('path') ? 1e-3 : 1e-5;
    assert.equal(m.vertices, v.vertices, `${name} vertices`);
    assert.deepEqual(m.groups, v.groups, `${name} groups`);
    for (let k = 0; k < 3; k++) {
      near(m.min[k], v.bboxMin[k], rel, `${name} bbox min ${k}`);
      near(m.max[k], v.bboxMax[k], rel, `${name} bbox max ${k}`);
    }
    near(m.area, v.area, rel, `${name} area`);
    near(m.volume, v.signedVolume, rel, `${name} volume`);
    assert.equal(m.disagree, 0, `${name}: normals oppose the winding`);
    if (name.startsWith('extrude')) assert.equal(m.degenerate, 0, `${name}: degenerate triangles`);
    if (name.startsWith('shape')) {
      // uv = (x, y) of the shape.
      for (let i = 0; i < m.vertices; i++) {
        assert.equal(g.uvs[i * 2], g.positions[i * 3], `${name} u`);
        assert.equal(g.uvs[i * 2 + 1], g.positions[i * 3 + 1], `${name} v`);
      }
      for (let k = 0; k < 2; k++) {
        near(Math.min(...g.uvs.filter((_, i) => i % 2 === k)), v.uvMin[k], 1e-6, `${name} uv min`);
        near(Math.max(...g.uvs.filter((_, i) => i % 2 === k)), v.uvMax[k], 1e-6, `${name} uv max`);
      }
    }
  }
});

test('extrude caps carry their vertex (x, y) as UV; walls run u along the outline and v along the depth', () => {
  for (const name of ['extrude sq defaults', 'extrude holey bevel', 'extrude along path']) {
    const g = cases[name](),
      caps = g.groups[0],
      walls = g.groups[1];
    for (let i = caps.start; i < caps.start + caps.count; i++) {
      assert.equal(g.uvs[i * 2], g.positions[i * 3], `${name} cap u`);
      assert.equal(g.uvs[i * 2 + 1], g.positions[i * 3 + 1], `${name} cap v`);
    }
    if (name.includes('path')) continue;
    for (let i = walls.start; i < walls.start + walls.count; i++)
      assert.ok(Math.abs(g.uvs[i * 2 + 1] - g.positions[i * 3 + 2]) < 1e-6, `${name} wall v = z`);
  }
  // u along a 4 x 4 square's walls covers its perimeter of 16.
  const g = extrudeGeometry(new Shape(square(2)), { bevelEnabled: false }),
    us = g.uvs.filter((_, i) => i % 2 === 0).slice(g.groups[1].start);
  near(Math.max(...us) - Math.min(...us), 16, 1e-6, 'perimeter');
});

test('mergeOverlappingPoints and triangulateShape follow the recorded cases', () => {
  const merge = vectors.mergeOverlappingPoints,
    tau = 2 * Math.PI,
    round = (pts) => pts.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0));
  const arc = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
    [Math.cos(tau), Math.sin(tau)],
  ];
  const copy = JSON.parse(JSON.stringify(arc));
  assert.deepEqual(round(mergeOverlappingPoints(arc)), merge['full arc end']);
  assert.deepEqual(arc, copy, 'input untouched');
  assert.deepEqual(
    mergeOverlappingPoints([
      [0, 0],
      [0, 0],
      [1, 0],
      [1, 1],
      [1, 1],
      [0, 1],
      [0, 0],
    ]),
    // The closing repeat of the first point goes with the first point (the wrap-around rule).
    [
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  );
  assert.deepEqual(
    mergeOverlappingPoints([
      [0, 0],
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]),
    merge['consecutive duplicates'],
  );
  assert.deepEqual(
    mergeOverlappingPoints([
      [1e6, 0],
      [1e6 + 1e-3, 0],
      [1e6, 1],
    ]),
    merge['far from origin, 1e-3 apart (kept)'],
  );
  assert.deepEqual(mergeOverlappingPoints([[1, 2]]), merge['single point']);
  assert.deepEqual(
    mergeOverlappingPoints([
      [1, 2],
      [1, 2],
      [1, 2],
    ]),
    merge['all same'],
  );
  // Within 1e-10 of the magnitude merges, beyond it does not.
  assert.equal(
    mergeOverlappingPoints([
      [1e6, 0],
      [1e6 + 1e-5, 0],
      [0, 1e6],
    ]).length,
    2,
  );

  const shape = vectors['triangulateShape closing duplicate and small hole'],
    result = triangulateShape(
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
      [
        [
          [1, 1],
          [2, 1],
          [1, 2],
          [1, 1],
        ],
        [
          [3, 3],
          [3.5, 3],
        ],
      ],
    );
  assert.equal(result.contour.length, shape.contourLength);
  assert.deepEqual(
    result.holes.map((h) => h.length),
    shape.holeLengths,
  );
  assert.equal(result.indices.length / 3, shape.triangles);
});

test('shapeArea and isClockWise use the signed shoelace area', () => {
  const v = vectors['isClockWise / shapeArea'],
    ccw = square(1);
  assert.equal(shapeArea(ccw), v['ccw square 2x2 area']);
  assert.equal(isClockWise(ccw), v['ccw isClockWise']);
  assert.equal(isClockWise(ccw.slice().reverse()), v['cw isClockWise']);
  assert.equal(shapeArea([]), v['empty area']);
  assert.equal(isClockWise([]), false);
  assert.equal(shapeArea(ccw.slice().reverse()), -4);
});

// ---------- options and edge cases ----------

test('non-finite steps, curveSegments and (bevel on) bevelSegments throw RangeError', () => {
  const s = new Shape(square(1));
  assert.throws(() => extrudeGeometry(s, { steps: Number.NaN }), RangeError);
  assert.throws(() => extrudeGeometry(s, { curveSegments: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => extrudeGeometry(s, { bevelSegments: Number.NaN }), RangeError);
  assert.doesNotThrow(() => extrudeGeometry(s, { bevelEnabled: false, bevelSegments: Number.NaN }));
  assert.throws(() => shapeGeometry(s, Number.NaN), RangeError);
});

test('negative bevelSegments count as 0: finite geometry equal to bevelSegments 0', () => {
  const s = squareWithHoles(),
    negative = extrudeGeometry(s, { bevelSegments: -2 }),
    zero = extrudeGeometry(s, { bevelSegments: 0 });
  assert.ok(negative.positions.every(Number.isFinite));
  assert.deepEqual(negative.positions, zero.positions);
  // Bevel on with no rounded layers still offsets the body by bevelSize (default 0.1).
  near(metrics(zero).max[0], 2.1, 1e-6, 'offset body');
  near(metrics(zero).max[2], 1, 1e-6, 'no bevel beyond depth');
});

test('steps are floored to at least 1 and a zero depth gives finite zero normals', () => {
  const s = squareWithHoles(),
    half = extrudeGeometry(s, { steps: 0.5, depth: 0, bevelEnabled: false });
  assert.deepEqual(half.positions, extrudeGeometry(s, { steps: 1, depth: 0, bevelEnabled: false }).positions);
  assert.ok(half.normals.every(Number.isFinite));
  const m = metrics(half);
  assert.ok(m.degenerate > 0);
  for (let t = 0; t < half.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => P(half, half.indices[t + k]));
    if (Math.hypot(...crossV(sub(b, a), sub(c, a))) === 0)
      assert.deepEqual([half.normals[t * 3], half.normals[t * 3 + 1], half.normals[t * 3 + 2]], [0, 0, 0]);
  }
});

test('extrusion counts: 2 x 3F cap vertices and 6R(steps + 2 bevelSegments) wall vertices', () => {
  const s = squareWithHoles(),
    F = 12 - 2 + 2 * 2,
    R = 12;
  for (const [options, bands] of [
    [{ bevelEnabled: false, steps: 4 }, 4],
    [{ steps: 2, bevelSegments: 3 }, 2 + 6],
    [{ steps: 1, bevelSegments: 5.7 }, 1 + 10],
  ]) {
    const g = extrudeGeometry(s, options);
    assert.equal(g.groups[0].count, 2 * 3 * F);
    assert.equal(g.groups[1].count, 6 * R * bands);
    assert.equal(g.indices.length, g.positions.length / 3);
    assert.ok(
      g.indices.every((v, i) => v === i),
      'non-indexed: sequential indices',
    );
  }
});

test('the bevel profile is a quarter ellipse from (bevelOffset, -bevelThickness) to the offset body', () => {
  const g = extrudeGeometry(new Shape(square(1)), {
      depth: 2,
      bevelThickness: 0.3,
      bevelSize: 0.2,
      bevelOffset: 0.05,
      bevelSegments: 6,
    }),
    m = metrics(g);
  near(m.min[2], -0.3, 1e-6, 'front');
  near(m.max[2], 2.3, 1e-6, 'back');
  near(m.max[0], 1.25, 1e-6, 'widest outline');
  // Every bevel vertex sits on the ellipse ((d - offset) / size)^2 + (dz / thickness)^2 = 1, where d is how far its
  // sides moved out (at a square corner the miter moves both coordinates by d) and dz how far it is beyond the body.
  let checked = 0;
  for (let i = g.groups[1].start; i < g.groups[1].start + g.groups[1].count; i++) {
    const [x, y, z] = P(g, i);
    if (z >= 0 && z <= 2) continue;
    near(Math.abs(x), Math.abs(y), 1e-6, 'miter corner');
    const d = Math.abs(x) - 1,
      dz = z < 0 ? -z : z - 2;
    near(((d - 0.05) / 0.2) ** 2 + (dz / 0.3) ** 2, 1, 1e-5, 'on the quarter ellipse');
    checked++;
  }
  assert.ok(checked > 0);
});

test('ring winding does not change the solid', () => {
  const a = metrics(extrudeGeometry(squareWithHoles(false))),
    b = metrics(extrudeGeometry(squareWithHoles(true)));
  near(a.volume, b.volume, 1e-9, 'volume');
  near(a.area, b.area, 1e-9, 'area');
});
