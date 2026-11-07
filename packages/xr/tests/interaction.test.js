import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from '@margoengine/math/quaternion';
import { Vector3 } from '@margoengine/math/vector3';
import { Interaction } from '../dist/interaction.js';

/** A controller at `position` with orientation `q`, squeeze and trigger as given; poses as WebXR gives them. */
function controller() {
  const c = {
    source: { gamepad: { mapping: 'xr-standard' } },
    targetRay: null,
    grip: null,
    buttons: new Float32Array(96),
    buttonCount: 4,
    handMatrices: new Float32Array(25 * 16),
    handTracked: new Uint8Array(25),
    place(position, q = [0, 0, 0, 1]) {
      const pose = {
        transform: {
          position: { x: position[0], y: position[1], z: position[2], w: 1 },
          orientation: { x: q[0], y: q[1], z: q[2], w: q[3] },
        },
      };
      c.targetRay = pose;
      c.grip = pose;
    },
    set(squeeze, trigger = 0) {
      c.buttons[4] = squeeze;
      c.buttons[1] = trigger;
    },
  };
  return c;
}
function host(controllers) {
  let listener;
  return {
    controllers,
    onFrame(callback) {
      listener = callback;
      return () => (listener = undefined);
    },
    step(delta = 0.01) {
      listener?.({ delta });
    },
  };
}
const object = (position, radius = 0.1) => ({
  position: new Vector3(...position),
  orientation: new Quaternion(),
  radius,
  events: [],
  onGrab(e) {
    this.events.push(['grab', e.ray]);
  },
  onRelease(e) {
    this.events.push(['release', e.velocity, e.socket]);
  },
});
const close = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

test('a squeeze near an object grabs it, the object keeps its offset in the grip frame, and turning the grip turns it', () => {
  const c = controller(),
    xr = host([c]),
    box = object([0.05, 1, -0.5]);
  const ui = Interaction.attach(xr, { grabbables: [box] });
  c.place([0, 1, -0.5]);
  c.set(1);
  xr.step();
  assert.deepEqual(box.events, [['grab', false]]);
  // Move the grip 1 m up and turn it a quarter turn about +Y: the 5 cm offset along +X becomes 5 cm along -Z.
  const quarter = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
  c.place([0, 2, -0.5], [quarter.x, quarter.y, quarter.z, quarter.w]);
  xr.step();
  assert.ok(close(box.position.toArray(), [0, 2, -0.55]), box.position.toArray().join());
  assert.ok(close(box.orientation.toArray(), quarter.toArray()));
  assert.equal(ui.rays[0].holding, box);
  ui.dispose();
});

test('a squeeze with nothing in reach grabs along the ray, and an object too far stays put', () => {
  const c = controller(),
    xr = host([c]),
    near = object([0, 1, -3], 0.2),
    far = object([0, 1, -9], 0.2);
  Interaction.attach(xr, { grabbables: [far, near], rayLength: 5 });
  c.place([0, 1, 0]);
  c.set(1);
  xr.step();
  assert.deepEqual(near.events, [['grab', true]]);
  assert.deepEqual(far.events, []);
});

test('a release over a free socket that fits snaps the object to it; a full or refusing socket does not take it', () => {
  const c = controller(),
    xr = host([c]),
    key = object([0, 1, 0]),
    turned = new Quaternion().setFromAxisAngle({ x: 1, y: 0, z: 0 }, 0.5);
  const full = {
      position: new Vector3(0, 1, 0.01),
      orientation: new Quaternion(),
      radius: 0.2,
      held: object([9, 9, 9]),
    },
    refuses = {
      position: new Vector3(0, 1, 0.02),
      orientation: new Quaternion(),
      radius: 0.2,
      held: null,
      accepts: () => false,
    },
    slot = {
      position: new Vector3(0.1, 1, 0),
      orientation: turned,
      radius: 0.2,
      held: null,
      snapped: [],
      onSnap(o) {
        this.snapped.push(o);
      },
    };
  Interaction.attach(xr, { grabbables: [key], sockets: [full, refuses, slot] });
  c.place([0, 1, 0]);
  c.set(1);
  xr.step();
  xr.step();
  assert.equal(slot.hovered, true);
  assert.equal(full.hovered, false);
  c.set(0);
  xr.step();
  assert.equal(slot.held, key);
  assert.deepEqual(slot.snapped, [key]);
  assert.ok(close(key.position.toArray(), [0.1, 1, 0]));
  assert.ok(close(key.orientation.toArray(), turned.toArray()));
  assert.equal(key.events.at(-1)[2], slot);
  // Grabbing it again empties the socket.
  let left = 0;
  slot.onLeave = () => left++;
  c.place([0.1, 1, 0]);
  c.set(1);
  xr.step();
  assert.equal(slot.held, null);
  assert.equal(left, 1);
});

