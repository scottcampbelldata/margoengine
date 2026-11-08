import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { fakeEngine } from './fake-dom.js';
import { LabelRenderer, cssPointToWorld, lookAtView } from '../dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { projectPoint } from '@margoengine/math/mat4';

// CSS 3D objects cut at the near plane. The fake canvas is 800 x 400; the camera sits at z = 5 looking at the origin.
const flat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // 90 degrees about x: the element's y runs along world z.

function setup(camera = {}) {
  const engine = fakeEngine(Camera, { camera: { position: [0, 0, 5], target: [0, 0, 0], ...camera } });
  const renderer = new LabelRenderer();
  renderer.setup(engine);
  renderer.registerPasses(engine.graph);
  const add = (options, size = [200, 100]) => {
    const element = engine.document.createElement('div');
    let reads = 0;
    Object.defineProperty(element, 'offsetWidth', { get: () => (reads++, size[0]) });
    Object.defineProperty(element, 'offsetHeight', { get: () => size[1] });
    const object = renderer.add3D(element, options);
    object.reads = () => reads;
    object.size = size;
    return object;
  };
  return { engine, renderer, add };
}
const polygon = (object) =>
  [...(object.element.style.clipPath ?? '').matchAll(/([-\d.]+)px ([-\d.]+)px/g)].map((m) => [+m[1], +m[2]]);
/** Signed distance in front of the near plane of a world point, for the engine's perspective camera. */
const inFront = (engine, p) => {
  const camera = engine.camera,
    view = lookAtView(camera.position, camera.target);
  return -(view[2] * p[0] + view[6] * p[1] + view[10] * p[2] + view[14]) - camera.near;
};
/** World point of element pixel (x, y) from its top left corner. */
const pixel = (object, x, y) =>
  cssPointToWorld(object.matrix, object.pixelScale, x - object.size[0] / 2, y - object.size[1] / 2);
/** True when (x, y) is inside the convex polygon (either winding), by more than `margin` pixels from its edges. */
function inside(points, x, y, margin) {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i],
      [bx, by] = points[(i + 1) % points.length];
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-9) continue;
    const side = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / length;
    if (Math.abs(side) <= margin) return null;
    if (sign === 0) sign = Math.sign(side);
    else if (Math.sign(side) !== sign) return false;
  }
  return true;
}

test('a panel straddling the near plane is shown and cut there, even with its origin behind the plane', () => {
  for (const z of [4, 4.2, 3.9]) {
    const { engine, add } = setup({ near: 1 });
    // 2 x 1 world units lying flat: it spans view depths 5 - z -/+ 0.5 around the near plane at 1.
    const panel = add({ position: [0, -0.2, z], quaternion: flat });
    engine.frame();
    assert.equal(panel.onScreen, true, `z ${z}: the panel is shown`);
    assert.equal(panel.element.style.display, '');
    assert.equal(panel.clipped, true);
    const points = polygon(panel);
    assert.equal(points.length, 4, `z ${z}: a rectangle cut by a plane across it keeps four corners`);
    for (const [x, y] of points) {
      assert.ok(x >= -0.01 && x <= 200.01 && y >= -0.01 && y <= 100.01, 'vertices lie on the element');
      assert.ok(inFront(engine, pixel(panel, x, y)) >= -1e-3, `z ${z}: vertex ${x},${y} is behind the near plane`);
    }
    // The cut runs where the plane crosses: half the 100 px height per world unit of depth past the plane.
    const near = points.filter(([x, y]) => Math.abs(inFront(engine, pixel(panel, x, y))) < 1e-3);
    assert.equal(near.length, 2, 'two vertices on the near plane');
    const kept = Math.max(...points.map(([, y]) => y)) - Math.min(...points.map(([, y]) => y));
    assert.ok(Math.abs(kept - (4.5 - z) * 100) < 0.02, `z ${z}: kept ${kept} px of the height`);
  }
});

