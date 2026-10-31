// Picking lines through the Raycaster: intersectLines from @margoengine/bvh/lines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Raycaster } from '../dist/index.js';
import { intersectLines } from '../dist/lines.js';
import { SegmentTree } from '../dist/segment-tree.js';
import { GridHelper, Line } from '../../lines/dist/index.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const down = (x, y, z = 5) => new Raycaster([x, y, z], [0, 0, -1]);
/** 10 pixels per world unit over a 200 by 200 canvas, looking down -z. */
const ortho = { matrix: [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, -0.01, 0, 0, 0, 0.5, 1], width: 200, height: 200 };
/** Eye at (0, 0, 5) looking down -z over 100 by 100: 20 pixels per world unit at z = 0, 5 at z = -15. */
const perspective = { matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, -1, 0, 0, 0.1, 5], width: 100, height: 100 };
const toward = (x, y, z) => new Raycaster([0, 0, 5], [x, y, z - 5]);
const close = (actual, expected, label) => {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-5, `${label}: ${actual} vs ${expected}`);
};
const strip = (options = {}) => new Line({ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], ...options });
const world = { tolerance: 0.5, toleranceUnits: 'world' };

test('a hit names the line, segment, point, distance and offset', () => {
  const line = strip();
  assert.deepEqual(intersectLines(down(1.5, 0.25), [line], world), [
    { line, segment: 1, point: [1.5, 0, 0], distance: 5, offset: 0.25 },
  ]);
});

test('hits behind the ray origin do not count', () => {
  assert.deepEqual(intersectLines(down(1.5, 0, -5), [strip()], world), []);
  // Inside the tolerance of the origin, but behind it.
  assert.deepEqual(intersectLines(down(1.5, 0, -0.01), [strip()], world), []);
  // A segment through the origin along the ray: the part ahead counts, from distance 0.
  const along = new Line({ positions: [1, 0, -1, 1, 0, 1] });
  const [hit] = intersectLines(down(1, 0, 0), [along], world);
  assert.equal(hit.distance, 0);
  assert.deepEqual(hit.point, [1, 0, 0]);
});

test('near and far bound the hit point', () => {
  const near = down(1.5, 0);
  near.near = 5.5;
  assert.deepEqual(intersectLines(near, [strip()], world), []);
  const far = down(1.5, 0);
  far.far = 4.5;
  assert.deepEqual(intersectLines(far, [strip()], world), []);
  const edge = down(1.5, 0);
  edge.far = 5;
  assert.equal(intersectLines(edge, [strip()], world).length, 1);
});

test('tolerance edge, world units', () => {
  const pick = (tolerance) => intersectLines(down(1.5, 0.25), [strip()], { tolerance, toleranceUnits: 'world' });
  assert.equal(pick(0.25).length, 1);
  assert.equal(pick(0.2499).length, 0);
});

test('tolerance edge, pixels', () => {
  const pick = (tolerance) => intersectLines(down(1.5, 0.5), [strip()], { tolerance, view: ortho });
  assert.equal(pick(5).length, 1);
  assert.equal(pick(4.99).length, 0);
});

test('default tolerance is 3 pixels and a fat line hits across its drawn width', () => {
  const pick = (y, line = strip()) => intersectLines(down(1.5, y), [line], { view: ortho });
  assert.equal(pick(0.3).length, 1);
  assert.equal(pick(0.31).length, 0);
  assert.equal(pick(0.9, strip({ width: 20 })).length, 1);
  assert.equal(pick(1, strip({ width: 20 })).length, 1);
  assert.equal(pick(1.01, strip({ width: 20 })).length, 0);
  // A width in world units: half of 4, at any zoom.
  assert.equal(pick(2, strip({ width: 4, worldUnits: true })).length, 1);
  assert.equal(pick(2.01, strip({ width: 4, worldUnits: true })).length, 0);
  // Its drawn width needs no view.
  assert.equal(intersectLines(down(1.5, 2), [strip({ width: 4, worldUnits: true })]).length, 1);
  assert.equal(intersectLines(down(1.5, 2.01), [strip({ width: 4, worldUnits: true })]).length, 0);
});

