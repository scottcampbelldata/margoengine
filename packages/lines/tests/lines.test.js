import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera, Geometry, box } from '@margoengine/core';
import {
  Line,
  LineMaterial,
  Lines,
  GridHelper,
  PolarGridHelper,
  AxesHelper,
  Box3Helper,
  BoxHelper,
  ArrowHelper,
  CameraHelper,
  PlaneHelper,
  VertexNormalsHelper,
  computeLineDistances,
  expandLine,
  triangleArea,
  segmentCount,
  segmentIndices,
  parseColor,
  geometryBounds,
  VERTICES_PER_SEGMENT,
} from '../dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const close = (actual, expected, epsilon = 1e-4, message = '') =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message} expected ${expected}, got ${actual}`);
const fanArea = (radius, sweep, triangles = 10) => 0.5 * triangles * radius * radius * Math.sin(sweep / triangles);
test('dash distances follow mutable line modes without reallocating stable geometry', () => {
  const line = new Line({ positions: [0, 0, 0, 3, 0, 0, 3, 4, 0], dashed: true });
  const points = line.points,
    capacity = line.capacityVersion;
  line.updateDistances(line.matrix);
  assert.equal(line.totalDistance, 7);
  const version = line.version;
  for (let i = 0; i < 120; i++) line.updateDistances(line.matrix);
  assert.equal(line.version, version, 'unchanged mode, points and matrix retain cached distances');
  line.mode = 'loop';
  line.updateDistances(line.matrix);
  assert.equal(line.totalDistance, 12, 'loop includes its closing segment');
  line.mode = 'segments';
  line.updateDistances(line.matrix);
  assert.equal(line.totalDistance, 3);
  assert.deepEqual([line.points[3], line.points[7], line.points[11]], [0, 3, 3]);
  line.mode = 'strip';
  line.updateDistances(line.matrix);
  assert.equal(line.totalDistance, 7);
  assert.deepEqual([line.points[3], line.points[7], line.points[11]], [0, 3, 7]);
  line.matrix[0] = line.matrix[5] = 2;
  line.updateDistances(line.matrix);
  assert.equal(line.totalDistance, 14);
  line.mode = 'loop';
  line.updateDistances(line.matrix);
  assert.equal(line.totalDistance, 24);
  assert.equal(line.points, points);
  assert.equal(line.capacityVersion, capacity);
});
const bounds = (vertices) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    b[0] = Math.min(b[0], vertices[i]);
    b[1] = Math.min(b[1], vertices[i + 1]);
    b[2] = Math.max(b[2], vertices[i]);
    b[3] = Math.max(b[3], vertices[i + 1]);
  }
  return b;
};
// Monte Carlo free check that triangles do not overlap: sample a grid and count how many triangles cover each sample.
function maxCoverage(vertices, step = 0.37) {
  const [x0, y0, x1, y1] = bounds(vertices);
  let worst = 0;
  const inside = (t, x, y) => {
    const v = vertices,
      s = (ax, ay, bx, by) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const a = s(v[t], v[t + 1], v[t + 3], v[t + 4]),
      b = s(v[t + 3], v[t + 4], v[t + 6], v[t + 7]),
      c = s(v[t + 6], v[t + 7], v[t], v[t + 1]);
    return (a > 1e-9 && b > 1e-9 && c > 1e-9) || (a < -1e-9 && b < -1e-9 && c < -1e-9);
  };
  for (let x = x0 + step / 2; x < x1; x += step)
    for (let y = y0 + step / 3; y < y1; y += step) {
      let n = 0;
      for (let t = 0; t < vertices.length; t += 9) if (inside(t, x, y)) n++;
      worst = Math.max(worst, n);
    }
  return worst;
}

test('module import and construction are SSR safe', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.navigator?.gpu, 'undefined');
  const lines = new Lines();
  const line = lines.add(new Line({ positions: [0, 0, 0, 1, 0, 0] }));
  assert.equal(lines.lines.size, 1);
  line.dispose();
  assert.equal(lines.lines.size, 0);
  assert.equal(VERTICES_PER_SEGMENT, 78);
});

