import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { frameView, openBench } from '../dist/bench.js';

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
  for (const name of ['webgl2-compat', 'shadows', 'tonemap', 'post', 'controls', 'scene'])
    assert.doesNotMatch(source, new RegExp(`^import[^;]*@margoengine/${name}`, 'm'), name);
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
  return [(q[0] * r[0] + q[1] * r[1] + q[2] * r[2]) / (depth * t * aspect), (q[0] * u[0] + q[1] * u[1] + q[2] * u[2]) / (depth * t)];
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
  assert.throws(() => frameView({ fov: 40, position: [0, 0, 0], target: [0, 0, 0] }, { min: [0, 0, 0], max: [1, 1, 1] }), RangeError);
  assert.throws(() => frameView({ fov: 40, position: [0, 5, 0], target: [0, 0, 0] }, { min: [0, 0, 0], max: [1, 1, 1] }), RangeError);
  assert.throws(() => frameView(camera, { min: [0, 0, 0], max: [Infinity, 1, 1] }), RangeError);
});
