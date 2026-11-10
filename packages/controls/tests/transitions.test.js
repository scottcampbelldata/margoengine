import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraProjection } from '@margoengine/cameras';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { OrbitControls, MapControls, ArcballControls, TrackballControls } from '../dist/transitions.js';
import { camera, FakeElement, pointer, close, closeVec } from './control-fakes.js';

const controls = { OrbitControls, MapControls, ArcballControls, TrackballControls };
const rig = (Control, options = {}) => {
  const cam = camera(options),
    el = new FakeElement(),
    control = new Control(cam, el);
  return { cam, el, control, moves: control.transitions };
};
const advance = (control, duration = 1, fps = 60) => {
  for (let i = 0; i < Math.ceil(duration * fps); i++) control.update(1 / fps);
};
const project = (cam, point, aspect) => {
  cam.update(aspect);
  const m = cam.matrix;
  const v = [0, 1, 2, 3].map((r) => m[r] * point[0] + m[4 + r] * point[1] + m[8 + r] * point[2] + m[12 + r]);
  return v.slice(0, 3).map((x) => x / v[3]);
};

for (const [name, Control] of Object.entries(controls)) {
  test(`${name}: eased moves, replacement, input interruption and reset`, async () => {
    const { cam, control, el, moves } = rig(Control);
    const first = moves.setLookAt([10, 2, 0], [1, 0, 0], { duration: 1 });
    control.update(0);
    closeVec(cam.position, [0, 0, 10], 1e-12);
    control.update(0.5);
    cam.update(4 / 3);
    assert.notDeepEqual(cam.position, [0, 0, 10]);
    const midpoint = [...cam.position];
    const second = moves.setLookAt([0, 4, -10], [1, 1, 0], { duration: 1 });
    assert.equal(await first, false);
    closeVec(cam.position, midpoint, 0);
    advance(control);
    assert.equal(await second, true);
    closeVec(cam.position, [0, 4, -10], 1e-12);
    closeVec(cam.target, [1, 1, 0], 1e-12);
    const interrupted = moves.setTarget([2, 2, 2]);
    pointer(el, 'pointerdown', 100, 100);
    assert.equal(await interrupted, false);
    pointer(el, 'pointermove', 180, 120);
    control.update(1 / 60);
    pointer(el, 'pointerup', 180, 120);
    assert.notDeepEqual(cam.position, [0, 4, -10]);
    const reset = moves.setTarget([1, 2, 3]);
    control.reset();
    assert.equal(await reset, false);
    closeVec(cam.position, [0, 0, 10], 0);
    control.dispose();
    assert.equal(el.listenerCount, 0);
    assert.throws(() => moves.setTarget([1, 0, 0]), /disposed/i);
  });

  test(`${name}: antipodal views never cross the target; frame rates agree`, async () => {
    const a = rig(Control),
      b = rig(Control);
    const pending = [a, b].map((r) => r.moves.setLookAt([0, 0, -20], [0, 0, 0], { duration: 1 }));
    for (let i = 0; i < 30; i++) {
      a.control.update(1 / 30);
      b.control.update(1 / 60);
      b.control.update(1 / 60);
      closeVec(a.cam.position, b.cam.position, 1e-10);
      closeVec(a.cam.up, b.cam.up, 1e-10);
      assert.ok(Math.hypot(...a.cam.position) >= 10 - 1e-10);
      a.cam.update(4 / 3);
      b.cam.update(4 / 3);
    }
    // A final subframe accounts for accumulated IEEE-754 clock error.
    a.control.update(1e-12);
    b.control.update(1e-12);
    assert.deepEqual(await Promise.all(pending), [true, true]);
    a.control.dispose();
    b.control.dispose();
  });

  test(`${name}: perspective fits contain every box corner and sphere sample`, async () => {
    const { cam, control, moves } = rig(Control, { position: [12, 7, 9] });
    for (const aspect of [0.5, 2]) {
      const min = [-3, -1, -7],
        max = [4, 3, 1];
      assert.equal(await moves.fitToBox({ min, max }, { duration: 0, padding: 0.1, aspect }), true);
      for (let i = 0; i < 8; i++) {
        const ndc = project(cam, [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]], aspect);
        assert.ok(Math.abs(ndc[0]) <= 0.800001 && Math.abs(ndc[1]) <= 0.800001, String(ndc));
        assert.ok(ndc[2] >= 0 && ndc[2] <= 1);
      }
      const centre = [3, -2, 1],
        radius = 4;
      await moves.fitToSphere({ centre, radius }, { duration: 0, padding: 0.1, aspect });
      for (let i = 0; i < 250; i++) {
        const y = 1 - (2 * i) / 249,
          angle = i * Math.PI * (3 - Math.sqrt(5)),
          r = Math.sqrt(1 - y * y);
        const ndc = project(
          cam,
          [centre[0] + radius * r * Math.cos(angle), centre[1] + radius * y, centre[2] + radius * r * Math.sin(angle)],
          aspect,
        );
        assert.ok(Math.abs(ndc[0]) <= 0.800001 && Math.abs(ndc[1]) <= 0.800001, String(ndc));
      }
    }
    control.dispose();
  });
}