test('segment counts and neighbor indices per mode', () => {
  assert.equal(segmentCount('segments', 5), 2);
  assert.equal(segmentCount('strip', 5), 4);
  assert.equal(segmentCount('loop', 5), 5);
  assert.equal(segmentCount('loop', 2), 1);
  assert.equal(segmentCount('strip', 1), 0);
  assert.deepEqual(segmentIndices('segments', 6, 1), { a: 2, b: 3, prev: -1, next: -1 });
  assert.deepEqual(segmentIndices('strip', 4, 0), { a: 0, b: 1, prev: -1, next: 2 });
  assert.deepEqual(segmentIndices('strip', 4, 2), { a: 2, b: 3, prev: 1, next: -1 });
  assert.deepEqual(segmentIndices('loop', 4, 3), { a: 3, b: 0, prev: 2, next: 1 });
});

test('dash distances accumulate along strips, segments and loops in world space', () => {
  const pack = (flat) => {
    const p = new Float32Array((flat.length / 3) * 4);
    for (let i = 0; i < flat.length / 3; i++) p.set(flat.slice(i * 3, i * 3 + 3), i * 4);
    return p;
  };
  const strip = pack([0, 0, 0, 3, 0, 0, 3, 4, 0]);
  assert.equal(computeLineDistances(strip, 3, 'strip'), 7);
  assert.deepEqual([strip[3], strip[7], strip[11]], [0, 3, 7]);
  const loop = pack([0, 0, 0, 3, 0, 0, 3, 4, 0]);
  assert.equal(computeLineDistances(loop, 3, 'loop'), 12);
  const segments = pack([0, 0, 0, 1, 0, 0, 5, 5, 5, 5, 7, 5]);
  assert.equal(computeLineDistances(segments, 4, 'segments'), 3);
  assert.deepEqual(
    [...segments].filter((_, i) => i % 4 === 3),
    [0, 1, 1, 3],
  );
  const scaled = pack([0, 0, 0, 1, 0, 0, 1, 1, 0]);
  const matrix = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1];
  assert.equal(computeLineDistances(scaled, 3, 'strip', matrix), 5);
});

test('straight segment expands to exact quad for every cap', () => {
  const butt = expandLine([0, 0, 100, 0], { width: 10, cap: 'butt', antialias: false });
  assert.equal(butt.length, 2 * 9);
  close(triangleArea(butt), 1000);
  assert.deepEqual(bounds(butt), [0, -5, 100, 5]);
  const square = expandLine([0, 0, 100, 0], { width: 10, cap: 'square', antialias: false });
  close(triangleArea(square), 110 * 10);
  assert.deepEqual(bounds(square), [-5, -5, 105, 5]);
  const round = expandLine([0, 0, 100, 0], { width: 10, cap: 'round', antialias: false });
  close(triangleArea(round), 1000 + 2 * fanArea(5, Math.PI));
  const aa = expandLine([0, 0, 100, 0], { width: 10, cap: 'butt' });
  close(triangleArea(aa), 102 * 12, 1e-3, 'antialias pads one pixel');
  // The signed edge distance spans the full padded width.
  const d = aa.filter((_, i) => i % 3 === 2);
  assert.equal(Math.max(...d), 6);
  assert.equal(Math.min(...d), -6);
});

test('joins: miter, bevel and round cover the corner without overlap', () => {
  const a = 60,
    b = 40,
    w = 10,
    h = w / 2,
    path = [0, 0, a, 0, a, b];
  const miter = expandLine(path, { width: w, cap: 'butt', join: 'miter', antialias: false });
  close(triangleArea(miter), (a + b) * w, 1e-3, 'miter');
  assert.equal(maxCoverage(miter), 1);
  assert.deepEqual(
    bounds(miter).map((v) => Math.round(v * 1e4) / 1e4),
    [0, -5, 65, 40],
  );
  const bevel = expandLine(path, { width: w, cap: 'butt', join: 'bevel', antialias: false });
  close(triangleArea(bevel), (a + b) * w - (h * h) / 2, 1e-3, 'bevel');
  assert.equal(maxCoverage(bevel), 1);
  const round = expandLine(path, { width: w, cap: 'butt', join: 'round', antialias: false });
  close(triangleArea(round), (a + b) * w - h * h + fanArea(h, Math.PI / 2), 1e-3, 'round');
  assert.equal(maxCoverage(round), 1);
  // The same corner turning the other way is the mirror image.
  const mirrored = expandLine([0, 0, a, 0, a, -b], { width: w, cap: 'butt', join: 'round', antialias: false });
  close(triangleArea(mirrored), triangleArea(round), 1e-3);
});

