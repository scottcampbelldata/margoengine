import test from 'node:test';
import assert from 'node:assert/strict';
import { Locomotion, pulse, teleportArc, XRLayers } from '../dist/layers.js';

class Rigid {
  constructor(position, orientation) {
    this.position = position;
    this.orientation = orientation;
  }
}
globalThis.XRRigidTransform = Rigid;

/** A session, binding and device that record what the layers module asks of them. */
function host({ features = ['layers'] } = {}) {
  const session = new EventTarget();
  session.enabledFeatures = features;
  const copies = [],
    created = [],
    state = { below: [], above: [] };
  let listener;
  const texture = { createView: (d) => ({ d }) };
  const layer = (kind, init) => {
    const l = {
      kind,
      init,
      layout: init.layout,
      needsRedraw: false,
      space: init.space,
      destroyed: 0,
      destroy() {
        this.destroyed++;
      },
    };
    created.push(l);
    return l;
  };
  const binding = {
    getPreferredColorFormat: () => 'rgba8unorm',
    createQuadLayer: (init) => layer('quad', init),
    createCylinderLayer: (init) => layer('cylinder', init),
    createEquirectLayer: (init) => layer('equirect', init),
    createCubeLayer: (init) => layer('cube', init),
    getSubImage(l, frame, eye = 'none') {
      const stereo = l.layout === 'stereo',
        right = eye === 'right';
      return {
        colorTexture: texture,
        viewport: { x: 0, y: 0, width: l.init.viewPixelWidth, height: l.init.viewPixelHeight },
        getViewDescriptor: () => ({
          dimension: '2d',
          baseArrayLayer: stereo ? (l.kind === 'cube' ? 6 : 1) * +right : 0,
        }),
      };
    },
  };
  const device = {
    queue: { copyExternalImageToTexture: (source, dest, size) => copies.push([source.source, dest.origin, size]) },
  };
  const xr = {
    session,
    referenceSpace: { name: 'local' },
    layerBinding: { binding, device },
    onFrame(callback) {
      listener = callback;
      return () => (listener = undefined);
    },
    setLayers(below, above) {
      state.below = below;
      state.above = above;
    },
    useReferenceSpace(space) {
      this.referenceSpace = space;
    },
    step() {
      listener?.({ frame: { session } });
    },
  };
  return { xr, session, copies, created, state };
}
const image = (width, height) => ({ width, height });

test('attach needs a session with the layers feature, and says how to ask for it', () => {
  const { xr } = host({ features: ['local'] });
  assert.throws(() => XRLayers.attach(xr), /optionalFeatures: \['layers'\]/);
  assert.throws(() => XRLayers.attach({ ...xr, session: null }), /await xr.requestSession/);
});

test('a quad is created in the reference space with copyable textures, shown above the scene, and drawn from the frame after it joins', () => {
  const { xr, created, copies, state } = host(),
    layers = XRLayers.attach(xr),
    canvas = image(512, 256);
  const panel = layers.quad({
    pixels: [512, 256],
    size: [1, 0.5],
    position: [0, 1.6, -1],
    content: canvas,
    opacity: 2,
  });
  const { init } = created[0];
  assert.equal(init.space, xr.referenceSpace);
  assert.equal(init.textureUsage, 0x12);
  assert.equal(init.colorFormat, 'rgba8unorm');
  assert.deepEqual(
    [init.width, init.height, init.viewPixelWidth, init.viewPixelHeight, init.layout],
    [1, 0.5, 512, 256, 'mono'],
  );
  assert.deepEqual(init.transform.position, { x: 0, y: 1.6, z: -1, w: 1 });
  assert.equal(panel.layer.opacity, 1, 'opacity is clamped to 1');
  assert.deepEqual(state, { below: [], above: [panel.layer] });
  xr.step();
  assert.equal(copies.length, 0, 'the layer is not in the render state until the next frame');
  xr.step();
  xr.step();
  assert.deepEqual(copies, [
    [canvas, [0, 0, 0], [512, 256]],
    [canvas, [0, 0, 0], [512, 256]],
  ]);
});

test('a stereo layer draws each eye into its own array layer, and a cube draws six faces per eye', () => {
  const { xr, copies } = host(),
    layers = XRLayers.attach(xr),
    left = image(64, 64),
    right = image(64, 64),
    faces = [0, 1, 2, 3, 4, 5].map(() => image(32, 32));
  layers.quad({ pixels: [64, 64], layout: 'stereo', content: { left, right } });
  layers.cube({ pixels: [32, 32], layout: 'stereo', content: faces });
  xr.step();
  xr.step();
  assert.deepEqual(
    copies.map(([s, origin]) => [s === left ? 'L' : s === right ? 'R' : faces.indexOf(s), origin[2]]),
    [
      ['L', 0],
      ['R', 1],
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [0, 6],
      [1, 7],
      [2, 8],
      [3, 9],
      [4, 10],
      [5, 11],
    ],
  );
});