test('abort, invalid requests, external edits, wheel and disposal settle without camera jumps', async () => {
  const { cam, control, el, moves } = rig(OrbitControls);
  const signal = new AbortController();
  const pending = moves.setTarget([2, 3, 4], { signal: signal.signal });
  control.update(0.2);
  const current = [...cam.position];
  signal.abort();
  assert.equal(await pending, false);
  closeVec(cam.position, current, 0);
  assert.equal(await moves.setTarget([1, 2, 3], { signal: signal.signal }), false);
  const external = moves.setTarget([3, 2, 1]);
  cam.position = [1, 2, 10];
  control.update(0.2);
  assert.equal(await external, false);
  closeVec(cam.position, [1, 2, 10], 0);
  const wheel = moves.setTarget([0, 0, 0]);
  el.dispatch('wheel', { deltaY: -100, deltaMode: 0, clientX: 400, clientY: 300 });
  assert.equal(await wheel, false);
  const dispose = moves.setTarget([2, 3, 4]);
  assert.throws(() => moves.setTarget([NaN, 0, 0]), /finite/);
  assert.equal(moves.active, true, 'an invalid replacement preserves the current motion');
  assert.throws(() => moves.setTarget([0, 0, 0], { duration: -1 }), /duration/);
  control.dispose();
  assert.equal(await dispose, false);
});

test('a new move clears existing damping and trackball coast, without changing reset state', async () => {
  for (const Control of Object.values(controls)) {
    const { cam, el, control, moves } = rig(Control);
    control.enableDamping = true;
    pointer(el, 'pointerdown', 200, 200);
    pointer(el, 'pointermove', 350, 240);
    control.update(1 / 60);
    pointer(el, 'pointerup', 350, 240);
    await moves.setLookAt([4, 2, 8], [1, 0, 0], { duration: 0 });
    const settled = [...cam.position];
    advance(control);
    closeVec(cam.position, settled, 1e-12);
    control.reset();
    closeVec(cam.position, [0, 0, 10], 0);
    control.dispose();
  }
});

test('rolled views interpolate orthonormal frames, including a 180 degree up change', async () => {
  for (const Control of [ArcballControls, TrackballControls]) {
    const { cam, control, moves } = rig(Control);
    control.enableRoll = true;
    const pending = moves.setLookAt([0, 0, 10], [0, 0, 0], { duration: 1, up: [0, -1, 0] });
    for (let i = 0; i < 61; i++) {
      control.update(1 / 60);
      cam.update(1);
      close(Math.hypot(...cam.up), 1, 1e-12);
      close(
        cam.up.reduce((n, v, j) => n + v * (cam.position[j] - cam.target[j]), 0),
        0,
        1e-10,
      );
    }
    assert.equal(await pending, true);
    closeVec(cam.up, [0, -1, 0], 0);
    control.dispose();
  }
});

