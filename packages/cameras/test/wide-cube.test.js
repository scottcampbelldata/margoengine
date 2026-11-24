import test from 'node:test';
import assert from 'node:assert/strict';
import { WideAngleCube, WideAngleCubeMap } from '../dist/wide-cube.js';
import { WideAngleMap } from '../dist/panini.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const FISHEYE = ['equidistant', 'equisolid', 'stereographic'];
let seed = 11;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

test('the centre of the picture looks along the camera, whatever the mode', () => {
  for (const mode of [...FISHEYE, 'orthographic', 'panini']) {
    const direction = new WideAngleCubeMap(1.5, { mode, fov: 120 }).toDirection(0, 0);
    assert.deepEqual(direction.map((x) => x + 0), [0, 0, -1]);
  }
});

test('a fisheye reaches past 180 degrees: the edge of the width is half of fov from the centre', () => {
  for (const mode of FISHEYE)
    for (const fov of [180, 220, 300]) {
      const map = new WideAngleCubeMap(1, { mode, fov }),
        [x, y, z] = map.toDirection(1, 0),
        half = (fov * Math.PI) / 360;
      close(Math.atan2(x, -z), half > Math.PI ? half - 2 * Math.PI : half, 1e-9);
      close(y, 0);
    }
  // Behind the camera, which no rectilinear picture holds.
  const [, , z] = new WideAngleCubeMap(1, { fov: 300 }).toDirection(1, 0);
  assert.ok(z > 0.8, `${z}`);
});

test('equidistant fov 360 shows the whole sphere and the point straight behind sits on the rim', () => {
  const map = new WideAngleCubeMap(1, { fov: 360 });
  const [x, y, z] = map.toDirection(1, 0);
  close(x, 0, 1e-9);
  close(y, 0);
  close(z, 1);
  for (let i = 0; i < 200; i++) {
    const a = rand() * Math.PI * 2,
      b = Math.acos(rand() * 2 - 1),
      p = map.toOutput(Math.sin(b) * Math.cos(a), Math.sin(b) * Math.sin(a), Math.cos(b));
    assert.ok(p, 'every direction lands on the picture');
  }
});

test('the two maps agree in the range one flat picture reaches, so the cube stage draws the same fisheye', () => {
  // WideAngleMap with a square 120 degree source and no crop, against the cube map of the same width.
  for (const mode of FISHEYE) {
    const flat = new WideAngleMap(120, 1, { mode, crop: false }),
      cube = new WideAngleCubeMap(1, { mode, fov: 120, circle: false }),
      t = Math.tan(Math.PI / 3);
    for (let i = 0; i < 100; i++) {
      const x = rand() * 2 - 1,
        y = rand() * 2 - 1,
        out = flat.toOutput(x, y);
      if (!out) continue;
      const [dx, dy, dz] = cube.toDirection(out[0], out[1]);
      close(dx / -dz, x * t, 1e-7);
      close(dy / -dz, y * t, 1e-7);
    }
  }
  const flat = new WideAngleMap(120, 1, { distance: 1, crop: false }),
    cube = new WideAngleCubeMap(1, { mode: 'panini', distance: 1, fov: 120 }),
    t = Math.tan(Math.PI / 3);
  for (let i = 0; i < 100; i++) {
    const x = rand() * 2 - 1,
      y = rand() * 2 - 1,
      out = flat.toOutput(x, y);
    if (!out) continue;
    const [dx, dy, dz] = cube.toDirection(out[0], out[1]);
    close(dx / -dz, x * t, 1e-7);
    close(dy / -dz, y * t, 1e-7);
  }
});

test('toOutput and toDirection are inverses in every mode', () => {
  for (const [mode, fov] of [
    ['equidistant', 340],
    ['equisolid', 340],
    ['stereographic', 300],
    ['orthographic', 170],
    ['panini', 300],
  ]) {
    const map = new WideAngleCubeMap(1.4, { mode, fov, circle: false });
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const u = rand() * 2 - 1,
        v = rand() * 2 - 1,
        d = map.toDirection(u, v);
      if (!d) continue;
      close(Math.hypot(...d), 1, 1e-12);
      const back = map.toOutput(...d);
      assert.ok(back, `${mode} ${u} ${v}`);
      close(back[0], u, 1e-7);
      close(back[1], v, 1e-7);
      checked++;
    }
    assert.ok(checked > 100, `${mode} checked ${checked}`);
  }
});