test('a throw reports the release velocity from the last frames', () => {
  const c = controller(),
    xr = host([c]),
    ball = object([0, 1, 0]);
  Interaction.attach(xr, { grabbables: [ball] });
  c.set(1);
  for (let i = 0; i < 5; i++) {
    c.place([i * 0.02, 1, 0]);
    xr.step(0.01);
  }
  c.set(0);
  c.place([0.1, 1, 0]);
  xr.step(0.01);
  const [vx, vy, vz] = ball.events.at(-1)[1];
  assert.ok(Math.abs(vx - 2) < 1e-6 && Math.abs(vy) < 1e-9 && Math.abs(vz) < 1e-9, `${vx},${vy},${vz}`);
});

test('a ray on a panel sends enter, move, down and up with u and v from its top left corner, then leave', () => {
  const c = controller(),
    xr = host([c]),
    events = [];
  // A 2 x 1 m panel 3 m ahead facing the viewer (+Z).
  const panel = {
    position: new Vector3(0, 1, -3),
    orientation: new Quaternion(),
    size: [2, 1],
    onPointer: (e) => events.push([e.type, +e.u.toFixed(6), +e.v.toFixed(6), +e.distance.toFixed(6)]),
  };
  Interaction.attach(xr, { panels: [panel] });
  // Aim at the point 0.5 m right and 0.25 m up of the centre: u = 0.75, v = 0.25.
  const aim = new Quaternion().setFromUnitVectors({ x: 0, y: 0, z: -1 }, new Vector3(0.5, 0.25, -3).normalize());
  c.place([0, 1, 0], aim.toArray());
  xr.step();
  c.set(0, 1);
  xr.step();
  c.set(0, 0);
  xr.step();
  c.place([0, 1, 0], new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI).toArray());
  xr.step();
  const d = +Math.hypot(0.5, 0.25, 3).toFixed(6);
  assert.deepEqual(events, [
    ['enter', 0.75, 0.25, d],
    ['move', 0.75, 0.25, d],
    ['down', 0.75, 0.25, d],
    ['move', 0.75, 0.25, d],
    ['up', 0.75, 0.25, d],
    ['leave', 0, 0, 5],
  ]);
});

test('a ray from behind a panel does not hit it, and a hand pinch presses where the hand has no gamepad', () => {
  const c = controller(),
    xr = host([c]),
    events = [];
  const panel = {
    position: new Vector3(0, 1, -3),
    orientation: new Quaternion(),
    size: [2, 2],
    onPointer: (e) => events.push(e.type),
  };
  Interaction.attach(xr, { panels: [panel] });
  c.place([0, 1, -6], new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI).toArray());
  xr.step();
  assert.deepEqual(events, []);
  c.source = { hand: new Map() };
  c.buttonCount = 0;
  c.place([0, 1, 0]);
  c.handTracked[4] = c.handTracked[9] = 1;
  c.handMatrices[4 * 16 + 12] = 0.01;
  c.handMatrices[9 * 16 + 12] = 0.02;
  xr.step();
  assert.deepEqual(events, ['enter', 'down']);
});

test('options are checked with the fix in the message', () => {
  assert.throws(() => Interaction.attach(host([]), { rayLength: 0 }), /pass \{ rayLength: 5/);
});

test('buttons grab and press only under the xr-standard mapping', () => {
  const c = controller(),
    xr = host([c]),
    box = object([0, 1, 0]);
  c.source.gamepad.mapping = '';
  Interaction.attach(xr, { grabbables: [box] });
  c.place([0, 1, 0]);
  c.set(1, 1);
  xr.step();
  assert.deepEqual(box.events, [], 'button 1 of an unknown mapping is not a squeeze');
});