test('miter limit falls back to bevel and collinear points add no area', () => {
  const sharp = [0, 0, 100, 0, 0, 10];
  const limited = expandLine(sharp, { width: 4, cap: 'butt', join: 'miter', miterLimit: 4, antialias: false });
  const bevel = expandLine(sharp, { width: 4, cap: 'butt', join: 'bevel', antialias: false });
  close(triangleArea(limited), triangleArea(bevel), 1e-3);
  const long = expandLine(sharp, { width: 4, cap: 'butt', join: 'miter', miterLimit: 100, antialias: false });
  assert.ok(bounds(long)[2] > bounds(bevel)[2] + 10, 'a high miter limit keeps the long spike');
  const collinear = expandLine([0, 0, 30, 0, 50, 0, 90, 0], { width: 6, cap: 'butt', join: 'round', antialias: false });
  close(triangleArea(collinear), 90 * 6, 1e-3);
  assert.equal(maxCoverage(collinear), 1);
});

test('closed loop has no caps and covers a square frame exactly', () => {
  const s = 50,
    w = 8;
  const loop = expandLine([0, 0, s, 0, s, s, 0, s], {
    mode: 'loop',
    width: w,
    join: 'miter',
    cap: 'round',
    antialias: false,
  });
  close(triangleArea(loop), (s + w) ** 2 - (s - w) ** 2, 1e-3);
  assert.equal(maxCoverage(loop, 0.9), 1);
  const segments = expandLine([0, 0, 10, 0, 0, 10, 10, 10], {
    mode: 'segments',
    width: 2,
    cap: 'butt',
    antialias: false,
  });
  close(triangleArea(segments), 40, 1e-4);
});

test('colors parse to linear RGB', () => {
  assert.deepEqual(parseColor('#ffffff'), [1, 1, 1]);
  close(parseColor('#808080')[0], 0.2158605, 1e-6);
  assert.deepEqual(parseColor(0xff0000), [1, 0, 0]);
  assert.deepEqual(parseColor('#f00'), [1, 0, 0]);
  assert.deepEqual(parseColor([0.5, 0.25, 0]), [0.5, 0.25, 0]);
  assert.throws(() => parseColor('red'), TypeError);
  assert.throws(() => parseColor([1, -1, 0]), RangeError);
});

