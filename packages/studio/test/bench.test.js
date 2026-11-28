import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { box } from '@margoengine/core';
import { addSubject, coveOrbitLimits, frameView, openBench, subjectBox } from '../dist/bench.js';

const canvas = () => ({ getContext() {}, clientWidth: 100, clientHeight: 50, width: 0, height: 0, dataset: {} });

test('openBench rejects what is not a canvas before opening anything', async () => {
  await assert.rejects(openBench(null), TypeError);
  await assert.rejects(openBench({}), TypeError);
});

test('openBench rejects an invalid backbuffer size before opening anything', async () => {
  await assert.rejects(openBench(canvas(), { pixelRatio: 0 }), RangeError);
  await assert.rejects(openBench(canvas(), { maxWidth: 4 }), RangeError);
});

test('an aborted signal marks data-error and opens no engine', async () => {
  const target = canvas(),
    errors = [];
  await assert.rejects(
    openBench(target, { signal: AbortSignal.abort(), onError: (e) => errors.push(e) }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(errors.length, 1);
  assert.ok(target.dataset.error);
  assert.equal(target.dataset.ready, undefined);
  assert.equal(target.width, 100, 'the backbuffer is sized from the layout box before start-up');
});

test('the bench loads every optional package lazily, so a page pays only for what it turns on', async () => {
  const source = await readFile(new URL('../dist/bench.js', import.meta.url), 'utf8');
  for (const name of ['shadows', 'tonemap', 'post', 'controls', 'scene'])
    assert.doesNotMatch(source, new RegExp(`^import[^;]*@margoengine/${name}`, 'm'), name);
});

// The bench once imported the WebGL2 layer itself (a lazy import(), still an edge the layer's isolation test refuses:
// the layer costs a WebGPU page nothing). The page hands it in: start (startEngine) and loadCompat.
test('the bench never reaches the WebGL2 layer: the page hands in start and loadCompat', async () => {
  const source = await readFile(new URL('../dist/bench.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:import|from)\s*\(?\s*['"][^'"]*webgl2-compat/);
  await assert.rejects(openBench(canvas(), { backend: 'webgl2' }), /needs start for the WebGL2 layer/);
  const seen = [],
    reason = new Error('stop after start');
  await assert.rejects(
    openBench(canvas(), {
      backend: 'webgl2',
      compat: { minimumTier: 'half-float' },
      loadCompat: async () => ({ install: async (o) => seen.push(o) }),
      start: async (_, options) => {
        assert.equal(options.forceCompat, true);
        assert.equal(options.exactSize, true);
        await (await options.loadCompat()).install({ force: true });
        throw reason;
      },
    }),
    (e) => e === reason,
  );
  assert.deepEqual(seen, [{ force: true, minimumTier: 'half-float' }]);
  await assert.rejects(
    openBench(canvas(), { start: async (_, o) => o.loadCompat() }),
    /needs loadCompat for the WebGL2 layer/,
  );
});

// Projects a world point through the framed view: [x, y] in -1..1 of each half of the view.
const project = (view, fov, aspect, p) => {
  const w = view.position.map((v, a) => v - view.target[a]),
    l = Math.hypot(...w),
    f = w.map((v) => v / l),
    r = [f[2], 0, -f[0]].map((v) => v / Math.hypot(f[2], f[0])),
    u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]],
    q = p.map((v, a) => v - view.position[a]),
    depth = -(q[0] * f[0] + q[1] * f[1] + q[2] * f[2]),
    t = Math.tan((fov * Math.PI) / 360);
  return [
    (q[0] * r[0] + q[1] * r[1] + q[2] * r[2]) / (depth * t * aspect),
    (q[0] * u[0] + q[1] * u[1] + q[2] * u[2]) / (depth * t),
  ];
};