test('whole, cut and gone: clip-path is written only while cut and cleared once, and still frames write nothing', () => {
  const { engine, renderer, add } = setup({ near: 1 });
  const panel = add({ position: [0, -0.2, 0], quaternion: flat });
  engine.frame();
  assert.equal(panel.onScreen, true);
  assert.equal(panel.clipped, false);
  assert.equal(panel.element.style.clipPath, undefined, 'a whole panel never gets a clip-path');
  panel.setPose([0, -0.2, 4.2], flat);
  engine.frame();
  assert.equal(panel.clipped, true);
  assert.match(panel.element.style.clipPath, /^polygon\(/);
  engine.frame();
  assert.equal(renderer.writes, 0, 'a still cut panel writes nothing');
  panel.setPose([0, -0.2, 0], flat);
  engine.frame();
  assert.equal(panel.element.style.clipPath, '', 'the cut is cleared when the panel is whole again');
  const writes = panel.element.styleWrites;
  engine.frame();
  engine.frame();
  assert.equal(panel.element.styleWrites, writes);
  panel.setPose([0, -0.2, 4.8], flat);
  engine.frame();
  assert.equal(panel.onScreen, false, 'entirely before the near plane: hidden');
  assert.equal(panel.clipped, false);
  assert.equal(panel.element.style.display, 'none');
  assert.equal(panel.reads(), 1, 'measured once');
  panel.remeasure();
  engine.frame();
  assert.equal(panel.reads(), 2, 'remeasure() measures again');
});

test('random poses: the clip polygon holds exactly the element points in front of the near plane', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const { engine, add } = setup({ near: 0.5 });
  const objects = [];
  for (let i = 0; i < 60; i++) {
    const q = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5];
    const object = add(
      {
        position: [random() * 2 - 1, random() * 2 - 1, 3 + random() * 3.5],
        quaternion: q,
        pixelScale: 0.004 + random() * 0.01,
      },
      [40 + Math.floor(random() * 260), 30 + Math.floor(random() * 160)],
    );
    objects.push(object);
  }
  engine.frame();
  let cut = 0,
    hidden = 0,
    whole = 0,
    samples = 0;
  for (const object of objects) {
    const [w, h] = object.size;
    const corners = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ].map(([x, y]) => inFront(engine, pixel(object, x, y)));
    if (Math.max(...corners) <= 0) {
      hidden++;
      assert.equal(object.onScreen, false, 'no corner in front: hidden');
      continue;
    }
    assert.equal(object.onScreen, true);
    if (Math.min(...corners) >= 0) {
      whole++;
      assert.equal(object.clipped, false);
      continue;
    }
    cut++;
    assert.equal(object.clipped, true);
    const points = polygon(object);
    for (let gy = 0; gy <= 20; gy++)
      for (let gx = 0; gx <= 20; gx++) {
        const x = (gx / 20) * w,
          y = (gy / 20) * h,
          d = inFront(engine, pixel(object, x, y)),
          result = inside(points, x, y, 0.05);
        // Points on the cut, within the 0.01 px rounding of the vertices, are not judged.
        if (result === null || Math.abs(d) < 1e-3) continue;
        samples++;
        assert.equal(result, d > 0, `pixel ${x},${y} at depth ${d} ${result ? 'kept' : 'cut'}`);
      }
  }
  assert.ok(cut >= 5 && hidden >= 3 && whole >= 5, `cases: ${cut} cut, ${hidden} hidden, ${whole} whole`);
  assert.ok(samples > 1000);
});

test('orthographic: a panel through the near plane is cut at depth 0', () => {
  const { engine, add } = setup();
  const projection = new CameraProjection({ height: 4, near: 1, far: 20 });
  projection.attach(engine.camera);
  const panel = add({ position: [0, -0.2, 4.1], quaternion: flat });
  engine.frame();
  assert.equal(panel.onScreen, true);
  assert.equal(panel.clipped, true);
  const points = polygon(panel);
  assert.equal(points.length, 4);
  const depth = (x, y) => projectPoint(engine.camera.matrix, ...pixel(panel, x, y), 800, 400).depth;
  for (const [x, y] of points) assert.ok(depth(x, y) >= -1e-4, `vertex ${x},${y} before the near plane`);
  assert.equal(points.filter(([x, y]) => Math.abs(depth(x, y)) < 1e-4).length, 2);
  projection.dispose();
});

test('the CSS 3D occlude hook gets the origin and hides the object while it returns true', () => {
  const { engine, add } = setup();
  const calls = [];
  let blocked = true;
  const panel = add({
    position: [1, 0.5, 0],
    occlude: (object, info) => (calls.push([object, info]), blocked),
  });
  engine.frame();
  assert.equal(panel.onScreen, false);
  assert.equal(panel.element.style.display, 'none');
  const [object, info] = calls[0];
  assert.equal(object, panel);
  assert.deepEqual(info.world, [1, 0.5, 0]);
  const expected = projectPoint(engine.camera.matrix, 1, 0.5, 0, 800, 400);
  assert.ok(Math.abs(info.x - expected.x) < 1e-9 && Math.abs(info.y - expected.y) < 1e-9);
  assert.ok(Math.abs(info.distance - Math.hypot(1, 0.5, 5)) < 1e-9);
  blocked = false;
  engine.frame();
  assert.equal(panel.onScreen, true);
  assert.equal(panel.element.style.display, '');
  // Not asked for objects already hidden by the near plane.
  panel.setPose([0, 0, 6]);
  const before = calls.length;
  engine.frame();
  assert.equal(calls.length, before);
  assert.equal(panel.onScreen, false);
});