test('equirect and cube layers sit below the scene, a static layer draws only when asked, and dispose removes and destroys', () => {
  const { xr, copies, state, created } = host(),
    layers = XRLayers.attach(xr),
    sky = layers.equirect({ pixels: [128, 64], content: image(128, 64), isStatic: true });
  assert.deepEqual(state.below, [sky.layer]);
  for (let i = 0; i < 4; i++) xr.step();
  assert.equal(copies.length, 1, 'drawn once');
  sky.layer.needsRedraw = true;
  xr.step();
  assert.equal(copies.length, 2, 'drawn again when the compositor asks');
  sky.layer.needsRedraw = false;
  sky.redraw();
  xr.step();
  xr.step();
  assert.equal(copies.length, 3, 'and when the app asks');
  layers.dispose();
  assert.deepEqual(state, { below: [], above: [] });
  assert.equal(created[0].destroyed, 1);
});

test('a layer placed in the reference space follows a teleport; one in its own space stays', () => {
  const { xr, created } = host(),
    layers = XRLayers.attach(xr),
    own = { name: 'viewer' };
  layers.quad({ pixels: [8, 8], content: image(8, 8) });
  layers.quad({ pixels: [8, 8], content: image(8, 8), space: own });
  const moved = { name: 'offset' };
  xr.useReferenceSpace(moved);
  xr.step();
  assert.equal(created[0].space, moved);
  assert.equal(created[1].space, own);
});

test('a drawing function gets each target view, and a video layer goes through XRMediaBinding with its own init', () => {
  const { xr, session } = host(),
    layers = XRLayers.attach(xr),
    targets = [];
  layers.cylinder({ pixels: [16, 8], content: (t) => targets.push([t.eye, t.face, t.view.d.baseArrayLayer]) });
  xr.step();
  xr.step();
  assert.deepEqual(targets, [['none', 0, 0]]);
  const made = [];
  globalThis.XRMediaBinding = class {
    constructor(s) {
      assert.equal(s, session);
    }
    createQuadLayer(video, init) {
      made.push(init);
      return { destroy() {} };
    }
  };
  layers.video({ videoWidth: 1920, videoHeight: 1080 }, { width: 2, layout: 'stereo-left-right' });
  delete globalThis.XRMediaBinding;
  assert.equal(made[0].width, 2);
  assert.equal(made[0].layout, 'stereo-left-right');
  assert.equal(made[0].space, xr.referenceSpace);
  assert.throws(() => layers.video({}), /optionalFeatures: \['layers'\]/);
});

test('bad layer sizes throw with the fix', () => {
  const layers = XRLayers.attach(host().xr);
  assert.throws(() => layers.quad({ pixels: [0, 8], content: image(1, 1) }), /pass pixels: \[width, height\]/);
  assert.throws(() => layers.cube({ pixels: [8, 4], content: [] }), /pass pixels: \[size, size\]/);
  assert.throws(() => layers.cube({ pixels: [8, 8], content: [] }), /six images/);
});

test('pulse uses hapticActuators, falls back to the dual-rumble vibration actuator, and reports no actuator', async () => {
  const pulses = [];
  const quest = { source: { gamepad: { hapticActuators: [{ pulse: async (v, d) => (pulses.push([v, d]), true) }] } } };
  assert.equal(await pulse(quest, 2, 40), true);
  assert.deepEqual(pulses, [[1, 40]]);
  const effects = [];
  const pad = {
    gamepad: {
      vibrationActuator: {
        effects: ['dual-rumble'],
        playEffect: async (type, params) => (effects.push([type, params]), 'complete'),
      },
    },
  };
  assert.equal(await pulse(pad, 0.25), true);
  assert.deepEqual(effects, [['dual-rumble', { duration: 50, strongMagnitude: 0.25, weakMagnitude: 0.25 }]]);
  assert.equal(await pulse({ gamepad: null }), false);
  await assert.rejects(pulse(quest, NaN), /pass pulse\(controller, 0.5, 50\)/);
});