test('a pixel width stays that many pixels at any distance', () => {
  const far = new Line({ positions: [-1, 0, -15, 1, 0, -15], width: 12 });
  // At z = -15 one world unit is 5 pixels: half of 12 pixels is 1.2 units.
  const pick = (y) => intersectLines(toward(0, y, -15), [far], { view: perspective });
  const [hit] = pick(1.19);
  assert.equal(hit.segment, 0);
  close(hit.point, [0, 0, -15], 'point');
  assert.equal(pick(1.21).length, 0);
  const near = new Line({ positions: [-1, 0, 0, 1, 0, 0], width: 12 });
  // At z = 0 one world unit is 20 pixels: 0.3 units.
  assert.equal(intersectLines(toward(0, 0.29, 0), [near], { view: perspective }).length, 1);
  assert.equal(intersectLines(toward(0, 0.31, 0), [near], { view: perspective }).length, 0);
});

test('the point on a receding segment is perspective correct', () => {
  // (1, 0, 0) is at pixel x 20, (1, 0, -15) at x 5; pixel x 10 is a third of the way in world, two thirds on screen.
  const line = new Line({ positions: [1, 0, 0, 1, 0, -15] });
  const [hit] = intersectLines(toward(1, 0.2, -5), [line], { view: perspective });
  close(hit.point, [1, 0, -5], 'point');
  assert.ok(Math.abs(hit.distance - 101 / Math.hypot(1, 0.2, 10)) < 1e-5);
});

test('a line through the camera plane clips like the drawn one; wholly behind it misses', () => {
  const through = new Line({ positions: [1, 0, -5, 1, 0, 10] });
  const [hit] = intersectLines(toward(1, 0.2, -5), [through], { view: perspective });
  close(hit.point, [1, 0, -5], 'point');
  const behind = new Line({ positions: [1, 0, 6, 1, 0, 10] });
  assert.deepEqual(intersectLines(toward(1, 0, -5), [behind], { view: perspective }), []);
});

test('a transformed line hits in world space', () => {
  // Scale x by 2, move up 3.
  const line = strip({ matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1] });
  const [hit] = intersectLines(down(3, 3.25), [line], world);
  assert.equal(hit.segment, 1);
  assert.deepEqual(hit.point, [3, 3, 0]);
  assert.equal(hit.offset, 0.25);
  // The untransformed place misses.
  assert.deepEqual(intersectLines(down(1.5, 0.25), [line], world), []);
  // Quarter turn about z: local +x runs along world +y.
  const turned = strip({ matrix: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  const [spun] = intersectLines(down(0.25, 2.5), [turned], world);
  assert.equal(spun.segment, 2);
  assert.deepEqual(spun.point, [0, 2.5, 0]);
});

test('a tolerance stays in world units under a squashing matrix', () => {
  // Local y 4 is world y 1: 0.25 world units is one local unit, and the tree must search that far.
  const line = new Line({
    positions: [0, 4, 0, 1, 4, 0, 2, 4, 0],
    matrix: [1, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  });
  const pick = (y, tolerance) => intersectLines(down(1.5, y), [line], { tolerance, toleranceUnits: 'world' });
  assert.equal(pick(1.25, 0.25).length, 1);
  assert.equal(pick(1.25, 0.2499).length, 0);
  assert.equal(pick(1.25, 0.25)[0].point[1], 1);
});

test('a matrix that cannot invert draws nothing to pick', () => {
  const line = strip({ matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] });
  assert.deepEqual(intersectLines(down(0, 0), [line], world), []);
});

test('neighbouring segments give one hit, the closest; a second crossing gives a second', () => {
  const [one, ...rest] = intersectLines(down(1.1, 0.25), [strip()], world);
  assert.equal(rest.length, 0);
  assert.equal(one.segment, 1);
  // On a shared point both are equally close: the lower segment answers.
  const shared = intersectLines(down(1, 0), [strip()], world);
  assert.deepEqual(
    shared.map((h) => h.segment),
    [0],
  );
  // Out along x at z = 0 and back at z = -1, with a joining segment: crossed at two depths.
  const fold = new Line({ positions: [0, 0, 0, 2, 0, 0, 2, 0, -1, 0, 0, -1] });
  const hits = intersectLines(down(1, 0), [fold], world);
  assert.deepEqual(
    hits.map((h) => [h.segment, h.distance]),
    [
      [0, 5],
      [2, 6],
    ],
  );
  // Independent segments never merge.
  const pairs = new Line({ mode: 'segments', positions: [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0] });
  assert.deepEqual(
    intersectLines(down(1, 0), [pairs], world).map((h) => h.segment),
    [0, 1],
  );
});

test('segment indices follow the line mode', () => {
  const square = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0];
  const loop = new Line({ mode: 'loop', positions: square });
  assert.deepEqual(
    intersectLines(down(0, 1), [loop], world).map((h) => h.segment),
    [3],
  );
  // Open as a strip: no closing segment.
  assert.deepEqual(intersectLines(down(0, 1), [new Line({ positions: square })], world), []);
  const pairs = new Line({ mode: 'segments', positions: square });
  assert.deepEqual(
    intersectLines(down(1, 2), [pairs], world).map((h) => h.segment),
    [1],
  );
  assert.deepEqual(intersectLines(down(2, 1), [pairs], world), []);
  // The loop's first and last segments meet at point 0: one crossing, not two.
  assert.equal(intersectLines(down(0, 0), [loop], world).length, 1);
  // A second run elsewhere on the loop stays separate from the merged one.
  const narrow = new Line({ mode: 'loop', positions: [0, 0, 0, 2, 0, 0, 2, 0, -1, 0, 0, -1] });
  assert.deepEqual(
    intersectLines(down(1, 0), [narrow], world).map((h) => h.segment),
    [0, 2],
  );
});

