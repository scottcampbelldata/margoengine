import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { CameraProjection } from '../../cameras/dist/index.js';
import { BLENDER, OrbitControls } from '../dist/index.js';

class Element {
  clientWidth = 800;
  clientHeight = 600;
  style = { touchAction: 'auto' };
  listeners = new Map();
  captured = new Set();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  hasPointerCapture(id) {
    return this.captured.has(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  dispatch(type, values = {}) {
    const event = {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 400,
      clientY: 300,
      preventDefault() {},
      ...values,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
const rig = () => {
  const camera = new Camera({ position: [0, 0, 5], target: [0, 0, 0] }),
    element = new Element(),
    orbit = new OrbitControls(camera, element);
  return { camera, element, orbit };
};
const close = (actual, expected, message, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: expected ${expected}, got ${actual}`);

test('orbit leaves editor capture untouched for unbound or disabled mouse actions through teardown', () => {
  for (const configure of [
    (orbit) => (orbit.mouseButtons.LEFT = null),
    (orbit) => (orbit.enableRotate = false),
    (orbit) => orbit.setProfile(BLENDER),
  ]) {
    const { camera, element, orbit } = rig();
    configure(orbit);
    const before = [...camera.position];
    element.setPointerCapture(1); // Another listener already owns this canvas gesture.
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      element.dispatch(type, { clientX: 450, clientY: 340 });
      assert.ok(element.hasPointerCapture(1), `${type} must preserve editor capture`);
      assert.equal(orbit.state, 'none');
      assert.deepEqual(camera.position, before);
    }
    orbit.dispose();
    assert.ok(element.hasPointerCapture(1), 'dispose must not release an ignored pointer');
  }
});

test('orbit ignores an unrelated mouse pointer while its own drag is active', () => {
  const { element, orbit } = rig();
  orbit.mouseButtons.LEFT = null;
  element.dispatch('pointerdown', { button: 1 });
  assert.equal(orbit.state, 'dolly');
  element.setPointerCapture(2);
  element.dispatch('pointerdown', { pointerId: 2 });
  element.dispatch('pointercancel', { pointerId: 2 });
  assert.ok(element.hasPointerCapture(2), 'unrelated cancellation must preserve editor capture');
  assert.equal(orbit.state, 'dolly');
  orbit.dispose();
  assert.equal(element.hasPointerCapture(1), false, 'owned pointer is released');
  assert.ok(element.hasPointerCapture(2), 'unrelated pointer survives disposal');
});

for (const pointerType of ['mouse', 'touch']) {
  for (const ending of ['pointerup', 'pointercancel', 'disable', 'dispose']) {
    test(`orbit releases its handled ${pointerType} gesture on ${ending}`, () => {
      const { camera, element, orbit } = rig();
      const event = { pointerType };
      element.dispatch('pointerdown', event);
      assert.ok(element.hasPointerCapture(1));
      assert.notEqual(orbit.state, 'none');
      element.dispatch('pointermove', { ...event, clientX: 450, clientY: 330 });
      assert.notDeepEqual(camera.position, [0, 0, 5], 'handled gesture still moves the camera');
      if (ending === 'dispose') orbit.dispose();
      else if (ending === 'disable') {
        orbit.enabled = false;
        element.dispatch('pointermove', event);
      } else element.dispatch(ending, event);
      assert.equal(element.hasPointerCapture(1), false);
      assert.equal(orbit.state, 'none');
      orbit.dispose();
    });
  }
}

for (const y of [5, -5]) {
  for (const damping of [false, true]) {
    test(`orbit preserves renderable ${y > 0 ? 'top' : 'bottom'} view without rotation, damping=${damping}`, () => {
      const { camera, orbit } = rig();
      camera.position = [0, y, 0];
      camera.up = y > 0 ? [0, 0, -1] : [0, 0, 1];
      orbit.enableDamping = damping;
      camera.update(4 / 3, true);
      for (let i = 0; i < 5; i++) {
        assert.equal(orbit.update(1 / 60), false, 'idle view must not report motion');
        assert.deepEqual(camera.position, [0, y, 0]);
        assert.deepEqual(camera.target, [0, 0, 0]);
      }
      orbit.pan(24, -18);
      orbit.update();
      assert.notDeepEqual(camera.target, [0, 0, 0], 'pan still moves the target');
      for (let i = 0; i < 10; i++) {
        orbit.update();
        assert.equal(camera.position[0], camera.target[0], 'pan preserves exact X direction');
        assert.equal(camera.position[2], camera.target[2], 'pan preserves exact Z direction');
        close(camera.position[1] - camera.target[1], y, 'pan preserves distance');
        camera.update(4 / 3, true);
      }
      orbit.dollyIn(0.5);
      orbit.update();
      assert.equal(camera.position[0], camera.target[0]);
      assert.equal(camera.position[2], camera.target[2]);
      close(camera.position[1] - camera.target[1], y / 2, 'dolly preserves exact direction');
      orbit.maxDistance = 1;
      orbit.update();
      close(camera.position[1] - camera.target[1], Math.sign(y), 'distance limits remain active');
      camera.update(4 / 3, true);
      orbit.dispose();
    });
  }

  test(`orbit keeps the ${y > 0 ? 'top' : 'bottom'} default-up safety clamp and configured polar limits`, () => {
    const { camera, orbit } = rig();
    camera.position = [0, y, 0];
    orbit.update(0);
    assert.notEqual(camera.position[2], 0, 'parallel default up must stay away from the pole');
    assert.doesNotThrow(() => camera.update(4 / 3, true));
    camera.position = [0, y, 0];
    camera.up = [0, 0, -1];
    orbit.minPolarAngle = 0.25;
    orbit.maxPolarAngle = Math.PI - 0.25;
    orbit.update(0);
    close(orbit.getPolarAngle(), y > 0 ? 0.25 : Math.PI - 0.25, 'configured polar limit');
    assert.doesNotThrow(() => camera.update(4 / 3, true));
    orbit.dispose();
  });

  test(`orbit enforces azimuth limits from a renderable exact ${y > 0 ? 'top' : 'bottom'} view`, () => {
    const { camera, orbit } = rig();
    camera.position = [0, y, 0];
    camera.up = y > 0 ? [0, 0, -1] : [0, 0, 1];
    orbit.minAzimuthAngle = Math.PI / 4;
    orbit.maxAzimuthAngle = Math.PI / 2;
    orbit.update(0);
    close(orbit.getAzimuthalAngle(), Math.PI / 4, 'configured azimuth limit');
    assert.doesNotThrow(() => camera.update(4 / 3, true));
    orbit.dispose();
  });

  test(`orbit leaves an exact ${y > 0 ? 'top' : 'bottom'} pole with its screen-up heading`, () => {
    for (const up of [
      [-1, 0, 0],
      [0, 0, -1],
    ]) {
      const { camera, orbit } = rig();
      camera.position = [0, y, 0];
      camera.up = up;
      const heading = orbit.getAzimuthalAngle();
      orbit.rotateUp(y > 0 ? -0.1 : 0.1);
      orbit.update(0);
      close(Math.atan2(camera.position[0], camera.position[2]), heading, 'departure heading');
      assert.notEqual(camera.position[2] || camera.position[0], 0);
      assert.doesNotThrow(() => camera.update(4 / 3, true));
      orbit.dispose();
    }
  });
}

const pixel = (camera, point) => {
  camera.update(4 / 3, true);
  const m = camera.matrix,
    w = m[3] * point[0] + m[7] * point[1] + m[11] * point[2] + m[15];
  return [
    ((m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12]) / w + 1) * 400,
    (1 - (m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13]) / w) * 300,
  ];
};
for (const y of [5, -5]) {
  for (const screenUp of [
    [-1, 0, 0],
    [1, 0, 0],
    [-1e-20, 0, 0],
  ]) {
    for (const orthographic of [false, true]) {
      test(`orbit exact pole y=${y}, up=${screenUp}, orthographic=${orthographic} keeps the wheel cursor's projected world point`, () => {
        const { camera, element, orbit } = rig();
        camera.position = [0, y, 0];
        camera.up = screenUp;
        const projection = orthographic ? new CameraProjection() : undefined;
        if (projection) {
          projection.up = screenUp;
          projection.attach(camera);
        }
        orbit.zoomToCursor = true;
        const cursor = [610, 180],
          up = screenUp.map((v) => v / Math.hypot(...screenUp)),
          right = [-Math.sign(y) * up[2], 0, Math.sign(y) * up[0]],
          half = Math.abs(y) * Math.tan(Math.PI / 6),
          point = up.map(
            (v, i) => v * (1 - cursor[1] / 300) * half + (right[i] * (cursor[0] / 400 - 1) * half * 4) / 3,
          );
        const checkPixel = () =>
          pixel(camera, point).forEach((v, i) =>
            assert.ok(Math.abs(v - cursor[i]) < 1e-4, `cursor ${i}: expected ${cursor[i]}, got ${v}`),
          );
        checkPixel();
        for (const deltaY of [-200, -200, 300]) {
          element.dispatch('wheel', { deltaY, deltaMode: 0, clientX: cursor[0], clientY: cursor[1] });
          assert.equal(camera.position[0], camera.target[0]);
          assert.equal(camera.position[2], camera.target[2]);
          checkPixel();
        }
        const before = [...camera.target],
          panHalf = orbit.getDistance() * Math.tan(Math.PI / 6);
        orbit.pan(20, -10);
        orbit.update();
        camera.target.forEach((v, i) =>
          // Orthographic panning reads the public Float32 projection matrix.
          close(
            v - before[i],
            ((-40 * right[i] - 20 * up[i]) * panHalf) / 600,
            'pan screen frame',
            orthographic ? 1e-7 : 1e-12,
          ),
        );
        assert.equal(camera.position[0], camera.target[0]);
        assert.equal(camera.position[2], camera.target[2]);
        orbit.dispose();
        projection?.dispose();
      });
    }
  }
}
