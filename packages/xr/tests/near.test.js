import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from '@margoengine/math/quaternion';
import { Vector3 } from '@margoengine/math/vector3';
import {
  AppBar,
  FollowInView,
  HandConstraint,
  Manipulator,
  NearMenu,
  Slate,
  SurfaceMagnetism,
  nearTarget,
  snapToSurface,
  surfaceFromHit,
} from '../dist/near.js';

const THUMB = 4,
  INDEX = 9;
/** Column-major rigid matrix from a position and unit quaternion [x, y, z, w]. */
function matrix(p, [x, y, z, w] = [0, 0, 0, 1]) {
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    p[0],
    p[1],
    p[2],
    1,
  ];
}
const pose = (p, q = [0, 0, 0, 1]) => ({
  transform: {
    position: { x: p[0], y: p[1], z: p[2], w: 1 },
    orientation: { x: q[0], y: q[1], z: q[2], w: q[3] },
  },
});
const about = (axis, degrees) => {
  const h = (degrees * Math.PI) / 360,
    s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
};
function controller(handedness = 'right') {
  const c = {
    source: { handedness, gamepad: { mapping: 'xr-standard' } },
    targetRay: null,
    grip: null,
    buttons: new Float32Array(96),
    buttonCount: 4,
    handMatrices: new Float32Array(25 * 16),
    handTracked: new Uint8Array(25),
    joint(j, p, q) {
      c.handMatrices.set(matrix(p, q), j * 16);
      c.handTracked[j] = 1;
    },
    place(p, q) {
      c.targetRay = c.grip = pose(p, q);
    },
    /** A hand pinching (tips 1 cm apart) or open (10 cm) at p. */
    pinch(p, on = true, q = [0, 0, 0, 1]) {
      c.joint(THUMB, [p[0] - 0.005, p[1], p[2]]);
      c.joint(INDEX, [p[0] + 0.005, p[1], p[2]]);
      if (!on) c.joint(THUMB, [p[0] - 0.05, p[1], p[2]]), c.joint(INDEX, [p[0] + 0.05, p[1], p[2]]);
      c.grip = pose(p, q);
      c.targetRay = pose(p, q);
    },
    squeeze(v) {
      c.buttons[4] = v;
    },
  };
  c.source.handedness = handedness;
  return c;
}
function host(controllers) {
  let listener;
  return {
    controllers,
    onFrame(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    get listening() {
      return listener !== undefined;
    },
    step(delta = 1, viewer = null) {
      listener?.({ delta, viewer: viewer && { transform: viewer } });
    },
  };
}
// Several behaviours can share one session: fan out the single callback.
function session(controllers) {
  const listeners = new Set();
  return {
    controllers,
    onFrame(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    get listeners() {
      return listeners.size;
    },
    step(delta = 1, viewer = null) {
      for (const l of [...listeners]) l({ delta, viewer: viewer && { transform: viewer } });
    },
  };
}
const target = (p = [0, 0, 0]) => ({
  position: new Vector3(...p),
  orientation: new Quaternion(),
  scale: new Vector3(1, 1, 1),
  applied: 0,
  apply() {
    this.applied++;
  },
});
const eye = (p = [0, 1.6, 0], q = [0, 0, 0, 1]) => pose(p, q).transform;
const near = (a, b, eps = 1e-5) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const arr = (v) => [v.x, v.y, v.z];
const rotate = (q, v) => arr(new Vector3(...v).applyQuaternion(new Quaternion(...q)));

test('HandConstraint shows the target on a palm that faces the viewer, with hysteresis, and lays it on the palm', () => {
  const c = controller('left'),
    xr = host([c]),
    t = target(),
    events = [];
  const hand = HandConstraint.attach(xr, {
    target: t,
    onShow: () => events.push('show'),
    onHide: () => events.push('hide'),
  });
  assert.equal(t.visible, false);
  // Identity wrist: the palm faces -Y (down), away from a viewer above it.
  c.joint(0, [0, 1, -0.4]);
  xr.step(1, eye());
  assert.equal(hand.visible, false);
  // Turned over about Z, the palm faces up at the viewer.
  const flip = about([0, 0, 1], 180);
  c.joint(0, [0, 1, -0.4], flip);
  xr.step(1, eye());
  assert.equal(hand.visible, true);
  assert.equal(t.visible, true);
  assert.equal(hand.controller, c);
  assert.ok(near(arr(t.position), [0, 1.1, -0.4], 1e-5), 'the default offset floats 10 cm off the palm');
  assert.ok(near(rotate(arr(t.orientation).concat(t.orientation.w), [0, 0, 1]), [0, 1, 0], 1e-5), '+Z leaves the palm');
  assert.ok(
    near(rotate(arr(t.orientation).concat(t.orientation.w), [0, 1, 0]), [0, 0, -1], 1e-5),
    '+Y points at the fingers',
  );
  // Hysteresis: 50 degrees keeps it shown (hide at 60) but a fresh hand would not show at 50.
  c.joint(0, [0, 1, -0.4], about([0, 0, 1], 180 + 50));
  xr.step(1, eye([0, 1.6, -0.4]));
  assert.equal(hand.visible, true);
  c.joint(0, [0, 1, -0.4], about([0, 0, 1], 180 + 70));
  xr.step(1, eye([0, 1.6, -0.4]));
  assert.equal(hand.visible, false);
  assert.deepEqual(events, ['show', 'hide']);
  // 'any' ignores the viewer.
  const anyHand = HandConstraint.attach(host([c]), {
    target: target(),
    facing: 'any',
    hand: 'right',
  });
  assert.equal(anyHand.visible, false, 'a left hand is not a right hand');
});

test('HandConstraint rejects bad options and stops on dispose', () => {
  const xr = host([]);
  assert.throws(() => HandConstraint.attach(xr, { target: target(), joint: 25 }), RangeError);
  assert.throws(
    () =>
      HandConstraint.attach(xr, {
        target: target(),
        showAngle: 50,
        hideAngle: 40,
      }),
    RangeError,
  );
  const t = target(),
    hand = HandConstraint.attach(xr, { target: t });
  assert.equal(xr.listening, true);
  hand[Symbol.dispose]();
  hand.dispose();
  assert.equal(xr.listening, false);
});

test('FollowInView leaves a target inside the view cone alone, eases one outside to the cone edge, and clamps distance', () => {
  const xr = host([]),
    t = target([0, 1.6, -0.7]);
  const follow = FollowInView.attach(xr, {
    target: t,
    snapOnStart: false,
    billboard: 'none',
  });
  xr.step(1, eye());
  assert.ok(near(arr(t.position), [0, 1.6, -0.7]), 'inside the cone it stays put');
  // 80 degrees to the right of the gaze, 0.7 m away: it comes to 25 degrees, same distance.
  t.position.set(0.7 * Math.sin(1.4), 1.6, -0.7 * Math.cos(1.4));
  xr.step(10, eye());
  const d = new Vector3(t.position.x, 0, t.position.z);
  assert.ok(Math.abs(Math.atan2(d.x, -d.z) - (25 * Math.PI) / 180) < 1e-3);
  assert.ok(Math.abs(d.length() - 0.7) < 1e-3);
  // Too far: pulled to maxDistance along the gaze.
  t.position.set(0, 1.6, -3);
  xr.step(10, eye());
  assert.ok(near(arr(t.position), [0, 1.6, -1.2], 1e-3));
  // Frame-rate independent smoothing: a small step moves only part of the way.
  t.position.set(0, 1.6, -3);
  xr.step(0.05, eye());
  assert.ok(t.position.z < -1.2 && t.position.z > -3);
  // Pinned: no movement. snap(): straight in front at `distance`.
  follow.enabled = false;
  const pinned = t.position.clone();
  xr.step(10, eye());
  assert.ok(t.position.equals(pinned));
  follow.enabled = true;
  follow.snap();
  xr.step(1, eye([1, 1.6, 0], about([0, 1, 0], 90)));
  assert.ok(near(arr(t.position), [0.3, 1.6, 0], 1e-5), 'turned 90 degrees left (toward -X), 0.7 m in front of x = 1');
});

test('FollowInView billboards about the vertical axis by default and rejects bad limits', () => {
  const xr = host([]),
    t = target([2, 1.6, -2]);
  FollowInView.attach(xr, { target: t, snapOnStart: false });
  xr.step(10, eye());
  // Facing the viewer: +Z points from the target toward the head, horizontally.
  const z = rotate([t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w], [0, 0, 1]);
  assert.ok(Math.abs(z[1]) < 1e-6 && z[0] < 0 && z[2] > 0);
  assert.throws(() => FollowInView.attach(xr, { target: t, minDistance: 2, maxDistance: 1 }), RangeError);
  assert.throws(() => FollowInView.attach(xr, { target: t, maxViewDegrees: 0 }), RangeError);
});

test('SurfaceMagnetism puts a target where the ray meets a surface, aligned to it, and ignores back faces and far hits', () => {
  const c = controller(),
    xr = host([c]),
    t = target(),
    floor = { point: [0, 0, 0], normal: [0, 1, 0] },
    wall = { point: [0, 0, -5], normal: [0, 0, 1] };
  // Looking 45 degrees down from 1 m up: the floor is hit 1 m ahead.
  c.place([0, 1, 0], about([1, 0, 0], -45));
  const magnet = SurfaceMagnetism.attach(xr, {
    target: t,
    surfaces: () => [floor, wall],
    source: 0,
  });
  xr.step(1, eye());
  assert.equal(magnet.surface, floor);
  assert.ok(near(arr(t.position), [0, 0.005, -1], 1e-5));
  assert.ok(t.orientation.equals(new Quaternion(), 1e-6), 'a floor normal is +Y: no turn for normalAxis y');
  // The wall alone is 5 m off, beyond maxDistance 3: nothing changes.
  magnet.surface = null;
  c.place([0, 1, 0], about([1, 0, 0], 0));
  const before = t.position.clone();
  xr.step(1, eye());
  assert.equal(magnet.surface, null);
  assert.ok(t.position.equals(before));
  // A back-facing surface is not hit (the ray travels along its normal).
  const back = SurfaceMagnetism.attach(xr, {
    target: target(),
    surfaces: [{ point: [0, 0, -1], normal: [0, 0, -1] }],
    source: c,
  });
  xr.step(1, eye());
  assert.equal(back.surface, null);
  magnet.enabled = false;
  magnet.dispose();
});

test('SurfaceMagnetism hangs a panel on a wall with normalAxis z, upright keeps it vertical, and surfaceFromHit reads a hit pose', () => {
  const xr = session([]),
    wall = { point: [0, 0, -2], normal: [1, 0, 0] },
    t = target(),
    u = target();
  SurfaceMagnetism.attach(xr, {
    target: t,
    surfaces: [{ point: [3, 0, 0], normal: [-1, 0, 0] }],
    normalAxis: 'z',
    maxDistance: 10,
  });
  // A wall facing +X is seen edge-on by a gaze along +X (back face): no hit, so u stays where it is.
  SurfaceMagnetism.attach(xr, {
    target: u,
    surfaces: [wall],
    normalAxis: 'z',
    alignment: 'upright',
    maxDistance: 10,
  });
  xr.step(1, eye([0, 1.6, 0], about([0, 1, 0], -90)));
  // Turned a quarter turn the gaze travels along +X and meets the wall at x = 3 facing -X, 3 m ahead.
  assert.ok(near(arr(t.position), [3 - 0.005, 1.6, 0], 1e-5));
  const z = rotate([t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w], [0, 0, 1]);
  assert.ok(near(z, [-1, 0, 0], 1e-5), 'the panel faces out of the wall');
  assert.ok(near(arr(u.position), [0, 0, 0], 1e-9), 'the back face is not hit');
  const hit = {
    matrix: Float32Array.from(matrix([1, 2, 3], about([0, 0, 1], 90))),
  };
  const s = surfaceFromHit(hit);
  assert.ok(near(s.point, [1, 2, 3]));
  assert.ok(near(s.normal, [-1, 0, 0], 1e-6), 'the hit pose +Y is the normal');
});

test('snapToSurface snaps within the distance to the near side and leaves distant targets alone', () => {
  const floor = { point: [0, 0, 0], normal: [0, 1, 0] },
    t = target([0.5, 0.06, 0.2]);
  const hit = snapToSurface({
    target: t,
    surfaces: [floor],
    snapDistance: 0.1,
  });
  assert.equal(hit, floor);
  assert.ok(near(arr(t.position), [0.5, 0.005, 0.2], 1e-6));
  assert.equal(t.applied, 1);
  const far = target([0, 0.5, 0]);
  assert.equal(snapToSurface({ target: far, surfaces: [floor], snapDistance: 0.1 }), null);
  assert.equal(far.position.y, 0.5);
  // From below the plane it stays below: the near side wins.
  const under = target([0, -0.04, 0]);
  snapToSurface({
    target: under,
    surfaces: [floor],
    snapDistance: 0.1,
    offset: 0.01,
  });
  assert.ok(Math.abs(under.position.y - -0.01) < 1e-6);
});

const draggable = (p, radius = 0.1) => ({
  ...target(p),
  radius,
  events: [],
  onDragStart(e) {
    this.events.push(['start', e.ray, e.pointers]);
  },
  onDragEnd(e) {
    this.events.push(['end', e.ray, e.pointers]);
  },
});

test('Manipulator: a pinch near an object drags it six-DoF, the object turns with the wrist and keeps its offset', () => {
  const c = controller(),
    xr = host([c]),
    box = draggable([0.05, 1, -0.5]);
  const m = Manipulator.attach(xr, { draggables: [box] });
  c.pinch([0, 1, -0.5], false);
  xr.step();
  assert.equal(box.events.length, 0);
  c.pinch([0, 1, -0.5]);
  xr.step();
  assert.deepEqual(box.events, [['start', false, 1]]);
  assert.deepEqual(m.active, [box]);
  c.pinch([0.3, 1.2, -0.5]);
  xr.step();
  assert.ok(near(arr(box.position), [0.35, 1.2, -0.5], 1e-5));
  // A quarter turn about +Y turns the 5 cm +X offset to 5 cm along -Z, and the object with it.
  c.pinch([0.3, 1.2, -0.5], true, about([0, 1, 0], 90));
  xr.step();
  assert.ok(near(arr(box.position), [0.3, 1.2, -0.55], 1e-5));
  assert.ok(
    near(
      rotate([box.orientation.x, box.orientation.y, box.orientation.z, box.orientation.w], [1, 0, 0]),
      [0, 0, -1],
      1e-5,
    ),
  );
  c.pinch([0.3, 1.2, -0.5], false, about([0, 1, 0], 90));
  xr.step();
  assert.deepEqual(box.events.at(-1), ['end', false, 1]);
  assert.deepEqual(m.active, []);
});

test('Manipulator: rotate and axis-lock options constrain the drag', () => {
  const c = controller(),
    xr = host([c]),
    box = draggable([0, 1, -0.5]);
  Manipulator.attach(xr, {
    draggables: [box],
    rotate: 'none',
    lock: { y: true },
  });
  c.pinch([0, 1, -0.5]);
  xr.step();
  c.pinch([0.2, 1.5, -0.3], true, about([0, 1, 0], 90));
  xr.step();
  assert.ok(near(arr(box.position), [0.2, 1, -0.3], 1e-6), 'y stays at 1');
  assert.ok(box.orientation.equals(new Quaternion(), 1e-9), 'rotate none');
  // yaw keeps only the turn about the vertical axis.
  const c2 = controller(),
    xr2 = host([c2]),
    b2 = draggable([0, 1, -0.5]);
  Manipulator.attach(xr2, { draggables: [b2], rotate: 'yaw' });
  c2.pinch([0, 1, -0.5]);
  xr2.step();
  c2.pinch([0, 1, -0.5], true, about([1, 0, 0], 40));
  xr2.step();
  assert.ok(b2.orientation.equals(new Quaternion(), 1e-6), 'a pitch alone is dropped');
  c2.pinch([0, 1, -0.5], true, about([0, 1, 0], 60));
  xr2.step();
  assert.ok(Math.abs(b2.orientation.y - Math.sin(Math.PI / 6)) < 1e-6);
  // translate off keeps the position.
  const c3 = controller(),
    xr3 = host([c3]),
    b3 = draggable([0, 1, -0.5]);
  Manipulator.attach(xr3, { draggables: [b3], translate: false });
  c3.pinch([0, 1, -0.5]);
  xr3.step();
  c3.pinch([1, 1, -0.5]);
  xr3.step();
  assert.ok(near(arr(b3.position), [0, 1, -0.5]));
});

test('Manipulator: a squeeze on the controller ray picks a distant object; a disabled one is skipped', () => {
  const c = controller(),
    xr = host([c]),
    far = draggable([0, 1, -2]),
    off = { ...draggable([0, 1, -1]), enabled: false };
  Manipulator.attach(xr, { draggables: [off, far] });
  c.place([0, 1, 0]);
  c.squeeze(1);
  c.buttons[1 * 3 + 1] = 1;
  xr.step();
  assert.deepEqual(far.events, [['start', true, 1]]);
  assert.equal(off.events.length, 0);
  c.place([0, 1, 0.5]);
  xr.step();
  assert.ok(near(arr(far.position), [0, 1, -1.5], 1e-6), 'the object keeps its offset in the pointer frame');
  const noRay = Manipulator.attach(host([controller()]), { ray: false });
  noRay.dispose();
});

test('Manipulator: two pointers on one object scale it, turn it by the line between them, and the scale is clamped', () => {
  const a = controller('left'),
    b = controller('right'),
    xr = host([a, b]),
    box = draggable([0, 1, -0.5], 0.2),
    m = Manipulator.attach(xr, { draggables: [box], scaleLimits: [0.5, 3] });
  a.pinch([-0.1, 1, -0.5]);
  xr.step();
  b.pinch([0.1, 1, -0.5]);
  xr.step();
  assert.deepEqual(box.events, [
    ['start', false, 1],
    ['start', false, 2],
  ]);
  assert.deepEqual(m.active, [box]);
  // Pull the hands apart 2x about the midpoint.
  a.pinch([-0.2, 1, -0.5]);
  b.pinch([0.2, 1, -0.5]);
  xr.step();
  assert.ok(near(arr(box.scale), [2, 2, 2], 1e-6));
  assert.ok(near(arr(box.position), [0, 1, -0.5], 1e-6));
  // Beyond the limit it clamps at 3.
  a.pinch([-1, 1, -0.5]);
  b.pinch([1, 1, -0.5]);
  xr.step();
  assert.ok(near(arr(box.scale), [3, 3, 3], 1e-6));
  // Back to the starting gesture, then turn the line a quarter turn about Y: +X onto -Z.
  a.pinch([-0.1, 1, -0.5]);
  b.pinch([0.1, 1, -0.5]);
  xr.step();
  assert.ok(near(arr(box.scale), [1, 1, 1], 1e-6));
  a.pinch([0, 1, -0.4]);
  b.pinch([0, 1, -0.6]);
  xr.step();
  assert.ok(
    near(
      rotate([box.orientation.x, box.orientation.y, box.orientation.z, box.orientation.w], [1, 0, 0]),
      [0, 0, -1],
      1e-5,
    ),
  );
  // Lifting one hand returns to a one-point drag without a jump.
  const held = box.position.clone(),
    scaled = box.scale.clone();
  b.pinch([0, 1, -0.6], false);
  xr.step();
  assert.ok(box.position.equals(held) && box.scale.equals(scaled));
  a.pinch([0.1, 1, -0.4]);
  xr.step();
  assert.ok(near(arr(box.position), [held.x + 0.1, held.y, held.z], 1e-6));
  a.pinch([0.1, 1, -0.4], false);
  xr.step();
  assert.deepEqual(box.events.at(-1), ['end', false, 1]);
});

test('Manipulator without scale ignores a second pointer on the same object and disposes holds', () => {
  const a = controller('left'),
    b = controller('right'),
    xr = host([a, b]),
    box = draggable([0, 1, -0.5], 0.2),
    m = Manipulator.attach(xr, { draggables: [box], scale: false });
  a.pinch([-0.1, 1, -0.5]);
  xr.step();
  b.pinch([0.1, 1, -0.5]);
  xr.step();
  assert.equal(box.events.length, 1);
  m.dispose();
  assert.equal(box.events.at(-1)[0], 'end');
  assert.equal(xr.listening, false);
  assert.throws(() => Manipulator.attach(xr, { scaleLimits: [2, 1] }), RangeError);
});

test('AppBar shows under its object when a hand is near and presses by ray event or fingertip poke', () => {
  const c = controller(),
    xr = session([c]),
    t = target([0, 1, -0.5]),
    picked = [];
  const bar = AppBar.attach(xr, {
    target: t,
    onSelect: (id) => picked.push(id),
  });
  c.place([2, 1, -0.5]);
  xr.step(1, eye());
  assert.equal(bar.visible, false);
  assert.equal(bar.enabled, false);
  c.place([0.3, 1, -0.5]);
  xr.step(1, eye([0, 1, 0.5]));
  assert.equal(bar.visible, true);
  assert.equal(bar.enabled, true);
  assert.ok(Math.abs(bar.position.y - (1 - 0.15 - 0.03 - bar.size[1] / 2)) < 1e-6);
  const rects = bar.layout();
  assert.deepEqual(
    rects.map((r) => r.id),
    ['remove', 'adjust'],
  );
  assert.ok(rects[0].x < rects[1].x);
  // A ray click on the second button (u from the left edge, v mid-height).
  const u = (rects[1].x + bar.size[0] / 2) / bar.size[0];
  const e = (type) => ({ type, u, v: 0.5, distance: 1, controller: c });
  bar.onPointer(e('enter'));
  assert.equal(bar.hovered, 1);
  bar.onPointer(e('down'));
  assert.equal(bar.pressed, 1);
  bar.onPointer(e('up'));
  assert.deepEqual(picked, ['adjust']);
  bar.onPointer({ ...e('leave') });
  assert.equal(bar.hovered, -1);
  // Poke: the bar faces +Z toward a viewer at z = 0.5; the index tip goes from 5 cm out to 5 mm and back out.
  const poke = (z) => {
    c.joint(INDEX, [bar.position.x + rects[0].x, bar.position.y + rects[0].y, bar.position.z + z]);
    xr.step(1, eye([0, 1, 0.5]));
  };
  poke(0.05);
  assert.equal(bar.hovered, 0);
  poke(0.005);
  assert.equal(bar.pressed, 0);
  poke(0.05);
  assert.deepEqual(picked, ['adjust', 'remove']);
  bar.dispose();
  assert.equal(xr.listeners, 0);
});

test('NearMenu lays buttons in a grid, follows the viewer until pinned, and the pin button toggles it', () => {
  const c = controller(),
    xr = session([c]),
    picked = [];
  const menu = NearMenu.attach(xr, {
    buttons: ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      label: id.toUpperCase(),
    })),
    columns: 2,
    onSelect: (id) => picked.push(id),
  });
  assert.deepEqual(
    menu.buttons.map((b) => b.id),
    ['a', 'b', 'c', 'd', 'pin'],
  );
  const rects = menu.layout();
  assert.ok(rects[1].x > rects[0].x && rects[2].y < rects[0].y && rects[2].x === rects[0].x);
  assert.ok(menu.size[0] > 0.1 && menu.size[1] > 0.1);
  // The first frame places it 0.7 m in front of the viewer.
  xr.step(1, eye([0, 1.6, 0]));
  assert.ok(near(arr(menu.position), [0, 1.6, -0.7], 1e-5));
  // Walk away: it follows.
  xr.step(10, eye([0, 1.6, 4]));
  assert.ok(menu.position.z > 2);
  // Press the pin button with a ray (the last button, third row of a 2-column grid, left cell).
  const pin = menu.layout().find((r) => r.id === 'pin'),
    ev = (type) => ({
      type,
      u: (pin.x + menu.size[0] / 2) / menu.size[0],
      v: 0.5 - pin.y / menu.size[1],
      distance: 1,
      controller: c,
    });
  menu.onPointer(ev('enter'));
  menu.onPointer(ev('down'));
  menu.onPointer(ev('up'));
  assert.equal(menu.pinned, true);
  assert.equal(menu.buttons.at(-1).label, 'Unpin');
  assert.deepEqual(picked, [], 'pin is the menu own button');
  const z = menu.position.z;
  xr.step(10, eye([0, 1.6, 9]));
  assert.equal(menu.position.z, z, 'pinned menus stay');
  menu.pinned = false;
  menu.recenter();
  xr.step(1, eye([0, 1.6, 9]));
  assert.ok(near(arr(menu.position), [0, 1.6, 8.3], 1e-5));
  menu.setButtons([{ id: 'only', label: 'Only' }]);
  assert.deepEqual(
    menu.buttons.map((b) => b.id),
    ['only', 'pin'],
  );
  // A disabled button never presses.
  menu.setButtons([{ id: 'off', label: 'Off', enabled: false }]);
  const r = menu.layout()[0],
    off = (type) => ({
      type,
      u: (r.x + menu.size[0] / 2) / menu.size[0],
      v: 0.5 - r.y / menu.size[1],
      distance: 1,
      controller: c,
    });
  menu.onPointer(off('enter'));
  menu.onPointer(off('down'));
  menu.onPointer(off('up'));
  assert.deepEqual(picked, []);
  menu.dispose();
  assert.equal(xr.listeners, 0);
});

