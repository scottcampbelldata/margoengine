import test from 'node:test';
import assert from 'node:assert/strict';
import { WideAngle, WideAngleMap } from '../dist/panini.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const MODES = ['panini', 'equidistant', 'equisolid', 'stereographic', 'orthographic'];
let seed = 5;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

test('panini with distance 0 is the plain rectilinear picture', () => {
  const map = new WideAngleMap(80, 1.6, { distance: 0 });
  assert.equal(map.zoom, 1);
  for (let i = 0; i < 100; i++) {
    const u = rand() * 2 - 1,
      v = rand() * 2 - 1,
      s = map.toSource(u, v);
    close(s[0], u, 1e-9);
    close(s[1], v, 1e-9);
  }
});

test('a fisheye puts an angle theta at the radius its law gives, 90 degrees vertical, square', () => {
  // vertical fov 90 and aspect 1: the source edge is 45 degrees off axis, tan = 1
  const half = Math.PI / 4,
    law = {
      equidistant: (t) => t,
      equisolid: (t) => Math.sin(t / 2),
      stereographic: (t) => Math.tan(t / 2),
      orthographic: (t) => Math.sin(t),
    };
  for (const mode of Object.keys(law)) {
    const map = new WideAngleMap(90, 1, { mode, crop: false });
    for (const theta of [0.1, 0.3, 0.5, 0.78]) {
      const [u] = map.toOutput(Math.tan(theta), 0);
      close(u, law[mode](theta) / law[mode](half), 1e-12);
    }
  }
});

test('panini keeps verticals vertical and radial lines straight', () => {
  const map = new WideAngleMap(100, 1.5, { distance: 1, crop: false });
  for (let i = 0; i < 50; i++) {
    const x = rand() * 2 - 1,
      a = map.toOutput(x, rand() * 0.8 - 0.4),
      b = map.toOutput(x, rand() * 0.8 - 0.4);
    if (a && b) close(a[0], b[0], 1e-12); // constant x: one column
  }
  for (let i = 0; i < 50; i++) {
    const x = rand() * 2 - 1,
      y = (rand() * 2 - 1) * 0.8,
      p = map.toOutput(x, y);
    // the ray through the centre keeps its slope on the output plane: py / px equals yr / xr
    if (p && Math.abs(p[0]) > 1e-6)
      close((p[1] * map.halfHeight) / (p[0] * map.halfWidth), (y * map.ty) / (x * map.tx), 1e-9);
  }
});

test('the classic panini at 120 degrees across: the edge of the picture is the edge of the output', () => {
  // horizontal half angle 60 degrees: halfWidth = 2 sin 60 / (1 + cos 60) = 1.1547
  const aspect = 16 / 9,
    fov = (2 * Math.atan(Math.tan(Math.PI / 3) / aspect) * 180) / Math.PI,
    map = new WideAngleMap(fov, aspect, { distance: 1, crop: false });
  close(map.halfWidth, 1.1547005383792515, 1e-12);
  const edge = map.toOutput(1, 0);
  close(edge[0], 1, 1e-12);
  assert.equal(map.toOutput(1.01, 0), null, 'beyond the picture');
});

test('toSource and toOutput are inverses in every mode, 500 seeded points', () => {
  for (const mode of MODES)
    for (let i = 0; i < 100; i++) {
      const map = new WideAngleMap(40 + rand() * 80, 0.7 + rand() * 1.5, { mode, distance: rand() * 3 });
      const u = rand() * 2 - 1,
        v = rand() * 2 - 1,
        s = map.toSource(u, v);
      assert.ok(s, `${mode}: a cropped output has a source everywhere`);
      const back = map.toOutput(s[0], s[1]);
      assert.ok(back, `${mode} back`);
      close(back[0], u, 1e-7);
      close(back[1], v, 1e-7);
    }
});

test('crop zooms in just enough: the border is inside the source, and 2 percent more is not', () => {
  const border = [];
  for (let k = 0; k <= 64; k++) {
    const t = (k / 64) * 2 - 1;
    border.push([t, 1], [t, -1], [1, t], [-1, t]);
  }
  let cropped = 0;
  for (const mode of MODES)
    for (let i = 0; i < 12; i++) {
      const fov = 60 + rand() * 50,
        aspect = 1 + rand(),
        map = new WideAngleMap(fov, aspect, { mode, distance: 0.5 + rand() * 2 });
      for (const [u, v] of border) assert.ok(map.toSource(u, v), `${mode} border ${u},${v}`);
      if (map.zoom < 1) {
        cropped++;
        assert.ok(
          border.some(([u, v]) => map.toSource(u * 1.02, v * 1.02) === null),
          `${mode}: zoom ${map.zoom} is the largest`,
        );
      }
    }
  assert.ok(cropped > 10, 'the wide cases do need a crop');
});

test('a view that cannot be projected is refused with the fix', () => {
  const says = (re) => (e) => e instanceof RangeError && re.test(e.message) && /;/.test(e.message);
  assert.throws(() => new WideAngleMap(60, 1, { mode: 'cylinder' }), says(/Invalid wide angle mode/));
  assert.throws(() => new WideAngleMap(60, 1, { distance: -1 }), says(/Invalid wide angle distance/));
  assert.throws(() => new WideAngleMap(180, 1), says(/Invalid wide angle view/));
  assert.throws(() => new WideAngleMap(60, 0), says(/Invalid wide angle view/));
  assert.throws(() => new WideAngle({ mode: 'fisheye' }), says(/Invalid wide angle mode/));
});

test('WideAngle: options, caching of the map, and its lifecycle errors', () => {
  const effect = new WideAngle({ mode: 'equisolid', distance: 2 });
  assert.equal(effect.enabled, true);
  effect.enabled = false;
  assert.equal(effect.options.enabled, false);
  assert.throws(() => (effect.enabled = 'no'), TypeError);
  const a = effect.map(90, 1.5);
  assert.equal(effect.map(90, 1.5), a, 'same view, same map');
  assert.notEqual(effect.map(100, 1.5), a);
  assert.equal(a.mode, 'equisolid');
  assert.throws(
    () => effect.setup({ gpu: {} }),
    (e) => e.code === 'state',
  );
  const stage = effect.joinStack({});
  assert.equal(stage.kind, 'ldr');
  assert.throws(
    () => effect.joinStack({}),
    (e) => e.code === 'attached',
  );
  assert.throws(
    () => effect.setup({}),
    (e) => e.code === 'unsupported',
  );
  effect.dispose();
  effect.dispose();
  assert.throws(
    () => effect.setup({ gpu: {} }),
    (e) => e.code === 'disposed',
  );
});
