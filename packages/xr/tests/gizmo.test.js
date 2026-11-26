import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { TransformControls } from '../../controls/dist/transform.js';
import { XRController } from '../dist/index.js';
import { XRGizmo } from '../dist/gizmo.js';

const near = (actual, expected, tolerance, message = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} expected ${expected}, got ${actual}`);

/** A simulated input source with a target-ray pose: `aim(from, to)` points its ray (the pose's -Z axis) from one point at another. */
function hand(handedness) {
  const source = { targetRaySpace: {}, gripSpace: {}, profiles: [], handedness, targetRayMode: 'tracked-pointer' },
    controller = new XRController(source);
  return {
    source,
    controller,
    aim(from, to) {
      const d = to.map((v, i) => v - from[i]),
        l = Math.hypot(...d);
      controller.targetRay = {};
      controller.targetRayMatrix.set([1, 0, 0, 0, 0, 1, 0, 0, -d[0] / l, -d[1] / l, -d[2] / l, 0, ...from, 1]);
    },
    lose() {
      controller.targetRay = null;
      controller.targetRayMatrix.fill(0);
    },
  };
}
async function rig(t, { gizmo: gizmoOptions = {}, ...options } = {}) {
  const canvas = Object.assign(new EventTarget(), {
      width: 800,
      height: 600,
      clientWidth: 800,
      clientHeight: 600,
      getContext: () => null,
    }),
    store = await TransformStore.create(32),
    renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Runtime(canvas, store, renderer, { position: [6, 4, 6], target: [0, 0, 0] }, null),
    mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine, gizmoOptions);
  gizmo.attach(mesh);
  engine.render();
  const left = hand('left'),
    right = hand('right'),
    session = new EventTarget(),
    events = [];
  session.inputSources = [left.source, right.source];
  let frame = null;
  const host = {
    session,
    controllers: [left.controller, right.controller],
    onFrame(callback) {
      frame = callback;
      return () => {
        frame = null;
      };
    },
  };
  const driver = XRGizmo.attach(host, gizmo, {
    onHover: (e) => events.push(['hover', e.controller.source.handedness, e.handle]),
    onGrab: (e) => events.push(['grab', e.controller.source.handedness, e.handle]),
    onRelease: (e) => events.push(['release', e.controller.source.handedness, e.handle]),
    ...options,
  });
  t.after(() => {
    driver.dispose();
    gizmo.dispose();
    engine.dispose();
  });
  const fire = (type, who) => session.dispatchEvent(Object.assign(new Event(type), { inputSource: who.source }));
  return {
    engine,
    mesh,
    gizmo,
    driver,
    host,
    session,
    left,
    right,
    events,
    fire,
    s: gizmo.frame().size,
    tick: () => frame?.({}),
    listening: () => frame !== null,
  };
}

test('a controller ray lights the handle it points at', async (t) => {
  const { gizmo, right, left, events, tick, s } = await rig(t);
  right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
  tick();
  assert.equal(gizmo.axis, 'X');
  // The left ray is not tracked yet; once it points at Y while the right still points at X, the first hit keeps the light.
  left.aim([0, 2, 3], [0, 0.6 * s, 0]);
  right.aim([0, 2, 3], [0, 9, 3]);
  tick();
  assert.equal(gizmo.axis, 'Y');
  left.aim([0, 2, 3], [0, 9, 3]);
  tick();
  assert.equal(gizmo.axis, null);
  right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
  tick();
  left.lose();
  right.lose();
  tick();
  assert.equal(gizmo.axis, null, 'the light goes out when no ray is tracked');
  assert.deepEqual(events, [
    ['hover', 'right', 'X'],
    ['hover', 'left', 'Y'],
    ['hover', 'right', null],
    ['hover', 'right', 'X'],
    ['hover', 'right', null],
  ]);
});

test('selectstart grabs the handle, the ray drags it along X by the expected amount and selectend lets go', async (t) => {
  const { gizmo, mesh, right, left, events, fire, tick, driver, s } = await rig(t),
    from = [0.6 * s, 2, 3];
  right.aim(from, [0.6 * s, 0, 0]);
  tick();
  fire('selectstart', right);
  assert.equal(gizmo.dragging, true);
  assert.equal(driver.grabbing, right.controller);
  right.aim(from, [0.6 * s + 1, 0, 0]);
  tick();
  near(mesh.position.x, 1, 1e-6, 'turned to a point one unit along X');
  right.aim([from[0] + 0.5, 2, 3], [0.6 * s + 1.5, 0, 0]);
  tick();
  near(mesh.position.x, 1.5, 1e-6, 'carried half a unit further');
  assert.deepEqual([mesh.position.y, mesh.position.z], [0, 0]);
  // Another hand's release, and a squeeze, do not end the drag.
  fire('selectend', left);
  fire('squeezeend', right);
  assert.equal(gizmo.dragging, true);
  fire('selectend', right);
  assert.equal(gizmo.dragging, false);
  assert.equal(driver.grabbing, null);
  right.aim(from, [9, 0, 0]);
  tick();
  near(mesh.position.x, 1.5, 1e-6, 'no move after the release');
  assert.deepEqual(
    events.filter((e) => e[0] !== 'hover'),
    [
      ['grab', 'right', 'X'],
      ['release', 'right', 'X'],
    ],
  );
});

test('a controller ray along the dragged axis is stable', async (t) => {
  const { gizmo, mesh, right, fire, tick, s } = await rig(t),
    from = [-3, 0.5, 0];
  right.aim(from, [0.6 * s, 0, 0]);
  fire('selectstart', right);
  assert.equal(gizmo.dragging, true);
  for (const tilt of [1e-4, 1e-7, 0, -1e-7, -1e-4]) {
    right.aim(from, [from[0] + 1, from[1] + tilt, tilt]);
    tick();
    near(mesh.position.x, 0, 1e-6, `held at tilt ${tilt}`);
  }
  right.aim([-2.5, 0.5, 0], [0, 0.5, 0]);
  tick();
  near(mesh.position.x, 0.5, 1e-6, 'the hand pushes it along the axis');
  fire('selectend', right);
});

test('a ray on a ring turns the object by the expected angle', async (t) => {
  const { gizmo, mesh, left, fire, tick, s } = await rig(t, { gizmo: { mode: 'rotate' } }),
    at = (deg) => [Math.cos((deg * Math.PI) / 180) * s, 0, Math.sin((deg * Math.PI) / 180) * s];
  left.aim([1, 4, 1], at(45));
  tick();
  assert.equal(gizmo.axis, 'Y');
  fire('selectstart', left);
  left.aim([1, 4, 1], at(15));
  tick();
  near(mesh.rotation.y, Math.PI / 6, 1e-6, 'turned 30 degrees about Y');
  fire('selectend', left);
});

test('a second hand turns the grab into a two-hand scale by the ratio of the hands separation', async (t) => {
  const { gizmo, mesh, left, right, events, fire, tick, driver, s } = await rig(t, { gizmo: { scaleSnap: null } });
  right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
  left.aim([0.6 * s - 0.4, 2, 3], [0, 9, 0]);
  tick();
  fire('selectstart', right);
  fire('selectstart', left);
  assert.equal(driver.scaling, true);
  assert.equal(gizmo.dragging, true);
  // Hands 0.4 m apart at the second press, then 0.8 m: twice the size.
  left.aim([0.6 * s - 0.8, 2, 3], [0, 9, 0]);
  tick();
  for (const axis of ['x', 'y', 'z']) near(mesh.scale[axis], 2, 1e-6, axis);
  right.aim([0.6 * s - 0.6, 2, 3], [0, 0, 0]);
  tick();
  for (const axis of ['x', 'y', 'z']) near(mesh.scale[axis], 0.5, 1e-6, axis);
  assert.deepEqual([mesh.position.x, mesh.position.y, mesh.position.z], [0, 0, 0], 'the scale does not move it');
  // Either hand letting go ends it; the hand still pressing does not carry on dragging.
  fire('selectend', right);
  assert.equal(driver.scaling, false);
  assert.equal(driver.grabbing, null);
  assert.equal(gizmo.dragging, false);
  left.aim([5, 2, 3], [0, 9, 0]);
  tick();
  near(mesh.scale.x, 0.5, 1e-6);
  assert.deepEqual(
    events.filter((e) => e[0] !== 'hover'),
    [
      ['grab', 'right', 'X'],
      ['grab', 'left', 'scale'],
      ['release', 'left', 'scale'],
    ],
  );
});

test('options: squeeze button, one hand only, two-hand scale off and a least separation', async (t) => {
  {
    const { gizmo, right, left, fire, driver, s } = await rig(t, { button: 'squeeze', hands: ['right'] });
    right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
    left.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
    fire('selectstart', right);
    fire('squeezestart', left);
    assert.equal(gizmo.dragging, false, 'select and the left hand do not grab');
    fire('squeezestart', right);
    assert.equal(driver.grabbing, right.controller);
    fire('squeezeend', right);
    assert.equal(gizmo.dragging, false);
  }
  {
    const { right, left, fire, driver, s } = await rig(t, { twoHandScale: false });
    right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
    left.aim([0, 2, 3], [0, 9, 0]);
    fire('selectstart', right);
    fire('selectstart', left);
    assert.equal(driver.scaling, false);
    assert.equal(driver.grabbing, right.controller, 'the first hand keeps its drag');
  }
  {
    const { right, left, fire, driver, s } = await rig(t, { minSeparation: 0.5 });
    right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
    left.aim([0.6 * s - 0.4, 2, 3], [0, 9, 0]);
    fire('selectstart', right);
    fire('selectstart', left);
    assert.equal(driver.scaling, false, 'hands closer than minSeparation do not scale');
  }
});

test('a lost controller, an ended session, an abort and dispose all let go and stop listening', async (t) => {
  {
    const { gizmo, right, host, fire, tick, driver, s } = await rig(t);
    right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
    fire('selectstart', right);
    host.controllers.pop();
    tick();
    assert.equal(gizmo.dragging, false, 'the holder left the session');
    assert.equal(driver.grabbing, null);
  }
  {
    const { gizmo, right, session, fire, s } = await rig(t);
    right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
    fire('selectstart', right);
    session.dispatchEvent(new Event('end'));
    assert.equal(gizmo.dragging, false);
    assert.equal(getEventListeners(session, 'selectstart').length, 0);
  }
  {
    const abort = new AbortController(),
      { gizmo, right, session, fire, listening, s } = await rig(t, { signal: abort.signal });
    right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
    fire('selectstart', right);
    abort.abort();
    assert.equal(gizmo.dragging, false);
    assert.equal(listening(), false);
    for (const type of ['selectstart', 'selectend', 'end']) assert.equal(getEventListeners(session, type).length, 0);
    assert.throws(() => XRGizmo.attach({ controllers: [], onFrame: () => () => {} }, gizmo, { signal: abort.signal }));
  }
  {
    const { gizmo, right, session, tick, driver, listening, s } = await rig(t);
    right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
    tick();
    assert.equal(gizmo.axis, 'X');
    driver[Symbol.dispose]();
    driver.dispose();
    assert.equal(gizmo.axis, null, 'dispose puts the hover light out');
    assert.equal(listening(), false);
    assert.equal(getEventListeners(session, 'selectstart').length, 0);
  }
});

test('a session that starts later is picked up on its first frame', async (t) => {
  const { gizmo, right, host, tick, s } = await rig(t),
    next = new EventTarget();
  host.session = next;
  tick();
  right.aim([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
  next.dispatchEvent(Object.assign(new Event('selectstart'), { inputSource: right.source }));
  assert.equal(gizmo.dragging, true);
});

test('bad hosts, gizmos and options are refused with a RangeError that names the fix', async (t) => {
  const { gizmo, host } = await rig(t);
  for (const [xr, target, options] of [
    [{}, gizmo, {}],
    [{ controllers: [], onFrame: 1 }, gizmo, {}],
    [host, {}, {}],
    [host, { ...gizmo, rayDown: null }, {}],
    [host, gizmo, { button: 'trigger' }],
    [host, gizmo, { hands: [] }],
    [host, gizmo, { hands: ['both'] }],
    [host, gizmo, { minSeparation: 0 }],
    [host, gizmo, { minSeparation: NaN }],
  ])
    assert.throws(
      () => XRGizmo.attach(xr, target, options),
      (error) => error instanceof RangeError && /; (pass|see)/.test(error.message),
    );
});
