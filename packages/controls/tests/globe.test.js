import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobeControls } from '../dist/globe.js';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { FloatingOrigin } from '@margoengine/cameras/origin';
import { camera, FakeElement, pointer, close, closeVec } from './control-fakes.js';

const rig = (radii = [2, 1.8, 2], position = [0, 0, 7], options = {}) => {
  const cam = camera({ position, target: [0, 0, 0], near: Math.min(...radii) * 0.001, far: Math.max(...radii) * 20 }),
    el = new FakeElement();
  const control = new GlobeControls(cam, el, { radii, minAltitude: 0.01, ...options });
  return { cam, el, control };
};
const screen = (cam, p) => {
  cam.update(4 / 3); // The engine must also accept the resulting frustum.
  // Evaluate the invariant in double precision; the GPU matrix deliberately stores Float32.
  const unit = (v) => v.map((x) => x / Math.hypot(...v)),
    dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0),
    cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    forward = unit(cam.target.map((v, i) => v - cam.position[i])),
    right = unit(cross(forward, cam.up)),
    up = cross(right, forward),
    offset = p.map((v, i) => v - cam.position[i]),
    half = dot(offset, forward) * Math.tan((cam.fov * Math.PI) / 360);
  return [400 + (300 * dot(offset, right)) / half, 300 - (300 * dot(offset, up)) / half];
};
for (const radii of [
  [2, 2, 2],
  [2, 1.4, 2.6],
  [6378137, 6356752.314245, 6378137],
]) {
  test(`Globe pick, grab and cursor zoom preserve the surface pixel: ${radii}`, () => {
    const { cam, control } = rig(radii, [0, 0, radii[2] * 3]);
    const hit = control.pick(400, 300);
    closeVec(hit, [0, 0, radii[2]], radii[2] * 1e-12);
    assert.equal(control.pick(-10000, 300), null);
    assert.equal(control.grab(hit, 440, 320), true);
    closeVec(screen(cam, hit), [440, 320], 1e-7);
    const cursorHit = control.pick(420, 310),
      before = screen(cam, cursorHit),
      oldDistance = Math.hypot(...cam.position.map((v, i) => v - cursorHit[i]));
    control.zoomAt(420, 310, -500);
    closeVec(screen(cam, cursorHit), before, 1e-7);
    close(Math.hypot(...cam.position.map((v, i) => v - cursorHit[i])), oldDistance / 2, oldDistance * 1e-12);
    control.dispose();
  });
}
test('Tilt stays about the picked point and clamps above its horizon', () => {
  const { cam, control } = rig();
  const hit = control.pick(400, 300),
    before = screen(cam, hit);
  for (let i = 0; i < 40; i++) control.tilt(hit, 0.02, 0.1);
  closeVec(screen(cam, hit), before, 1e-7);
  const eye = cam.position.map((v, i) => v - hit[i]),
    n = control.normal(hit),
    d = Math.hypot(...eye);
  close(Math.acos(eye.reduce((s, v, i) => s + v * n[i], 0) / d), control.maxTilt, 1e-10);
  control.tilt(hit, 0, -100);
  closeVec(screen(cam, hit), before, 1e-7);
  close(cam.position[0], hit[0], 1e-9);
  close(cam.position[1], hit[1], 1e-9);
});
test('Orbit to street-level zoom never enters the ellipsoid; min/max altitude work', () => {
  const { control } = rig([6378137, 6356752.314245, 6378137], [0, 0, 2e7], { minAltitude: 1, maxAltitude: 3e7 });
  for (let i = 0; i < 100; i++) control.zoomAt(400, 300, -200);
  close(control.altitude, 1, 1e-8);
  control.zoomAt(400, 300, 1e6);
  close(control.altitude, 3e7, 1e-6);
  assert.equal(control.update(), true);
  assert.equal(control.update(), false);
});
test('Nonzero centre, far-side miss, finite inputs and geodetic normals', () => {
  const { cam, control } = rig([2, 1, 3], [10, 0, 10], { centre: [10, 0, 0] });
  cam.target = [10, 0, 0];
  closeVec(control.pick(400, 300), [10, 0, 3], 1e-12);
  closeVec(control.normal([10, 1, 0]), [0, 1, 0], 1e-12);
  assert.throws(() => control.normal([10, 0, 0]), /centre/);
  cam.target = [10, 0, 20];
  assert.equal(control.pick(400, 300), null);
  for (const bad of [NaN, Infinity]) {
    assert.throws(() => control.pick(bad, 0), /finite/);
    assert.throws(() => control.zoomAt(0, 0, bad), /finite/);
    assert.throws(() => control.tilt([10, 0, 3], bad, 0), /finite/);
  }
  for (const options of [
    { radii: [0, 1, 1] },
    { radii: [1, NaN, 1] },
    { minAltitude: 0 },
    { maxAltitude: 0 },
    { maxTilt: Math.PI },
  ])
    assert.throws(() => new GlobeControls(cam, null, options), RangeError);
});
test('Pointer capture, disabled actions, touch pinch and teardown use one lifecycle', () => {
  const { cam, el, control } = rig();
  const events = [];
  for (const type of ['start', 'change', 'end']) control.addEventListener(type, () => events.push(type));
  pointer(el, 'pointerdown', 400, 300);
  pointer(el, 'pointermove', 450, 320);
  pointer(el, 'pointerup', 450, 320);
  assert.ok(events.includes('change'));
  assert.equal(events[0], 'start');
  assert.equal(events.at(-1), 'end');
  assert.equal(el.captured.size, 0);
  const position = [...cam.position];
  control.enabled = false;
  pointer(el, 'pointerdown', 400, 300);
  el.dispatch('wheel', { clientX: 400, clientY: 300, deltaY: -100, deltaMode: 0 });
  closeVec(cam.position, position, 0);
  assert.equal(el.captured.size, 0);
  control.enabled = true;
  pointer(el, 'pointerdown', 350, 300, { pointerType: 'touch' });
  pointer(el, 'pointerdown', 450, 300, { pointerType: 'touch', pointerId: 2 });
  const altitude = control.altitude;
  pointer(el, 'pointermove', 470, 300, { pointerType: 'touch', pointerId: 2 });
  assert.ok(control.altitude < altitude);
  pointer(el, 'pointercancel', 470, 300, { pointerType: 'touch', pointerId: 2 });
  control.dispose();
  assert.equal(el.listenerCount, 0);
  assert.equal(el.captured.size, 0);
  assert.equal(el.style.touchAction, 'auto');
  assert.throws(() => control.zoomAt(400, 300, 100), /disposed/);
  assert.throws(() => control.tilt([0, 0, 2], 0, 0), /disposed/);
  assert.throws(() => control.grab([0, 0, 2], 400, 300), /disposed/);
});
test('Floating-origin rebase during a grab preserves its global anchor and releases its subscription', async () => {
  const el = new FakeElement(),
    engine = new Engine(
      el,
      await TransformStore.create(8),
      { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
      undefined,
      null,
    );
  engine.camera.position = [0, 0, 6378237];
  engine.camera.target = [0, 0, 6378137];
  const origin = FloatingOrigin.attach(engine);
  origin.rebase([0, 0, 6378237]);
  const control = new GlobeControls(engine, el, { origin });
  pointer(el, 'pointerdown', 400, 300);
  origin.rebase([10, 0, 6378237]);
  close(control.altitude, 100, 1e-8);
  pointer(el, 'pointermove', 420, 300);
  closeVec(screen(engine.camera, origin.toLocal([0, 0, 6378137])), [420, 300], 1e-7);
  engine.dispose();
  assert.equal(el.listenerCount, 0);
  assert.equal(el.captured.size, 0);
});