test('Line reuses buffers for same-size updates and validates input', () => {
  const line = new Line({ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], colors: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  assert.equal(line.count, 3);
  assert.equal(line.segmentCount, 2);
  assert.deepEqual([...line.colors.subarray(0, 8)], [1, 0, 0, 1, 0, 1, 0, 1]);
  const capacity = line.capacityVersion,
    points = line.points,
    version = line.version;
  line.setPositions([1, 1, 1, 2, 2, 2, 3, 3, 3]);
  assert.equal(line.capacityVersion, capacity);
  assert.equal(line.points, points);
  assert.ok(line.version > version);
  line.setPositions([0, 0, 0, 1, 1, 1]);
  assert.equal(line.capacityVersion, capacity, 'shrinking keeps the buffers');
  line.setPositions(new Array(30).fill(0));
  assert.ok(line.capacityVersion > capacity, 'growing reallocates');
  assert.ok(line.colors.length >= 40);
  line.setColors(new Array(40).fill(0.5));
  assert.throws(() => line.setPositions([0, 0]), RangeError);
  assert.throws(() => line.setPositions([0, 0, NaN, 1, 1, 1]), RangeError);
  assert.throws(() => line.setColors([1, 1]), RangeError);
  assert.throws(() => new Line({ mode: 'fan' }), TypeError);
  assert.throws(() => new Line({ width: 0 }), RangeError);
  assert.throws(() => new Line({ join: 'sharp' }), TypeError);
  assert.throws(() => new Line({ opacity: 2 }), RangeError);
  const material = new LineMaterial({ color: '#00ff00', width: 3, dashed: true });
  const a = new Line({ material, positions: [0, 0, 0, 1, 0, 0] }),
    b = new Line({ material, positions: [0, 0, 0, 0, 1, 0] });
  assert.equal(a.material, b.material);
  assert.deepEqual([...material.color], [0, 1, 0]);
  material.width = -1;
  assert.throws(() => material.validate(), RangeError);
  const lines = new Lines(),
    other = new Lines({ name: 'other' });
  lines.add(a);
  assert.throws(() => other.add(a), /another/);
  lines.remove(a);
  other.add(a);
});

test('helpers build the expected geometry', () => {
  const grid = new GridHelper({ size: 4, divisions: 4 });
  assert.equal(grid.count, 5 * 4);
  assert.equal(grid.mode, 'segments');
  const center = parseColor('#444444');
  close(grid.colors[2 * 16], center[0], 1e-6, 'center row uses color1');
  const polar = new PolarGridHelper({ radius: 2, sectors: 4, rings: 2, divisions: 8 });
  assert.equal(polar.count, 4 * 2 + 2 * 8 * 2);
  const axes = new AxesHelper({ size: 2 });
  assert.deepEqual([...axes.points.subarray(4, 7)], [2, 0, 0]);
  axes.setColors('#0000ff', '#00ff00', '#ff0000');
  assert.deepEqual([...axes.colors.subarray(0, 3)], [0, 0, 1]);
  const box3 = new Box3Helper([-1, -2, -3], [1, 2, 3]);
  assert.equal(box3.count, 24);
  for (let i = 0; i < 24; i++)
    assert.deepEqual(
      [0, 1, 2].map((a) => Math.abs(box3.points[i * 4 + a])),
      [1, 2, 3],
    );
  assert.throws(() => box3.setBox([1, 0, 0], [0, 0, 0]), RangeError);
  const arrow = new ArrowHelper({ direction: [0, 2, 0], origin: [1, 0, 0], length: 5 });
  assert.deepEqual(
    [...arrow.points.subarray(4, 7)].map((v) => Math.round(v * 1e5) / 1e5),
    [1, 4, 0],
    'shaft ends at the head base',
  );
  assert.deepEqual(
    [...arrow.points.subarray(8, 11)].map((v) => Math.round(v * 1e5) / 1e5),
    [1, 5, 0],
    'spokes start at the tip',
  );
  const plane = new PlaneHelper({ normal: [0, 0, 2], constant: -3, size: 2 });
  for (let i = 0; i < plane.count; i++) close(plane.points[i * 4 + 2], 1.5, 1e-6, 'points lie on the plane');
  assert.equal(plane.count, 12);
});

function fakeEngine(meshes) {
  const capacity = 8,
    store = { matrices: new Float32Array(16 * capacity), hidden: new Uint8Array(capacity) };
  const map = new Map(meshes.map((mesh) => [mesh.id, mesh]));
  for (const mesh of meshes) store.matrices.set(mesh.world, mesh.id * 16);
  return { disposed: false, meshes: map, store, camera: new Camera(), canvas: { width: 200, height: 100 } };
}

test('BoxHelper and VertexNormalsHelper follow the mesh world matrix', () => {
  const geometry = box(2, 2, 2);
  assert.deepEqual([...geometryBounds(geometry)], [-1, -1, -1, 1, 1, 1]);
  // Scale x by 2 and translate by (5, 0, 0).
  const mesh = { id: 3, geometry, check() {}, world: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] };
  const engine = fakeEngine([mesh]);
  const helper = new BoxHelper(mesh);
  assert.equal(helper.update(engine), true);
  const xs = [],
    ys = [];
  for (let i = 0; i < helper.count; i++) {
    xs.push(helper.points[i * 4]);
    ys.push(helper.points[i * 4 + 1]);
  }
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [3, 7, -1, 1]);
  const version = helper.version;
  helper.update(engine);
  assert.equal(helper.version, version, 'no rebuild while the matrix is unchanged');
  engine.store.hidden[3] = 1;
  assert.equal(helper.update(engine), false, 'hidden mesh hides the helper');
  engine.store.hidden[3] = 0;

  // A triangle tilted 45 degrees: with x scaled by 2 the normal must use the inverse transpose.
  const tilted = new Geometry(
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [Math.SQRT1_2, Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2, 0],
    [0, 1, 2],
  );
  const other = { id: 4, geometry: tilted, check() {}, world: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  const normals = new VertexNormalsHelper(other, { size: 1 });
  assert.equal(normals.update(fakeEngine([other])), true);
  assert.equal(normals.count, 6);
  const dx = normals.points[4] - normals.points[0],
    dy = normals.points[5] - normals.points[1];
  close(Math.hypot(dx, dy), 1, 1e-5);
  close(dy / dx, 2, 1e-4, 'normal slope after non-uniform scale');
});