test('circle leaves nothing past half of fov; without it the corners fill', () => {
  const round = new WideAngleCubeMap(1, { fov: 180 }),
    full = new WideAngleCubeMap(1, { fov: 180, circle: false });
  assert.equal(round.toDirection(0.9, 0.9), null);
  assert.ok(full.toDirection(0.9, 0.9)[2] > 0, 'the corner looks behind the camera');
  assert.equal(round.toOutput(0, 0, 1), null);
});

test('Panini stays on its cylinder: a column of the picture is one azimuth', () => {
  const map = new WideAngleCubeMap(1, { mode: 'panini', distance: 1, fov: 260 });
  for (let i = 0; i < 50; i++) {
    const u = rand() * 2 - 1,
      a = map.toDirection(u, rand() - 0.5),
      b = map.toDirection(u, rand() - 0.5);
    close(Math.atan2(a[0], -a[2]), Math.atan2(b[0], -b[2]), 1e-9);
  }
});

test('a fov the mode cannot reach is refused, by name', () => {
  const refuses = (options, pattern) => assert.throws(() => new WideAngleCubeMap(1, options), pattern);
  refuses({ mode: 'orthographic', fov: 181 }, /orthographic reaches 180/);
  refuses({ mode: 'stereographic', fov: 360 }, /stereographic reaches 359/);
  refuses({ mode: 'panini', distance: 0, fov: 180 }, /panini reaches 179/);
  refuses({ mode: 'panini', distance: 2, fov: 245 }, /panini reaches 239/);
  refuses({ fov: 361 }, /equidistant reaches 360/);
  refuses({ fov: 0 }, /Invalid wide angle fov/);
  refuses({ mode: 'mirror' }, /Invalid wide angle mode/);
  refuses({ distance: -1 }, /Invalid wide angle distance/);
  assert.throws(() => new WideAngleCubeMap(0), /Invalid wide angle aspect/);
  assert.throws(() => new WideAngleCube({ fov: 500 }), /Invalid wide angle fov/);
});

test('the effect refuses to run alone, without a cube, or twice', () => {
  const engine = { gpu: {}, camera: {} },
    alone = new WideAngleCube();
  assert.throws(
    () => alone.setup(engine),
    (e) => e.code === 'state' && /PostStack/.test(e.message),
  );
  alone.joinStack({});
  assert.throws(
    () => alone.setup(engine),
    (e) => e.code === 'state' && /no cube/.test(e.message),
  );
  assert.throws(
    () => alone.joinStack({}),
    (e) => e.code === 'attached',
  );
  assert.throws(
    () => alone.capture(),
    (e) => e.code === 'state',
  );
  alone.dispose();
  assert.throws(
    () => alone.setup(engine),
    (e) => e.code === 'disposed',
  );
  assert.throws(() => {
    alone.enabled = 1;
  }, TypeError);
});

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };

test('capture moves the cube to the camera and takes the faces asked for', () => {
  const calls = [],
    cube = { position: [0, 0, 0], view: {}, update: (n) => calls.push(n), dispose() {} },
    effect = new WideAngleCube({ cube, facesPerFrame: 2 }),
    frames = [],
    engine = {
      gpu: { createBuffer: () => ({ destroy() {} }), createSampler: () => ({}) },
      camera: { position: [1, 2, 3] },
      onFrame: (f) => (frames.push(f), () => frames.pop()),
      sceneOf: () => undefined,
      removePlugin() {},
    };
  effect.joinStack({});
  effect.setup(engine);
  frames[0]();
  assert.deepEqual(cube.position, [1, 2, 3]);
  assert.deepEqual(calls, [2]);
  effect.enabled = false;
  frames[0]();
  assert.deepEqual(calls, [2]);
  effect.capture();
  assert.deepEqual(calls, [2, 6]);
  effect.dispose();
  assert.equal(frames.length, 0);
});
