import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Camera, Geometry, box } from '@margoengine/core';
import {
  GridHelper,
  PolarGridHelper,
  AxesHelper,
  Box3Helper,
  BoxHelper,
  ArrowHelper,
  CameraHelper,
  PlaneHelper,
  VertexNormalsHelper,
  geometryBounds,
  parseColor,
} from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('./helpers-vectors.json', import.meta.url), 'utf8'));
const TOL = 1e-5;
const near = (a, b, tol = TOL) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

const point = (line, i) => [line.points[i * 4], line.points[i * 4 + 1], line.points[i * 4 + 2]];
const color = (line, i) => [...line.colors.subarray(i * 4, i * 4 + 4)];
const allPoints = (line) => Array.from({ length: line.count }, (_, i) => point(line, i));
const lex = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function segments(line) {
  const out = [];
  for (let i = 0; i < line.count; i += 2) {
    const ends = [point(line, i), point(line, i + 1)],
      colours = line.colors ? [color(line, i), color(line, i + 1)] : [null, null];
    const flip = lex(ends[0], ends[1]) > 0;
    out.push({ a: flip ? ends[1] : ends[0], b: flip ? ends[0] : ends[1], color: colours[0] });
  }
  return out;
}
function bounds(line) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const p of allPoints(line))
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  return { min, max };
}
function totalLength(line) {
  let sum = 0;
  for (let i = 0; i < line.count; i += 2) {
    const a = point(line, i),
      b = point(line, i + 1);
    sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return sum;
}
/** Unordered undirected segment sets equal within TOL (optionally with the start colour). */
function sameSegments(line, expected, withColor = false) {
  const actual = segments(line);
  assert.equal(actual.length, expected.length, 'segment count');
  const used = new Uint8Array(actual.length);
  for (const e of expected) {
    const ends = lex(e.a, e.b) > 0 ? [e.b, e.a] : [e.a, e.b];
    const hit = actual.findIndex(
      (s, i) =>
        !used[i] &&
        ((near(s.a, ends[0]) && near(s.b, ends[1])) || (near(s.a, ends[1]) && near(s.b, ends[0]))) &&
        (!withColor || near(s.color, Array.isArray(e.color[0]) ? e.color[0] : e.color)),
    );
    assert.ok(hit >= 0, `missing segment ${JSON.stringify(e)}`);
    used[hit] = 1;
  }
}
function check(line, name, { colors = false } = {}) {
  const v = vectors.cases[name];
  assert.ok(v, name);
  assert.equal(line.mode, 'segments');
  if (v.pointCount !== undefined) assert.equal(line.count, v.pointCount, `${name}: count`);
  if (v.bounds) {
    const b = bounds(line);
    assert.ok(near(b.min, v.bounds.min) && near(b.max, v.bounds.max), `${name}: bounds ${JSON.stringify(b)}`);
  }
  if (v.totalLength !== undefined)
    assert.ok(Math.abs(totalLength(line) - v.totalLength) <= 1e-4, `${name}: total length ${totalLength(line)}`);
  if (v.canonicalSegments) sameSegments(line, v.canonicalSegments, colors);
  if (v.points)
    v.points.forEach((p, i) => assert.ok(near(point(line, i), p), `${name}: point ${i} ${point(line, i)} vs ${p}`));
  if (v.hasPerPointColors !== undefined) assert.equal(line.colors !== null, v.hasPerPointColors);
}
const helperMaterial = (line) => {
  assert.equal(line.material.cap, 'butt');
  assert.equal(line.material.join, 'miter');
};

function fakeEngine(meshes) {
  const store = { matrices: new Float32Array(16 * 8), hidden: new Uint8Array(8) };
  for (const mesh of meshes) store.matrices.set(mesh.world, mesh.id * 16);
  return {
    disposed: false,
    meshes: new Map(meshes.map((m) => [m.id, m])),
    store,
    camera: new Camera(),
    canvas: { width: 200, height: 100 },
  };
}

test('GridHelper matches the vectors and colours its centre lines', () => {
  const grid = new GridHelper();
  check(grid, 'GridHelper default');
  helperMaterial(grid);
  check(new GridHelper({ size: 4, divisions: 4 }), 'GridHelper size 4 divisions 4');
  const custom = new GridHelper({ size: 2, divisions: 2, color1: '#ff0000', color2: '#0000ff' });
  check(custom, 'GridHelper custom colours', { colors: true });
  const centre = (line, c1) => segments(line).filter((s) => near(s.color.slice(0, 3), [...parseColor(c1)])).length;
  assert.equal(centre(grid, '#8f8f8f'), 2, 'two centre lines for even divisions');
  const odd = new GridHelper({ size: 3, divisions: 3, color1: '#ff0000' });
  check(odd, 'GridHelper size 3 divisions 3 (odd: no centre line)');
  assert.equal(centre(odd, '#ff0000'), 0, 'odd divisions have no centre line');
  // Both ends of every segment share a colour.
  for (let i = 0; i < grid.count; i += 2) assert.deepEqual(color(grid, i), color(grid, i + 1));
  assert.equal(grid.material.color[0], 1, 'per-point colours, white material');
});

test('PolarGridHelper matches the vectors and alternates colours', () => {
  check(new PolarGridHelper({ radius: 2, sectors: 4, rings: 2, divisions: 8 }), 'PolarGridHelper r2 s4 r2 d8');
  check(new PolarGridHelper({ radius: 1, sectors: 0, rings: 1, divisions: 3 }), 'PolarGridHelper r1 s0 r1 d3');
  const polar = new PolarGridHelper({
    radius: 2,
    sectors: 4,
    rings: 3,
    divisions: 6,
    color1: '#ff0000',
    color2: '#0000ff',
  });
  assert.equal(polar.count, 2 * 4 + 2 * 3 * 6);
  const red = [...parseColor('#ff0000'), 1],
    blue = [...parseColor('#0000ff'), 1];
  // Sector i: even red, odd blue; angle 0 on +Z, then toward +X.
  for (let i = 0; i < 4; i++) assert.deepEqual(color(polar, i * 2), i % 2 ? blue : red);
  assert.ok(near(point(polar, 1), [0, 0, 2]) && near(point(polar, 3), [2, 0, 0]));
  // Rings: outermost first, alternating.
  for (let k = 0; k < 3; k++) {
    const first = 8 + k * 12,
      r = Math.hypot(point(polar, first)[0], point(polar, first)[2]);
    assert.ok(Math.abs(r - (2 * (3 - k)) / 3) < TOL, `ring ${k} radius ${r}`);
    assert.deepEqual(color(polar, first), k % 2 ? blue : red);
  }
});

test('AxesHelper draws X, Y, Z with lighter tips and recolours flat', () => {
  const axes = new AxesHelper();
  check(axes, 'AxesHelper default');
  check(new AxesHelper({ size: 2 }), 'AxesHelper size 2');
  for (let axis = 0; axis < 3; axis++) {
    const base = color(axes, axis * 2),
      tip = color(axes, axis * 2 + 1);
    assert.ok(base[axis] > 0.5 && base[axis] >= Math.max(...base.slice(0, 3)), 'dominant channel is the axis');
    assert.ok(tip.slice(0, 3).reduce((a, b) => a + b) > base.slice(0, 3).reduce((a, b) => a + b), 'tip lighter');
  }
  axes.setColors('#0000ff', '#00ff00', '#ff0000');
  check(axes, 'AxesHelper setColors(blue, green, red)', { colors: true });
  for (let i = 0; i < 6; i += 2) assert.deepEqual(color(axes, i), color(axes, i + 1));
  axes.setColors(null);
  check(axes, 'AxesHelper setColors(null)');
  axes.setColors([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(color(axes, 4), [0, 0, 1, 1], 'a per-point array is Line.setColors');
});

test('Box3Helper draws the 12 box edges and replaces them in place', () => {
  const b = new Box3Helper();
  check(b, 'Box3Helper default');
  assert.equal(b.colors, null);
  assert.ok(near([...b.material.color], [...parseColor('#f0931e')]));
  const buffer = b.points;
  b.setBox([-1, -2, -3], [1, 2, 3]);
  check(b, 'Box3Helper [-1,-2,-3]..[1,2,3]');
  assert.equal(b.points, buffer, 'same buffer');
  check(new Box3Helper([0, 0, 0], [0, 0, 0]), 'Box3Helper degenerate [0,0,0]..[0,0,0]');
  b.material.setColor('#00ff00');
  assert.deepEqual([...b.material.color], [0, 1, 0]);
});

test('geometryBounds reads core positions and caches per geometry', () => {
  const g = box(2, 2, 2);
  assert.deepEqual([...geometryBounds(g)], vectors.geometryBounds_box222.map(Number));
  assert.equal(geometryBounds(g), geometryBounds(g));
  assert.deepEqual(
    [...geometryBounds({ vertices: new Float32Array(0) })],
    [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
  );
});

function arrowShape(arrow, { origin, direction, length, headLength, headWidth }) {
  const d = direction.map((v) => v / Math.hypot(...direction)),
    at = (t) => origin.map((o, k) => o + d[k] * t),
    base = at(length - headLength),
    tip = at(length);
  assert.ok(near(point(arrow, 0), origin), 'point 0 is the origin');
  assert.ok(near(point(arrow, 1), base), 'point 1 is the head base (shaft first)');
  let sawTip = false;
  for (let i = 2; i < arrow.count; i++) {
    const p = point(arrow, i);
    if (near(p, tip)) {
      sawTip = true;
      continue;
    }
    const rel = p.map((v, k) => v - base[k]),
      along = rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2];
    assert.ok(Math.abs(along) < TOL, `head point ${i} in the base plane`);
    assert.ok(Math.abs(Math.hypot(...rel) - headWidth / 2) < TOL, `head point ${i} on the base circle`);
  }
  assert.ok(sawTip || headLength === 0, 'spokes reach the tip');
  assert.equal(arrow.colors, null);
}

test('ArrowHelper: shaft first, wire cone in the head-base plane, default proportions follow length', () => {
  const a = new ArrowHelper();
  helperMaterial(a);
  arrowShape(a, { origin: [0, 0, 0], direction: [0, 0, 1], length: 1, headLength: 0.25, headWidth: 0.125 });
  arrowShape(new ArrowHelper({ direction: [0, 2, 0], origin: [1, 0, 0], length: 5 }), {
    origin: [1, 0, 0],
    direction: [0, 1, 0],
    length: 5,
    headLength: 1.25,
    headWidth: 0.625,
  });
  const opts = { direction: [1, 1, 0], length: 2, headLength: 0.5, headWidth: 0.3 };
  arrowShape(new ArrowHelper(opts), { origin: [0, 0, 0], ...opts });
  const flat = new ArrowHelper({ headLength: 0 });
  assert.ok(near(point(flat, 1), [0, 0, 1]));
  assert.ok(
    allPoints(flat).every((p) => near(p, [0, 0, 0]) || near(p, [0, 0, 1])),
    'head collapses onto the tip',
  );
  const count = a.count;
  a.setLength(3);
  arrowShape(a, { origin: [0, 0, 0], direction: [0, 0, 1], length: 3, headLength: 0.75, headWidth: 0.375 });
  a.setDirection([1, 0, 0]).setOrigin([0, 1, 0]);
  arrowShape(a, { origin: [0, 1, 0], direction: [1, 0, 0], length: 3, headLength: 0.75, headWidth: 0.375 });
  assert.equal(a.count, count);
  // No flip of the head's rotation for directions near +Y.
  const first = (dir) => {
    const h = new ArrowHelper({ direction: dir });
    return point(h, 3).map((v, k) => v - point(h, 1)[k]);
  };
  const p0 = first([0, 1, 0]),
    p1 = first([1e-4, 1, 0]),
    p2 = first([0, 1, 1e-4]);
  assert.ok(near(p0, p1, 1e-3) && near(p0, p2, 1e-3), 'stable near +Y');
});

test('PlaneHelper: square and diagonals on the plane, centred nearest the origin', () => {
  const plane = new PlaneHelper();
  check(plane, 'PlaneHelper default');
  for (const [normal, constant, size, name] of [
    [[0, 0, 2], -3, 2, 'PlaneHelper normal [0,0,2] constant -3 size 2'],
    [[1, 1, 1], 1, 4, 'PlaneHelper normal [1,1,1] constant 1 size 4'],
  ]) {
    const p = new PlaneHelper({ normal, constant, size });
    check(p, name);
    const l = Math.hypot(...normal),
      n = normal.map((v) => v / l),
      centre = n.map((v) => (v * -constant) / l);
    for (const q of allPoints(p))
      assert.ok(Math.abs(q[0] * normal[0] + q[1] * normal[1] + q[2] * normal[2] + constant) < 1e-4);
    const sum = allPoints(p).reduce((s, q) => s.map((v, k) => v + q[k]), [0, 0, 0]);
    assert.ok(
      near(
        sum.map((v) => v / 12),
        centre,
        1e-4,
      ),
      'centred',
    );
    const lengths = segments(p).map((s) => Math.hypot(...s.a.map((v, k) => v - s.b[k])));
    assert.equal(lengths.filter((x) => Math.abs(x - size) < 1e-4).length, 4);
    assert.equal(lengths.filter((x) => Math.abs(x - size * Math.SQRT2) < 1e-4).length, 2);
  }
  const buffer = plane.points;
  plane.setPlane([0, 1, 0], -1, 3);
  assert.equal(plane.points, buffer);
  assert.ok(allPoints(plane).every((q) => Math.abs(q[1] - 1) < TOL));
});

test('CameraHelper unprojects a reversed-Z frustum and keeps unchanged frames', () => {
  const camera = new Camera({ fov: 90, position: [0, 0, 5], target: [0, 0, 0], near: 1, far: 10 }),
    helper = new CameraHelper(camera, { aspect: 1 }),
    engine = fakeEngine([]);
  assert.equal(helper.count % 2, 0);
  assert.ok(helper.colors !== null, 'colours set by the constructor');
  assert.equal(helper.update(engine), true);
  const pts = allPoints(helper),
    has = (p) => pts.some((q) => near(q, p, 1e-4));
  for (const x of [-1, 1])
    for (const y of [-1, 1]) {
      assert.ok(has([x, y, 4]), `near corner ${x},${y}`);
      assert.ok(has([10 * x, 10 * y, -5]), `far corner ${x},${y}`);
    }
  assert.ok(has([0, 0, 5]), 'eye');
  check(helper, 'CameraHelper fov90 pos[0,0,5] near1 far10 aspect1 (layout from three.js: NOT binding)');
  // Five colours, both ends of each segment equal.
  const colours = new Set();
  for (let i = 0; i < helper.count; i += 2) {
    assert.deepEqual(color(helper, i), color(helper, i + 1));
    colours.add(color(helper, i).join());
  }
  assert.equal(colours.size, 5);
  // Up marker: points above the near plane's top edge on the near plane.
  assert.ok(pts.some((q) => Math.abs(q[2] - 4) < 1e-4 && q[1] > 1.1));
  const version = helper.version;
  helper.update(engine);
  assert.equal(helper.version, version, 'no rebuild for an unchanged matrix');

  const other = new Camera({ fov: 60, position: [3, 2, 1], near: 0.5, far: 20 }),
    wide = new CameraHelper(other, { aspect: 2 });
  wide.update(engine);
  {
    // Frustum corners and the eye bound the drawing. The recorded max y (2.220689) comes from the reference layout's
    // up marker rising above the eye; markers are free, so that one component is only checked to cover the eye.
    const v = vectors.cases['CameraHelper fov60 pos[3,2,1] near0.5 far20 aspect2 (layout NOT binding)'].bounds,
      b = bounds(wide);
    assert.ok(near(b.min, v.min, 1e-4), `min ${b.min}`);
    assert.ok(near([b.max[0], b.max[2]], [v.max[0], v.max[2]], 1e-4), `max ${b.max}`);
    assert.ok(b.max[1] >= 2 - TOL);
  }
  // Without an aspect a non-engine camera uses the canvas aspect (200 / 100).
  const canvasAspect = new CameraHelper(new Camera({ fov: 60, position: [3, 2, 1], near: 0.5, far: 20 }));
  canvasAspect.update(engine);
  assert.ok(near(bounds(canvasAspect).min, bounds(wide).min, 1e-4));
  // The engine camera is never updated by the helper.
  const own = new CameraHelper(engine.camera);
  const before = [...engine.camera.matrix];
  own.update(engine);
  assert.deepEqual([...engine.camera.matrix], before);
});

test('BoxHelper matches the world AABB vectors', () => {
  const geometry = box(2, 2, 2);
  const shifted = { id: 1, geometry, check() {}, world: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] };
  const h = new BoxHelper(shifted, { color: '#ff0000' });
  assert.equal(h.count, 24, 'placeholder points before the first update');
  helperMaterial(h);
  const engine = fakeEngine([shifted]);
  assert.equal(h.update(engine), vectors.cases['BoxHelper box(2,2,2) scaled x2 translated +5x'].updateReturned);
  check(h, 'BoxHelper box(2,2,2) scaled x2 translated +5x');
  assert.equal(h.colors, null);
  const c = Math.SQRT1_2;
  const rotated = { id: 2, geometry, check() {}, world: [c, c, 0, 0, -c, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  const r = new BoxHelper(rotated);
  assert.equal(r.update(fakeEngine([rotated])), true);
  check(r, 'BoxHelper box(2,2,2) rotated 45deg about z (world AABB)');
  // Switching meshes rebuilds; removed meshes hide.
  const v = h.version;
  h.setFromMesh(rotated);
  assert.equal(h.update(fakeEngine([rotated])), true);
  assert.ok(h.version > v);
  check(h, 'BoxHelper box(2,2,2) rotated 45deg about z (world AABB)');
  assert.equal(h.update(fakeEngine([])), false, 'mesh gone');
  const nan = { id: 3, geometry, check() {}, world: [NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  assert.equal(new BoxHelper(nan).update(fakeEngine([nan])), false, 'non-finite matrix');
  assert.throws(
    () =>
      new BoxHelper({
        check() {
          throw new Error('disposed');
        },
      }),
    /disposed/,
  );
});

test('VertexNormalsHelper matches the vectors (inverse transpose, mirrors, singular)', () => {
  const tilted = new Geometry(
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [Math.SQRT1_2, Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2, 0],
    [0, 1, 2],
  );
  const run = (geometry, world, options, name) => {
    const mesh = { id: 0, geometry, check() {}, world },
      h = new VertexNormalsHelper(mesh, options),
      returned = h.update(fakeEngine([mesh]));
    assert.equal(returned, vectors.cases[name].updateReturned, `${name}: returned`);
    if (returned) check(h, name);
    return h;
  };
  const h = run(
    tilted,
    [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    {},
    'VertexNormalsHelper tilted triangle, x scaled 2',
  );
  helperMaterial(h);
  assert.equal(h.colors, null);
  run(
    tilted,
    [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    { size: 0.5 },
    'VertexNormalsHelper tilted triangle, mirrored x (det<0), size 0.5',
  );
  run(tilted, [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], {}, 'VertexNormalsHelper singular matrix');
  run(box(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], {}, 'VertexNormalsHelper box() identity');
  // Zero normals stay zero length; size changes rebuild; non-finite size throws.
  const flat = new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2]);
  const mesh = { id: 0, geometry: flat, check() {}, world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    engine = fakeEngine([mesh]),
    z = new VertexNormalsHelper(mesh);
  assert.equal(z.update(engine), true);
  assert.ok(near(point(z, 0), point(z, 1)) && z.points.every(Number.isFinite));
  const buffer = z.points,
    version = z.version;
  z.update(engine);
  assert.equal(z.version, version);
  z.size = 2;
  z.update(engine);
  assert.ok(z.version > version);
  assert.equal(z.points, buffer, 'same vertex count reuses the buffer');
  z.size = NaN;
  assert.throws(() => z.update(engine), RangeError);
});

test('helpers validate their options with the documented error classes', () => {
  const cases = {
    'GridHelper size 0': () => new GridHelper({ size: 0 }),
    'GridHelper divisions 1.5': () => new GridHelper({ divisions: 1.5 }),
    'GridHelper divisions 10001': () => new GridHelper({ divisions: 10001 }),
    'GridHelper divisions 10000': () => new GridHelper({ divisions: 10000 }),
    'PolarGridHelper divisions 2': () => new PolarGridHelper({ divisions: 2 }),
    'PolarGridHelper sectors 4097': () => new PolarGridHelper({ sectors: 4097 }),
    'PolarGridHelper rings 0': () => new PolarGridHelper({ rings: 0 }),
    'PolarGridHelper radius -1': () => new PolarGridHelper({ radius: -1 }),
    'AxesHelper size 0': () => new AxesHelper({ size: 0 }),
    'AxesHelper size NaN': () => new AxesHelper({ size: NaN }),
    'Box3Helper min>max': () => new Box3Helper([1, 0, 0], [0, 0, 0]),
    'Box3Helper min 2 values': () => new Box3Helper([0, 0], [1, 1, 1]),
    'Box3Helper NaN': () => new Box3Helper([NaN, 0, 0], [1, 1, 1]),
    'ArrowHelper zero direction': () => new ArrowHelper({ direction: [0, 0, 0] }),
    'ArrowHelper headLength > length': () => new ArrowHelper({ length: 1, headLength: 2 }),
    'ArrowHelper length 0': () => new ArrowHelper({ length: 0 }),
    'ArrowHelper headWidth -1': () => new ArrowHelper({ headWidth: -1 }),
    'PlaneHelper zero normal': () => new PlaneHelper({ normal: [0, 0, 0] }),
    'PlaneHelper size 0': () => new PlaneHelper({ size: 0 }),
    'PlaneHelper constant Infinity': () => new PlaneHelper({ constant: Infinity }),
  };
  for (const [name, expected] of Object.entries(vectors.errors)) {
    const run = cases[name];
    assert.ok(run, name);
    if (expected === null) assert.doesNotThrow(run, name);
    else assert.throws(run, (e) => e.constructor.name === expected, name);
  }
  assert.throws(() => new PolarGridHelper({ rings: 1.5 }), RangeError);
  assert.throws(() => new ArrowHelper({ origin: [0, 0] }), TypeError);
  assert.throws(() => new ArrowHelper({ origin: [0, Infinity, 0] }), RangeError);
  assert.throws(() => new PlaneHelper({ normal: [0, 1] }), TypeError);
  assert.throws(() => new PlaneHelper({ normal: [0, NaN, 1] }), RangeError);
  assert.throws(() => new Box3Helper().setBox([0, 0, 0], [1, 1]), TypeError);
  assert.throws(() => new ArrowHelper().setLength(1, 0.5, NaN), RangeError);
  // Caller material options win over the helper defaults.
  const g = new GridHelper({ cap: 'round', join: 'bevel', width: 3, opacity: 0.5 });
  assert.deepEqual([g.material.cap, g.material.join, g.material.width, g.material.opacity], ['round', 'bevel', 3, 0.5]);
});