test('orthographic box and sphere fits animate zoom and respect limits', async () => {
  for (const Control of Object.values(controls)) {
    const cam = camera({ position: [12, 7, 9] }),
      el = new FakeElement();
    const projection = new CameraProjection({ mode: 'orthographic', height: 4 });
    projection.attach(cam);
    const control = new Control(cam, el, { projection }),
      moves = control.transitions;
    if (Control !== ArcballControls) control.projection = projection;
    cam.update(0.5);
    const p = moves.fitToBox({ min: [-3, -1, -7], max: [4, 3, 1] }, { aspect: 0.5, padding: 0.1 });
    advance(control);
    assert.equal(await p, true);
    for (let i = 0; i < 8; i++) {
      const ndc = project(cam, [i & 1 ? 4 : -3, i & 2 ? 3 : -1, i & 4 ? 1 : -7], 0.5);
      assert.ok(Math.abs(ndc[0]) <= 0.800001 && Math.abs(ndc[1]) <= 0.800001, String(ndc));
    }
    cam.update(0.5);
    await moves.fitToSphere({ centre: [0, 0, 0], radius: 4 }, { duration: 0, aspect: 0.5 });
    control.minZoom = 100;
    cam.update(0.5);
    assert.throws(() => moves.fitToSphere({ centre: [0, 0, 0], radius: 4 }), /zoom/);
    control.dispose();
    projection.dispose();
  }
});

test('world-up controls retain their horizon when a roll-only up option is supplied', async () => {
  for (const Control of [OrbitControls, MapControls, TrackballControls]) {
    const { cam, control, moves } = rig(Control);
    await moves.setLookAt([4, 2, 8], [0, 0, 0], { duration: 0, up: [1, 0, 0] });
    closeVec(cam.up, [0, 1, 0], 0);
    control.dispose();
  }
});

test('keyboard input interrupts before applying motion, with and without damping', async () => {
  for (const Control of [OrbitControls, MapControls, ArcballControls]) {
    for (const damping of [false, true]) {
      const { cam, el, control, moves } = rig(Control);
      control.listenToKeyEvents(el);
      control.enableDamping = damping;
      const pending = moves.setLookAt([8, 2, -4], [0, 0, 0]);
      el.dispatch('keydown', { code: 'ArrowLeft' });
      assert.equal(await pending, false);
      control.update(1 / 60);
      assert.notDeepEqual(cam.position, [0, 0, 10]);
      control.dispose();
    }
  }
});

test('engine updates and scene disposal own the transition', async () => {
  const engine = new Engine(
    new FakeElement(),
    await TransformStore.create(16),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  const control = new OrbitControls(engine);
  const pending = control.transitions.setLookAt([2, 1, 8], [0, 0, 0]);
  engine.render({ delta: 0.2 });
  assert.notDeepEqual(engine.camera.position, [0, 2, 5]);
  engine.dispose();
  assert.equal(await pending, false);
  assert.equal(control.element, null);
});

test('control distance, target shell and wrapped azimuth limits hold for the full path', async () => {
  const { cam, control, moves } = rig(OrbitControls, { position: [0, 0, -10] });
  control.minDistance = 5;
  control.maxDistance = 20;
  assert.throws(() => moves.setLookAt([0, 0, 25], [0, 0, 0]), /distance/);
  control.minAzimuthAngle = (3 * Math.PI) / 4;
  control.maxAzimuthAngle = (-3 * Math.PI) / 4;
  const pending = moves.setLookAt([-1, 0, -10], [0, 0, 0]);
  for (let i = 0; i < 40; i++) {
    control.update(1 / 60);
    const angle = Math.atan2(cam.position[0], cam.position[2]);
    assert.ok(Math.abs(angle) >= (3 * Math.PI) / 4);
  }
  assert.equal(await pending, true);
  control.minAzimuthAngle = -Infinity;
  control.maxAzimuthAngle = Infinity;
  cam.target = [2, 0, 0];
  cam.position = [2, 0, 10];
  control.minTargetRadius = 1;
  assert.throws(() => moves.setLookAt([-2, 0, 10], [-2, 0, 0]), /path crosses/);
  control.dispose();
});

test('bad or reentrant easing settles the old promise and preserves the new view', async () => {
  const { cam, control, moves } = rig(OrbitControls);
  for (const easing of [
    () => NaN,
    () => 2,
    () => {
      throw new Error('custom easing failure');
    },
  ]) {
    const pending = moves.setTarget([1, 0, 0], { easing });
    assert.throws(() => control.update(0.1), /easing/);
    assert.equal(await pending, false);
    assert.equal(moves.active, false);
  }
  let replacement;
  const pending = moves.setTarget([2, 0, 0], {
    easing() {
      replacement = moves.setTarget([3, 0, 0], { duration: 0 });
      return 0.5;
    },
  });
  control.update(0.1);
  assert.equal(await pending, false);
  assert.equal(await replacement, true);
  closeVec(cam.target, [3, 0, 0], 0);
  control.dispose();
});
