import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraProjection } from '../../cameras/dist/index.js';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { OrbitControls, MapControls } from '../dist/orbit.js';
import { FakeElement, camera, close, closeVec, pointer } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
const orbit = (Control = OrbitControls) => {
  const el = new FakeElement(),
    cam = camera(),
    control = new Control(cam, el);
  return { el, cam, control };
};
const panBy = (control, x, y) => {
  control.pan(x, y);
  control.update(0);
};
async function ortho(options = { mode: 'orthographic', height: 4 }, position = [0, 0, 10]) {
  const canvas = new Canvas(),
    engine = new Runtime(
      canvas,
      await TransformStore.create(16),
      { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
      { position, target: [0, 0, 0] },
      null,
    ),
    projection = new CameraProjection(options);
  engine.use(projection);
  engine.render();
  return { canvas, engine, projection, control: new OrbitControls(engine) };
}
function screen(cam, p) {
  cam.update(4 / 3, true);
  const m = cam.matrix,
    x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [((x / w + 1) / 2) * 800, ((1 - y / w) / 2) * 600];
}

test('target radius: defaults change nothing, and panning stops on the sphere with the camera moving along', () => {
  const { cam, control } = orbit();
  assert.deepEqual(control.cursor, [0, 0, 0]);
  assert.equal(control.minTargetRadius, 0);
  assert.equal(control.maxTargetRadius, Infinity);
  control.maxTargetRadius = 1;
  panBy(control, -10000, 0);
  closeVec(cam.target, [1, 0, 0], 1e-9, 'stopped at the radius');
  closeVec(cam.position, [1, 0, 10], 1e-9, 'the view direction is unchanged');
  panBy(control, 0, 10000);
  close(Math.hypot(...cam.target), 1, 1e-9, 'slides along the sphere');
  close(cam.position[2] - cam.target[2], 10, 1e-9);
  control.dispose();
});

test('target radius: the shell has a floor, is centred on cursor, works with targetBounds and on MapControls', () => {
  let { cam, control } = orbit();
  control.minTargetRadius = 2;
  control.update(0);
  closeVec(cam.target, [2, 0, 0], 1e-9, 'a target on the cursor leaves along +X');
  panBy(control, 200, 0);
  close(Math.hypot(...cam.target), 2, 1e-9, 'held out on the shell');
  control.dispose();

  ({ cam, control } = orbit());
  control.cursor = [5, 0, 0];
  control.maxTargetRadius = 1;
  control.update(0);
  closeVec(cam.target, [4, 0, 0], 1e-9, 'measured from cursor');
  closeVec(cam.position, [4, 0, 10], 1e-9);
  control.targetBounds = { min: [-1, -1, -1], max: [1, 1, 1] };
  control.update(0);
  closeVec(cam.target, [4, 0, 0], 1e-9, 'the sphere is applied last');
  control.dispose();

  ({ cam, control } = orbit(MapControls));
  control.maxTargetRadius = 1;
  panBy(control, 100000, 0);
  close(Math.hypot(...cam.target), 1, 1e-9);
  control.dispose();
});

test('zoom: reads and writes the projection, clamped, with a change event; needs a projection', async () => {
  const { engine, projection, control } = await ortho(),
    seen = [];
  control.addEventListener('change', () => seen.push(projection.zoom));
  assert.equal(control.zoom, 1);
  control.maxZoom = 3;
  control.zoom = 5;
  assert.equal(projection.zoom, 3);
  control.zoom = 3;
  assert.deepEqual(seen, [3], 'no change, no event');
  assert.throws(() => (control.zoom = 0), RangeError);
  assert.throws(() => (control.zoom = Number.NaN), RangeError);
  control.dispose();
  engine.dispose();

  const bare = orbit();
  assert.equal(bare.control.zoom, 1);
  assert.throws(() => (bare.control.zoom = 2), TypeError);
  const lens = { zoom: 1 };
  bare.control.projection = lens;
  bare.control.zoom = 2;
  assert.equal(lens.zoom, 2);
  bare.control.dispose();
});

test('orthoZoom: off, the wheel changes only the distance; on, it changes zoom, within limits, and the distance stays', async () => {
  const { canvas, engine, projection, control } = await ortho();
  canvas.dispatch('wheel', { deltaY: 500, deltaMode: 0, clientX: 400, clientY: 300 });
  close(projection.zoom, 1, 0, 'off by default');
  closeVec(engine.camera.position, [0, 0, 20], 1e-9);
  control.dollyIn(0.5);
  control.update(0);
  control.orthoZoom = true;
  const events = [];
  control.addEventListener('change', () => events.push(1));
  canvas.dispatch('wheel', { deltaY: -500, deltaMode: 0, clientX: 400, clientY: 300 });
  close(projection.zoom, 2, 1e-9, 'one doubling');
  closeVec(engine.camera.position, [0, 0, 10], 1e-9, 'the distance stays');
  assert.equal(events.length, 1, 'a zoom alone reports a change');
  control.maxZoom = 3;
  canvas.dispatch('wheel', { deltaY: -5000, deltaMode: 0, clientX: 400, clientY: 300 });
  close(projection.zoom, 3, 0);
  control.minZoom = 0.5;
  canvas.dispatch('wheel', { deltaY: 5000, deltaMode: 0, clientX: 400, clientY: 300 });
  close(projection.zoom, 0.5, 0);
  control.dispose();
  engine.dispose();
});

test('orthoZoom: with zoomToCursor the point under the pointer keeps its pixel; pinch and dolly drags zoom too', async () => {
  const { canvas, engine, projection, control } = await ortho();
  control.orthoZoom = true;
  control.zoomToCursor = true;
  engine.render();
  const at = [620, 140],
    aim = (() => {
      const half = 2,
        aspect = 800 / 600;
      return [(at[0] / 400 - 1) * half * aspect, (1 - at[1] / 300) * half, 0];
    })();
  closeVec(screen(engine.camera, aim), at, 1e-3, 'the world point under the pointer');
  canvas.dispatch('wheel', { deltaY: -500, deltaMode: 0, clientX: at[0], clientY: at[1] });
  engine.render();
  close(projection.zoom, 2, 1e-9);
  closeVec(screen(engine.camera, aim), at, 1e-3, 'kept on its pixel');
  control.mouseButtons.LEFT = 1; // MOUSE.DOLLY
  pointer(canvas, 'pointerdown', 400, 300);
  pointer(canvas, 'pointermove', 400, 400);
  pointer(canvas, 'pointerup', 400, 400);
  assert.ok(projection.zoom < 2, 'a dolly drag down zooms out');
  const before = projection.zoom,
    touch = (type, id, x) => pointer(canvas, type, x, 300, { pointerId: id, pointerType: 'touch' });
  touch('pointerdown', 1, 380);
  touch('pointerdown', 2, 420);
  touch('pointermove', 1, 360);
  touch('pointermove', 2, 440);
  touch('pointerup', 1, 360);
  touch('pointerup', 2, 440);
  close(projection.zoom, before * 2, 1e-6, 'spreading to twice the width doubles the zoom');
  control.dispose();
  engine.dispose();
});