test('VertexNormalsHelper keeps singular transforms hidden until a valid matrix returns', () => {
  const mesh = { id: 0, geometry: box(), check() {}, world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    engine = fakeEngine([mesh]),
    helper = new VertexNormalsHelper(mesh);
  assert.equal(helper.update(engine), true);
  const version = helper.version;
  engine.store.matrices[0] = 0;
  assert.equal(helper.update(engine), false, 'a singular matrix has no inverse normal transform');
  assert.equal(helper.update(engine), false, 'a cached singular matrix must remain hidden');
  assert.equal(helper.version, version, 'invalid transforms must not publish helper geometry');
  engine.store.matrices[0] = 2;
  assert.equal(helper.update(engine), true);
  assert.ok(helper.version > version);
  assert.ok(helper.points.every(Number.isFinite));
});

test('CameraHelper unprojects a reversed-Z frustum', () => {
  const camera = new Camera({ fov: 90, position: [0, 0, 5], target: [0, 0, 0], near: 1, far: 10 });
  const helper = new CameraHelper(camera, { aspect: 1 });
  helper.update(fakeEngine([]));
  const p = (i) => [...helper.points.subarray(i * 4, i * 4 + 3)].map((v) => Math.round(v * 1e4) / 1e4);
  assert.deepEqual(p(0), [-1, -1, 4], 'near plane corner n1');
  assert.deepEqual(p(8), [-10, -10, -5], 'far plane corner f1');
  assert.deepEqual(p(24), [0, 0, 5], 'cone starts at the camera');
  assert.equal(helper.count, 50);
});

test('world-unit widths match the projection under perspective and orthographic cameras', () => {
  // The frame uniform's pixels per world unit (viewport.w), divided by clip w as the shader's halfWidth does.
  const shaderScale = (camera, z) => {
    const gpu = mockGPU(),
      lines = new Lines(),
      m = camera.matrix,
      size = 256;
    lines.setup({ backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: size } });
    lines.add(new Line({ positions: [0, 0, z, 1, 0, z], width: 0.5, worldUnits: true }));
    const view = gpu.device.createTexture({ size: [size, size], format: 'rgba8unorm' }).createView();
    const log = gpu.record(() =>
      passes(lines)({
        backend: 'webgpu',
        device: gpu.device,
        encoder: gpu.encoder,
        camera,
        width: size,
        height: size,
        format: 'rgba8unorm',
        color: view,
        depth: view,
        descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
      }),
    );
    const frame = new Float32Array(
      new Uint8Array(Buffer.from(log.find((entry) => entry[0] === 'writeBuffer' && entry[3].length === 192)[3], 'hex'))
        .buffer,
    );
    return frame[19] / (m[11] * z + m[15]);
  };
  // Pixels one world unit along x covers at depth z, from the clip matrix itself.
  const projected = (camera, z) => {
    const m = camera.matrix,
      x = (px) => (m[0] * px + m[8] * z + m[12]) / (m[3] * px + m[11] * z + m[15]);
    return (x(1) - x(0)) * 0.5 * 256;
  };
  const camera = () => new Camera({ position: [0, 0, 10], target: [0, 0, 0], fov: 60, near: 0.1, far: 100 });
  const perspective = camera();
  perspective.update(1, true);
  for (const z of [0, -10])
    close(shaderScale(perspective, z), projected(perspective, z), 1e-3, `perspective at z ${z}`);
  // @margoengine/cameras: 4 world units over 256 px is 64 px per unit at every depth, also behind the eye (negative near).
  const ortho = camera();
  new CameraProjection({ height: 4, near: -5, far: 30 }).attach(ortho);
  ortho.update(1, true);
  for (const z of [0, -15, 12]) {
    close(shaderScale(ortho, z), 64, 1e-4, `orthographic at z ${z}`);
    close(projected(ortho, z), 64, 1e-4);
  }
  const zoomed = camera();
  new CameraProjection({ height: 4, zoom: 2 }).attach(zoomed);
  zoomed.update(1, true);
  close(shaderScale(zoomed, 0), 128, 1e-4, 'zoom 2');
});

test('WebGL2 engines get a single warning and no passes draw', () => {
  const warnings = [],
    original = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const engine = { backend: 'webgl2', gpu: null };
    new Lines().setup(engine);
    new Lines({ name: 'more' }).setup(engine);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WebGL2/);
});