test('teleportArc follows the parabola and lands where it crosses the ground', () => {
  // At 45 degrees from 1 m up, 5 m/s along each axis, gravity 10: t = x / 5, so y(x) = 1 + x - 0.2 x^2, which meets y = 0
  // at x = (1 + sqrt(1 + 0.8)) / 0.4.
  const arc = teleportArc([0, 1, 0], [1, 1, 0], { speed: 5 * Math.SQRT2, gravity: 10, step: 0.001 });
  const x = (1 + Math.sqrt(1.8)) / 0.4;
  assert.ok(Math.abs(arc.hit[0] - x) < 1e-3, `${arc.hit[0]} vs ${x}`);
  assert.equal(arc.hit[1], 0);
  for (let i = 0; i < arc.count - 1; i++) {
    const px = arc.points[i * 3];
    assert.ok(Math.abs(arc.points[i * 3 + 1] - (1 + px - 0.2 * px * px)) < 1e-4);
  }
  // A ground function: a step 2 m high from x = 1 catches the arc earlier.
  const raised = teleportArc([0, 1, 0], [1, 1, 0], {
    speed: 5 * Math.SQRT2,
    gravity: 10,
    step: 0.001,
    ground: (gx) => (gx > 1 ? 1.5 : 0),
  });
  assert.equal(raised.hit[1], 1.5);
  assert.ok(raised.hit[0] > 1 && raised.hit[0] < x);
  // Out of time before landing: no hit, and the buffer is reused.
  const short = teleportArc([0, 1, 0], [0, 1, 0], { maxTime: 0.1 }, raised);
  assert.equal(short.hit, null);
  assert.equal(short, raised);
  assert.throws(() => teleportArc([0, 0, 0], [0, 0, -1], { step: 0 }), /pass numbers/);
});

test('a teleport offsets the space so the feet land on the target turned by yaw, and a turn keeps the feet in place', () => {
  const { xr } = host();
  const spaces = [];
  const space = (offsets) => ({
    offsets,
    getOffsetReferenceSpace(t) {
      const next = space([...offsets, t]);
      spaces.push(next);
      return next;
    },
  });
  xr.referenceSpace = space([]);
  let listener;
  xr.onFrame = (callback) => ((listener = callback), () => {});
  const move = Locomotion.attach(xr);
  listener({ viewer: { transform: { position: { x: 1, y: 1.7, z: 2 } } } });
  const yaw = 0.3;
  move.teleport([5, 0.5, -3], yaw);
  const t = xr.referenceSpace.offsets[0];
  // Poses in the new space are t^-1 * old: R(yaw) (p - t.position) for t = T(position) R(-yaw).
  const inverse = ([x, y, z]) => {
    const dx = x - t.position.x,
      dy = y - t.position.y,
      dz = z - t.position.z,
      c = Math.cos(yaw),
      s = Math.sin(yaw);
    return [c * dx + s * dz, dy, -s * dx + c * dz];
  };
  const feet = inverse([1, 0, 2]);
  assert.ok(
    [5, 0.5, -3].every((v, i) => Math.abs(feet[i] - v) < 1e-12),
    feet.join(),
  );
  assert.ok(
    Math.abs(t.orientation.y - Math.sin(-yaw / 2)) < 1e-12 && Math.abs(t.orientation.w - Math.cos(yaw / 2)) < 1e-12,
  );
  // Facing -Z before, the player faces left (towards -X) after a positive yaw.
  const ahead = inverse([1, 0, 1]).map((v, i) => v - feet[i]);
  assert.ok(ahead[0] < 0 && ahead[2] < 0, ahead.join());
  // Before the next frame the feet are at the target in the new space: a turn keeps them there.
  move.turn(Math.PI / 2);
  const u = xr.referenceSpace.offsets.at(-1),
    c = Math.cos(Math.PI / 2),
    s = Math.sin(Math.PI / 2),
    dx = 5 - u.position.x,
    dy = 0.5 - u.position.y,
    dz = -3 - u.position.z;
  assert.ok(
    Math.abs(c * dx + s * dz - 5) < 1e-12 && Math.abs(dy - 0.5) < 1e-12 && Math.abs(-s * dx + c * dz + 3) < 1e-12,
    'the feet stay where they stand',
  );
  // The floor is now at 0.5 in this space: the next frame's feet stand there, and a teleport to the same height
  // moves nobody up or down.
  listener({ viewer: { transform: { position: { x: 2, y: 2.2, z: 1 } } } });
  move.teleport([3, 0.5, 1]);
  assert.ok(Math.abs(xr.referenceSpace.offsets.at(-1).position.y) < 1e-12, 'no climb on level ground');
  assert.throws(() => move.teleport([NaN, 0, 0]), /pass a floor point/);
});
