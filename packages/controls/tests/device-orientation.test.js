import test from 'node:test';
import assert from 'node:assert/strict';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { DeviceOrientationControls, deviceOrientationQuaternion } from '../dist/device-orientation.js';
import { FakeTarget, FakeElement, camera, close, closeVec, run } from './control-fakes.js';
const source = (request) => {
  const target = new FakeTarget();
  target.DeviceOrientationEvent = request ? { requestPermission: request } : {};
  target.screen = { orientation: { angle: 0 } };
  return target;
};
const sample = (target, alpha = 0, beta = 90, gamma = 0, absolute = false) =>
  target.dispatch('deviceorientation', { alpha, beta, gamma, absolute });
test('W3C axes: upright phone, north/west heading, flat device and screen compensation', () => {
  const forward = (q) => rotateByQuaternion([0, 0, -1], q),
    up = (q) => rotateByQuaternion([0, 1, 0], q);
  closeVec(forward(deviceOrientationQuaternion(0, 90, 0)), [0, 0, -1], 1e-15);
  closeVec(up(deviceOrientationQuaternion(0, 90, 0)), [0, 1, 0], 1e-15);
  closeVec(forward(deviceOrientationQuaternion(90, 90, 0)), [-1, 0, 0], 1e-15);
  closeVec(forward(deviceOrientationQuaternion(0, 0, 0)), [0, -1, 0], 1e-15);
  closeVec(up(deviceOrientationQuaternion(0, 90, 0, 90)), [1, 0, 0], 1e-15);
  assert.throws(() => deviceOrientationQuaternion(NaN, 0, 0), RangeError);
});
test('degree triples agree with an independent scalar intrinsic Z-X-Y matrix transform over the valid sensor domain', () => {
  const rotate = (v, axis, angle) => {
    const out = [...v],
      a = (axis + 1) % 3,
      b = (axis + 2) % 3,
      c = Math.cos((angle * Math.PI) / 180),
      s = Math.sin((angle * Math.PI) / 180);
    out[a] = v[a] * c - v[b] * s;
    out[b] = v[a] * s + v[b] * c;
    return out;
  };
  for (let i = 0; i < 120; i++) {
    const alpha = (i * 137) % 360,
      beta = ((i * 73) % 360) - 180,
      gamma = ((i * 31) % 180) - 90,
      screen = [0, 90, 180, 270][i % 4];
    const q = deviceOrientationQuaternion(alpha, beta, gamma, screen);
    close(Math.hypot(...q), 1, 1e-14);
    for (const v of [
      [0, 1, 0],
      [0, 0, -1],
      [1, 0, 0],
    ]) {
      let expected = rotate(v, 2, -screen);
      expected = rotate(expected, 1, gamma);
      expected = rotate(expected, 0, beta);
      expected = rotate(expected, 2, alpha);
      expected = rotate(expected, 0, -90);
      closeVec(rotateByQuaternion(v, q), expected, 2e-14);
    }
  }
});
test('absolute-reference look preserves eye and target distance, ignores null/invalid samples and respects enabled', () => {
  const target = source(),
    el = new FakeElement(),
    cam = camera(),
    control = new DeviceOrientationControls(cam, { source: target, element: el, relative: false, smoothTime: 0 });
  assert.equal(control.permission, 'granted');
  sample(target, 90, 90, 0, true);
  assert.equal(control.update(), true);
  closeVec(cam.position, [0, 0, 10], 0);
  closeVec(cam.target, [-10, 0, 10], 1e-12);
  closeVec(cam.up, [0, 1, 0], 1e-12);
  assert.equal(control.absolute, true);
  const previous = [...cam.target];
  sample(target, null, 90, 0);
  assert.equal(control.update(), false);
  closeVec(cam.target, previous, 0);
  sample(target, NaN, 90, 0);
  assert.equal(control.update(), false);
  control.enabled = false;
  sample(target, 180);
  assert.equal(control.update(), false);
  control.enabled = true;
  control.update();
  closeVec(cam.target, previous, 1e-12);
  control.dispose();
  assert.equal(target.listenerCount, 0);
  assert.equal(el.listenerCount, 0);
  assert.equal(control.update(), false);
});
test('relative first sample and recenter with a yaw offset never jump the current view', () => {
  const target = source(),
    cam = camera({ position: [3, 4, 5], target: [-1, 2, 0] }),
    before = [...cam.target];
  const control = new DeviceOrientationControls(cam, { source: target, smoothTime: 0 });
  sample(target, 220, 63, -20);
  control.update();
  closeVec(cam.target, before, 1e-12);
  sample(target, 245, 63, -20);
  control.update();
  assert.notDeepEqual(cam.target, before);
  control.alphaOffset = 0.4;
  control.update();
  const now = [...cam.target],
    up = [...cam.up];
  control.recenter();
  control.update();
  closeVec(cam.target, now, 2e-12);
  closeVec(cam.up, up, 1e-12);
  control.dispose();
  assert.equal(target.listenerCount, 0);
});
test('screen changes are read without a new sensor event; legacy screen angles work too', () => {
  for (const legacy of [false, true]) {
    const target = source(),
      cam = camera(),
      control = new DeviceOrientationControls(cam, { source: target, relative: false, smoothTime: 0 });
    sample(target);
    control.update();
    if (legacy) {
      delete target.screen;
      target.orientation = 90;
    } else target.screen.orientation.angle = 90;
    control.update();
    closeVec(cam.up, [1, 0, 0], 1e-12);
    closeVec(cam.target, [0, 0, 0], 1e-12);
    control.dispose();
  }
});
test('quaternion smoothing is frame-rate independent, follows the short arc and remains finite through vertical views', () => {
  const values = [];
  for (const fps of [30, 120]) {
    const target = source(),
      cam = camera(),
      control = new DeviceOrientationControls(cam, { source: target, relative: false, smoothTime: 0.2 });
    sample(target, 350);
    control.update();
    sample(target, 10);
    run(control, 0.5, fps);
    values.push([...cam.target, ...cam.up]);
    assert.ok(cam.target[2] < 1);
    sample(target, 0, 0, 0);
    run(control, 3, fps);
    assert.ok([...cam.target, ...cam.up].every(Number.isFinite));
    control.dispose();
  }
  closeVec(values[0], values[1], 1e-12);
});
test('permission requests run synchronously in the user gesture, denied samples never move the camera, and errors propagate', async () => {
  let calls = 0,
    accept;
  const target = source(() => {
      calls++;
      return new Promise((resolve) => (accept = resolve));
    }),
    cam = camera();
  const control = new DeviceOrientationControls(cam, { source: target, relative: false, smoothTime: 0 });
  assert.equal(control.permission, 'prompt');
  sample(target, 90);
  assert.equal(control.update(), false);
  const request = control.requestPermission();
  assert.equal(calls, 1);
  accept('denied');
  assert.equal(await request, false);
  assert.equal(control.permission, 'denied');
  sample(target, 90);
  assert.equal(control.update(), false);
  closeVec(cam.target, [0, 0, 0], 0);
  const second = control.requestPermission();
  accept('granted');
  assert.equal(await second, true);
  sample(target, 90);
  control.update();
  closeVec(cam.target, [-10, 0, 10], 1e-12);
  const error = new Error('native permission failed');
  target.DeviceOrientationEvent.requestPermission = () => {
    throw error;
  };
  await assert.rejects(control.requestPermission(), (e) => e === error);
  control.dispose();
});
test('permission abort, disconnect and timeout cannot activate a late native permission result', async () => {
  for (const reason of ['signal', 'disconnect', 'timeout']) {
    let accept;
    const target = source(() => new Promise((resolve) => (accept = resolve))),
      control = new DeviceOrientationControls(camera(), { source: target }),
      abort = new AbortController();
    const pending = control.requestPermission({ signal: abort.signal, timeout: reason === 'timeout' ? 10 : 10000 });
    const check = assert.rejects(pending, (e) => e.name === (reason === 'timeout' ? 'TimeoutError' : 'AbortError'));
    if (reason === 'signal') abort.abort();
    if (reason === 'disconnect') control.disconnect();
    await check;
    accept('granted');
    await Promise.resolve();
    assert.equal(control.permission, 'prompt');
    sample(target, 90);
    assert.equal(control.update(), false);
    control.dispose();
  }
});
test('unsupported and disposed controls, pre-abort and invalid options have deterministic lifecycles', async () => {
  const unsupported = new DeviceOrientationControls(camera(), { source: null });
  assert.equal(unsupported.permission, 'unsupported');
  assert.equal(await unsupported.requestPermission(), false);
  unsupported.dispose();
  let calls = 0;
  const target = source(async () => {
      calls++;
      return 'granted';
    }),
    control = new DeviceOrientationControls(camera(), { source: target });
  await assert.rejects(control.requestPermission({ signal: AbortSignal.abort() }), (e) => e.name === 'AbortError');
  assert.equal(calls, 0);
  await assert.rejects(control.requestPermission({ timeout: 0 }), RangeError);
  control.dispose();
  await assert.rejects(control.requestPermission(), /disposed/);
  assert.throws(() => new DeviceOrientationControls(camera(), { source: target, smoothTime: -1 }), RangeError);
  assert.equal(target.listenerCount, 0);
});