test('dash gaps hit: a dashed line picks as one continuous line', () => {
  const dashed = strip({ dashed: true, dashSize: 0.25, gapSize: 0.25 });
  // Line distance 0.3 is in the first gap, 0.1 in the first dash.
  dashed.updateDistances(dashed.matrix);
  const inGap = intersectLines(down(0.3, 0), [dashed], world),
    inDash = intersectLines(down(0.1, 0), [dashed], world);
  assert.deepEqual(inGap[0].point, [0.3, 0, 0]);
  assert.equal(inGap.length, 1);
  assert.equal(inDash.length, 1);
});

test('clipping planes, visibility and firstHitOnly', () => {
  // Keeps x >= 1.
  const planes = { clippingPlanes: [[1, 0, 0, -1]] };
  assert.deepEqual(intersectLines(down(0.25, 0), [strip(planes)], world), []);
  assert.equal(intersectLines(down(1.5, 0), [strip(planes)], world).length, 1);
  const both = {
    clippingPlanes: [
      [1, 0, 0, -1],
      [0, 0, 1, -1],
    ],
    clipIntersection: true,
  };
  // Behind one plane only: kept under clipIntersection.
  assert.equal(intersectLines(down(1.5, 0), [strip(both)], world).length, 1);
  const hidden = strip();
  hidden.visible = false;
  assert.deepEqual(intersectLines(down(1.5, 0), [hidden], world), []);
  const back = new Line({ positions: [0, 0, -2, 3, 0, -2] }),
    front = strip();
  const sorted = intersectLines(down(1.5, 0), [back, front], world);
  assert.deepEqual(
    sorted.map((h) => h.line),
    [front, back],
  );
  const first = down(1.5, 0);
  first.firstHitOnly = true;
  assert.deepEqual(
    intersectLines(first, [back, front], world).map((h) => h.line),
    [front],
  );
  assert.deepEqual(intersectLines(down(1.5, 0), [new Line()], world), []);
});

test('picks follow new points and a new mode', () => {
  const line = strip();
  assert.equal(intersectLines(down(1.5, 0), [line], world)[0].segment, 1);
  line.setPositions([1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]);
  assert.equal(intersectLines(down(1.5, 0), [line], world)[0].segment, 0);
  // Far from the old points: a stale tree would never reach them.
  line.setPositions([100, 0, 0, 101, 0, 0, 102, 0, 0, 103, 0, 0]);
  assert.equal(intersectLines(down(101.5, 0), [line], world)[0].segment, 1);
  line.setPositions([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]);
  assert.deepEqual(intersectLines(down(0, 1), [line], world), []);
  line.mode = 'loop';
  assert.equal(intersectLines(down(0, 1), [line], world)[0].segment, 3);
});