test('Slate moves by its title bar, resizes by its corner within limits, pans content, taps and closes', () => {
  const c = controller(),
    log = [];
  const slate = new Slate({
    position: [0, 1.4, -0.8],
    size: [0.4, 0.3],
    maxSize: [0.6, 0.5],
    onClose: () => log.push('close'),
    onContent: (e) => log.push([e.type, +e.x.toFixed(3), +e.y.toFixed(3)]),
    onMove: () => log.push('move'),
    onResize: () => log.push('resize'),
  });
  const ev = (type, u, v) => ({ type, u, v, distance: 1, controller: c });
  assert.equal(slate.regionAt(0.5, 0.05), 'title');
  assert.equal(slate.regionAt(0.99, 0.01), 'close');
  assert.equal(slate.regionAt(0.99, 0.99), 'handle');
  assert.equal(slate.regionAt(0.5, 0.5), 'content');
  assert.equal(slate.regionAt(1.2, 0.5), null);
  // Title drag: +0.1 in u is +0.04 m in x.
  slate.onPointer(ev('down', 0.5, 0.05));
  assert.equal(slate.dragging, 'title');
  slate.onPointer(ev('move', 0.6, 0.05));
  assert.ok(near(arr(slate.position), [0.04, 1.4, -0.8], 1e-6));
  // Another controller cannot steal the drag.
  slate.onPointer({ ...ev('move', 0.9, 0.5), controller: controller() });
  assert.ok(near(arr(slate.position), [0.04, 1.4, -0.8], 1e-6));
  slate.onPointer(ev('up', 0.6, 0.05));
  assert.equal(slate.dragging, null);
  // Resize: grab the corner, pull the pointer to 0.5 m from the left edge, 0.4 m from the top (grab point 1 cm from each).
  slate.onPointer(ev('down', 0.975, 0.97));
  slate.onPointer(ev('move', 0.5 / 0.4, 0.4 / 0.3));
  assert.ok(slate.size[0] <= 0.6 && slate.size[1] <= 0.5);
  assert.ok(Math.abs(slate.size[0] - (0.5 + 0.4 * 0.025)) < 1e-9, 'grab offset to the right edge is kept');
  const left = slate.position.x - slate.size[0] / 2;
  assert.ok(Math.abs(left - (0.04 - 0.2)) < 1e-9, 'the top-left corner stays put');
  slate.onPointer(ev('up', 0.9, 0.9));
  // Pan content: dragging 0.1 of the width moves it 4 cm... panel is 0.51 wide now.
  const w = slate.size[0];
  slate.onPointer(ev('down', 0.5, 0.5));
  slate.onPointer(ev('move', 0.6, 0.5));
  assert.ok(Math.abs(slate.contentOffset[0] - 0.1 * w) < 1e-9);
  slate.onPointer(ev('up', 0.6, 0.5));
  assert.ok(!log.some((e) => Array.isArray(e)), 'a drag is not a tap');
  slate.zoomBy(100);
  assert.equal(slate.contentZoom, 4);
  slate.contentZoom = 1;
  slate.contentOffset[0] = slate.contentOffset[1] = 0;
  slate.onPointer(ev('down', 0.5, 0.5));
  slate.onPointer(ev('up', 0.5, 0.5));
  assert.equal(log.filter(Array.isArray).length, 1);
  assert.equal(log.find(Array.isArray)[0], 'tap');
  // Close.
  slate.onPointer(ev('down', 0.99, 0.01));
  slate.onPointer(ev('up', 0.99, 0.01));
  assert.ok(log.includes('close'));
  assert.ok(log.includes('move') && log.includes('resize'));
  assert.throws(() => new Slate({ minSize: [1, 1], maxSize: [0.5, 0.5] }), RangeError);
});

test('nearTarget writes the pose and scale to a mesh', () => {
  const calls = [];
  const mesh = {
    position: { x: 1, y: 2, z: 3 },
    setPosition: (v) => calls.push(['p', v]),
    setQuaternion: (v) => calls.push(['q', v]),
    setScale: (v) => calls.push(['s', v]),
  };
  const t = nearTarget(mesh, { radius: 0.2, scale: [2, 2, 2] });
  assert.deepEqual(calls, [
    ['p', [1, 2, 3]],
    ['q', [0, 0, 0, 1]],
    ['s', [2, 2, 2]],
  ]);
  assert.equal(t.radius, 0.2);
  t.position.set(4, 5, 6);
  t.apply();
  assert.deepEqual(calls.at(-3), ['p', [4, 5, 6]]);
});