test('frameView fills the view with a small subject, keeping the view direction (empty canvas regression)', () => {
  // bullet-through-paper's view: a 1.6 m wide rig seen from 9.9 m filled a quarter of the canvas.
  const camera = { fov: 35, position: [-1.87, 6.02, 7.72], target: [0, 0.16, 0] },
    box = { min: [-0.8, 0, -0.5], max: [0.8, 0.9, 0.5] },
    aspect = 1.6,
    view = frameView(camera, box, 0.8, aspect);
  assert.deepEqual(view.target, [0, 0.45, 0]);
  const before = camera.position.map((v, a) => v - camera.target[a]),
    after = view.position.map((v, a) => v - view.target[a]),
    cos = before.reduce((s, v, a) => s + v * after[a], 0) / Math.hypot(...before) / Math.hypot(...after);
  assert.ok(cos > 0.999999, 'the view direction is kept');
  let reach = 0;
  for (let i = 0; i < 8; i++) {
    const p = [0, 1, 2].map((a) => ((i >> a) & 1 ? box.max[a] : box.min[a])),
      [x, y] = project(view, camera.fov, aspect, p);
    assert.ok(Math.abs(x) <= 0.8 + 1e-9 && Math.abs(y) <= 0.8 + 1e-9, `corner ${p} inside the fill: ${x}, ${y}`);
    reach = Math.max(reach, Math.abs(x), Math.abs(y));
  }
  assert.ok(reach > 0.79, `the subject reaches the fill on one side, not a loose sphere fit: ${reach}`);
  assert.ok(Math.hypot(...after) < Math.hypot(...before) / 2, 'the camera moves in on the small subject');
  assert.ok(view.far >= Math.hypot(...after));
});

test('frameView frames a wide flat subject by its width on a tall view and rejects bad input', () => {
  const camera = { fov: 40, position: [0, 10, 10], target: [0, 0, 0] },
    view = frameView(camera, { min: [-50, 0, -50], max: [50, 4, 50] }, 0.9, 0.6);
  const [x] = project(view, 40, 0.6, [50, 0, 50]);
  assert.ok(Math.abs(x) <= 0.9 + 1e-9);
  assert.throws(() => frameView(camera, { min: [0, 0, 0], max: [1, 1, 1] }, 0.05), RangeError);
  assert.throws(
    () => frameView({ fov: 40, position: [0, 0, 0], target: [0, 0, 0] }, { min: [0, 0, 0], max: [1, 1, 1] }),
    RangeError,
  );
  assert.throws(
    () => frameView({ fov: 40, position: [0, 5, 0], target: [0, 0, 0] }, { min: [0, 0, 0], max: [1, 1, 1] }),
    RangeError,
  );
  assert.throws(() => frameView(camera, { min: [0, 0, 0], max: [Infinity, 1, 1] }), RangeError);
});

test('a mesh added with fit: false stays out of the auto-fit box, so a big floor does not swamp the subject', async () => {
  using e = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, await TransformStore.create(16), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  const floor = e.createMesh().setGeometry(box()).setScale([140, 0.12, 140]),
    subject = e.createMesh().setGeometry(box()).setPosition([0, 0.5, 0]),
    subjects = new Set(),
    removeFloor = addSubject(subjects, floor, false);
  addSubject(subjects, subject, true);
  assert.equal(subjects.size, 1, 'the excluded floor is not registered');
  const found = await subjectBox(subjects);
  assert.ok(found.max[0] - found.min[0] < 1.5 && found.max[2] - found.min[2] < 1.5, 'the box is the 1 m subject, not the 140 m floor');
  const camera = { fov: 35, position: [-1.87, 6.02, 7.72], target: [0, 0.16, 0] },
    framed = frameView(camera, found, 0.8, 1.6),
    swamped = frameView(camera, (await subjectBox([floor, subject])), 0.8, 1.6);
  assert.ok(Math.hypot(...framed.position.map((v, a) => v - framed.target[a])) < 8, 'the camera comes in on the subject');
  assert.ok(Math.hypot(...swamped.position.map((v, a) => v - swamped.target[a])) > 100, 'counting the floor would pull the camera far out');
  removeFloor();
  const removeSubject = addSubject(subjects, subject, true);
  removeSubject();
  assert.equal(subjects.size, 0, 'a remover takes the mesh out of the set');
  assert.equal(await subjectBox(subjects), null, 'an empty set has no box');
});

test('coveOrbitLimits keeps the frame inside a cove: no edge ray turns past the open sides', () => {
  // Regression: orbiting the CAD bench about 90 degrees looked past the cove's open side onto the clear colour.
  for (const [fov, aspect] of [[36, 16 / 9], [36, 1.36], [50, 1], [20, 0.6]]) {
    const { azimuth, maxPolar } = coveOrbitLimits(fov, aspect),
      half = Math.atan(Math.tan((fov * Math.PI) / 360) * aspect);
    assert.equal(azimuth[0], -azimuth[1]);
    assert.ok(azimuth[1] + half < Math.PI / 2, `${fov}/${aspect}: edge ray at ${azimuth[1] + half}`);
    assert.ok(azimuth[1] > 0.9, `${fov}/${aspect}: still turns ${azimuth[1]}`);
    assert.ok(maxPolar < Math.PI / 2);
  }
  assert.throws(() => coveOrbitLimits(0, 1), RangeError);
  assert.throws(() => coveOrbitLimits(36, 0), RangeError);
});