test('errors name the fix', () => {
  const ray = down(0, 0),
    line = strip();
  assert.throws(() => intersectLines(ray, [line], { tolerance: -1, toleranceUnits: 'world' }), RangeError);
  assert.throws(() => intersectLines(ray, [line], { tolerance: NaN, view: ortho }), RangeError);
  assert.throws(() => intersectLines(ray, [line], { toleranceUnits: 'feet', view: ortho }), TypeError);
  assert.throws(() => intersectLines(ray, [line], { tolerance: 3 }), /pass engine or view/);
  assert.throws(() => intersectLines(ray, [line]), /pixel width needs a view/);
  assert.throws(() => intersectLines(ray, [line], { view: { matrix: [], width: 1, height: 1 } }), RangeError);
  assert.throws(() => intersectLines(ray, [line], { view: { ...ortho, width: 0 } }), RangeError);
  const backwards = down(0, 0);
  backwards.far = -1;
  assert.throws(() => intersectLines(backwards, [line], world), RangeError);
});

async function engineFixture() {
  return new Engine(
    { width: 100, height: 100, clientWidth: 100, clientHeight: 100 },
    await TransformStore.create(16),
    { backend: 'webgpu', gpu: mockGPU().device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 5], target: [0, 0, 0] },
    null,
  );
}

test('through a real Raycaster and engine: pointer pick, attached lines, hidden meshes, helpers', async () => {
  const engine = await engineFixture();
  const pointer = (x, y) => new Raycaster().setFromEngine(engine, x, y);
  const free = new Line({ positions: [-1, 0, 0, 1, 0, 0], width: 4 });
  // The canvas centre looks straight at the origin.
  const [hit] = intersectLines(pointer(50, 50), [free], { engine });
  assert.equal(hit.line, free);
  close(hit.point, [0, 0, 0], 'centre');
  assert.equal(hit.distance, 5);
  assert.deepEqual(intersectLines(pointer(50, 20), [free], { engine }), []);

  // The picked pixel tracks a mesh moved since the last render.
  const mesh = engine.createMesh();
  const attached = new Line({ positions: [-1, 0, 0, 1, 0, 0], width: 4, mesh });
  mesh.setPosition([0, 1, 0]);
  assert.deepEqual(intersectLines(pointer(50, 50), [attached], { engine }), []);
  const moved = new Raycaster([0, 1, 5], [0, 0, -1]);
  close(intersectLines(moved, [attached], { engine })[0].point, [0, 1, 0], 'attached');
  mesh.visible = false;
  assert.deepEqual(intersectLines(moved, [attached], { engine }), []);
  mesh.visible = true;
  assert.throws(() => intersectLines(moved, [attached], world), /needs the engine/);

  // A helper's update runs as it does before drawing, on the line itself.
  const grid = new GridHelper({ size: 10, divisions: 10 });
  assert.equal(intersectLines(new Raycaster([1, 0, 5], [0, 0, -1]), [grid], { engine }).length > 0, true);
  let updates = 0;
  class Skipped extends Line {
    update() {
      assert.equal(this, skipped);
      updates++;
      return false;
    }
  }
  const skipped = new Skipped({ positions: [-1, 0, 0, 1, 0, 0] });
  assert.deepEqual(intersectLines(pointer(50, 50), [skipped], { engine }), []);
  assert.equal(updates, 1);
  engine.dispose();
  assert.throws(() => intersectLines(down(0, 0), [free], { engine }), /disposed/);
});

/** A repeatable random walk. */
function walk(count, seed = 1) {
  let s = seed;
  const random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const out = new Float32Array(count * 3);
  let x = 0,
    y = 0,
    z = -10;
  for (let i = 0; i < count; i++) {
    x = Math.max(-8, Math.min(8, x + random() * 0.4));
    y = Math.max(-8, Math.min(8, y + random() * 0.4));
    z = Math.max(-16, Math.min(-4, z + random() * 0.4));
    out.set([x, y, z], i * 3);
  }
  return { positions: out, random };
}
const segmentGap = (o, d, a, b) => {
  // Densely sampled: an independent reference for the closed-form distance, within the sampling step.
  let best = Infinity;
  for (let k = 0; k <= 32; k++) {
    const p = [0, 1, 2].map((i) => a[i] + ((b[i] - a[i]) * k) / 32 - o[i]);
    const t = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
    best = Math.min(best, Math.hypot(p[0] - t * d[0], p[1] - t * d[1], p[2] - t * d[2]));
  }
  return best;
};

test('the tree finds what testing every segment finds, world and pixel radius, with a skewed matrix', () => {
  const { positions, random } = walk(4000);
  const model = [1.5, 0.2, 0, 0, 0, 0.5, 0.3, 0, 0, 0, 1.2, 0, 0.5, -0.25, 0.25, 1];
  const line = new Line({ mode: 'segments', positions, matrix: model });
  const at = (i) => {
    const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    return [
      model[0] * x + model[4] * y + model[8] * z + model[12],
      model[1] * x + model[5] * y + model[9] * z + model[13],
      model[2] * x + model[6] * y + model[10] * z + model[14],
    ];
  };
  const screen = (p) => {
    const w = 5 - p[2];
    return [((2 * p[0]) / w) * 50, ((2 * p[1]) / w) * 50];
  };
  let total = 0;
  for (let ray = 0; ray < 60; ray++) {
    const target = [random() * 8, random() * 8, -10];
    const raycaster = toward(target[0], target[1], target[2]);
    const o = raycaster.origin,
      d = raycaster.direction,
      pointer = screen(target);
    const got = new Set(
      intersectLines(raycaster, [line], { tolerance: 0.1, toleranceUnits: 'world' }).map((h) => h.segment),
    );
    const pixels = new Set(
      intersectLines(raycaster, [line], { tolerance: 3, view: perspective }).map((h) => h.segment),
    );
    for (let s = 0; s < line.segmentCount; s++) {
      const a = at(s * 2),
        b = at(s * 2 + 1),
        gap = segmentGap(o, d, a, b);
      // Within 2 percent of the edge the sampled reference can disagree with the closed form; both answers are right.
      if (gap < 0.098) assert.ok(got.has(s), `world ${s}`);
      if (gap > 0.102) assert.ok(!got.has(s), `world ${s}`);
      const sa = screen(a),
        sb = screen(b),
        ex = sb[0] - sa[0],
        ey = sb[1] - sa[1],
        length2 = ex * ex + ey * ey,
        u = length2 ? Math.max(0, Math.min(1, ((pointer[0] - sa[0]) * ex + (pointer[1] - sa[1]) * ey) / length2)) : 0,
        off = Math.hypot(pointer[0] - sa[0] - u * ex, pointer[1] - sa[1] - u * ey);
      if (off < 2.999) assert.ok(pixels.has(s), `pixels ${s} at ${off}`);
      if (off > 3.001) assert.ok(!pixels.has(s), `pixels ${s} at ${off}`);
      total += off < 3 ? 1 : 0;
    }
  }
  assert.ok(total > 60, `the rays hit something: ${total}`);
});

test('100,000 segments: a pick tests a few segments, not all of them', () => {
  const count = 100_001,
    positions = new Float32Array(count * 4),
    pairs = new Uint32Array((count - 1) * 2);
  for (let i = 0; i < count; i++) {
    const a = i * 0.001;
    positions[i * 4] = Math.cos(a) * (1 + a / 100);
    positions[i * 4 + 1] = Math.sin(a) * (1 + a / 100);
    positions[i * 4 + 2] = -a / 50;
    if (i < count - 1) {
      pairs[i * 2] = i;
      pairs[i * 2 + 1] = i + 1;
    }
  }
  const tree = new SegmentTree(positions, 4, pairs);
  const visits = tree.query(
    {
      origin: [1, 0, 5],
      direction: [0, 0, -1],
      near: 0,
      far: Infinity,
      radius: 0.01,
      spread: 0,
      depth: [0, 0, 0, 0],
      scale: 1,
    },
    () => {},
  );
  assert.ok(visits > 0 && visits < 3000, `visited ${visits} of 100000`);
});

test('importing lines or the bvh root pays nothing: neither reaches this entry', () => {
  const lines = readFileSync(new URL('../../lines/dist/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(lines, /margoengine\/bvh|intersectLines/);
  const root = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(root, /lines\.js|segment-tree/);
});
