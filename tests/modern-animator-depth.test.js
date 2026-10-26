// Animator depth (@margoengine/animator): any-state, trigger and exit-time transitions, normalized time, state-change
// and timed events (through loops and long frames), override layers on their own clock, and foot placement (feet
// follow steps and drops, the pelvis lowers, feet keep their animated orientation and tilt to the slope).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { Animator, addFootPlacement } from '../packages/animator/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

const near = (a, b, tolerance, label) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} is not within ${tolerance} of ${b}`);

/** Adds a float accessor to a fixture document. */
function adder(doc, buffers) {
  return (values, type) => {
    const data = new Float32Array(values);
    buffers.push(data);
    doc.buffers.push({ byteLength: data.byteLength });
    doc.bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    doc.accessors.push({
      bufferView: doc.bufferViews.length - 1,
      componentType: 5126,
      count: data.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type],
      type,
    });
    return doc.accessors.length - 1;
  };
}
async function host(f, options, setup) {
  const store = await TransformStore.create(32),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    model = new PBRModel(engine, new GLTFAsset(f.doc, f.buffers)),
    animation = new Animation(model);
  setup?.(animation);
  const animator = new Animator(animation, options);
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  const t = store.transforms;
  return {
    model,
    animator,
    store,
    local: (node) => [t.x[model.nodes[node].id], t.y[model.nodes[node].id], t.z[model.nodes[node].id]],
    world: (node) => {
      store.tick(false);
      const m = model.nodes[node].matrix;
      return [m[12], m[13], m[14]];
    },
    up: (node) => {
      store.tick(false);
      const m = model.nodes[node].matrix,
        l = Math.hypot(m[4], m[5], m[6]);
      return [m[4] / l, m[5] / l, m[6] / l];
    },
    frame: (delta) => animator.onPreUpdate(delta),
    release() {
      animator.dispose();
      animation.dispose();
      model.dispose();
      engine.dispose();
    },
  };
}

// Joint (node 1): Move walks +x 0.4 per second (1 s); Long lasts 2 s; Hold keeps it at (0, 1, 0).
function clips() {
  const f = animatedTriangle(),
    add = adder(f.doc, f.buffers);
  const long = add([0, 2], 'SCALAR'),
    one = add([0, 1], 'SCALAR');
  f.doc.animations.push(
    {
      name: 'Long',
      channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
      samplers: [{ input: long, output: add([0, 0, 0, 0, 0, 2], 'VEC3') }],
    },
    {
      name: 'Hold',
      channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
      samplers: [{ input: one, output: add([0, 1, 0, 0, 1, 0], 'VEC3') }],
    },
  );
  return f;
}

test('any-state, trigger and exit-time transitions, with normalized time and statechange events', async () => {
  const h = await host(clips(), {
    initial: 'idle',
    states: { idle: 'Move', jump: 'Long', land: 'Hold' },
    transitions: [
      { from: '*', to: 'jump', trigger: 'jump', duration: 0 },
      { from: 'jump', to: 'land', exitTime: 1, duration: 0 },
      { from: 'land', to: 'idle', exitTime: 0.5, when: (p) => p.ready > 0, duration: 0.1 },
    ],
  });
  const a = h.animator,
    changes = [];
  a.on('statechange', (e) => changes.push(e));
  h.frame(0.25);
  assert.equal(a.state, 'idle');
  near(a.normalizedTime, 0.25, 1e-9, 'a quarter through the 1 s clip');
  a.setTrigger('jump');
  assert.ok(a.hasTrigger('jump'));
  h.frame(0.1);
  assert.equal(a.state, 'jump', 'the trigger takes the any-state transition');
  assert.ok(!a.hasTrigger('jump'), 'and is cleared');
  a.setTrigger('jump');
  h.frame(0.1);
  assert.equal(a.state, 'jump', 'an any-state transition does not re-enter its own state');
  assert.ok(a.hasTrigger('jump'), 'so the trigger stays set');
  a.resetTrigger('jump');
  assert.ok(!a.hasTrigger('jump'));
  for (let i = 0; i < 17; i++) h.frame(0.1);
  assert.equal(a.state, 'jump');
  near(a.normalizedTime, 0.95, 1e-9, 'Long is 2 s, so 1.9 s is 0.95');
  h.frame(0.1);
  h.frame(0.1);
  assert.equal(a.state, 'land', 'exit time 1 leaves after one cycle');
  for (let i = 0; i < 10; i++) h.frame(0.1);
  assert.equal(a.state, 'land', 'past its exit time but when() is false');
  a.parameters.ready = 1;
  h.frame(0.1);
  assert.equal(a.state, 'idle', 'exit time and when together');
  assert.deepEqual(
    changes.map((e) => `${e.from}>${e.to}:${e.duration}`),
    ['idle>jump:0', 'jump>land:0', 'land>idle:0.1'],
  );
  a.transition('jump', 0.2);
  assert.deepEqual(changes.at(-1), { from: 'idle', to: 'jump', duration: 0.2 }, 'explicit transitions too');
  h.release();
});

test('timed events fire once per cycle through loops, long frames and state entry; once without looping', async () => {
  const run = async (loop, frames) => {
    const h = await host(
      clips(),
      {
        initial: 'walk',
        states: { walk: 'Move', other: 'Hold' },
        events: [
          { state: 'walk', time: 0.5, name: 'step', data: 'left' },
          { state: 'walk', time: 0, name: 'start' },
          { state: 'other', time: 0.5, name: 'never' },
        ],
      },
      (animation) => {
        animation.options.loop = loop;
      },
    );
    const fired = [];
    h.animator.on('event', (e) => fired.push(`${e.name}@${e.time}:${e.data ?? ''}`));
    for (const delta of frames) h.frame(delta);
    h.release();
    return fired;
  };
  // 2.5 s in quarter-second frames: steps at 0.5, 1.5 and 2.5 s; starts at 0 (on entry), 1 and 2 s.
  const quarters = await run(true, Array(10).fill(0.25));
  assert.equal(quarters.filter((e) => e.startsWith('step')).length, 3);
  assert.equal(quarters.filter((e) => e.startsWith('start')).length, 3);
  assert.ok(quarters.includes('step@0.5:left'), 'data travels with the event');
  assert.ok(!quarters.some((e) => e.startsWith('never')), 'other states stay quiet');
  // One long 3.2 s frame passes three steps and four starts (0, 1, 2 and 3 s).
  const long = await run(true, [3.2]);
  assert.equal(long.filter((e) => e.startsWith('step')).length, 3);
  assert.equal(long.filter((e) => e.startsWith('start')).length, 4);
  // Without looping each event fires once.
  const once = await run(false, Array(10).fill(0.25));
  assert.deepEqual(once, ['start@0:', 'step@0.5:left']);
  // Paused: nothing passes, so nothing fires again.
  const h = await host(clips(), {
    initial: 'walk',
    states: { walk: 'Move' },
    events: [{ state: 'walk', time: 0.5, name: 'step' }],
  });
  let count = 0;
  h.animator.on('event', () => count++);
  h.animator.playing = false;
  for (let i = 0; i < 5; i++) h.frame(0.25);
  assert.equal(count, 0);
  h.animator.playing = true;
  const off = h.animator.on('event', () => count++);
  off();
  h.frame(0.6);
  assert.equal(count, 1, 'an unsubscribed listener is not called');
  h.release();
});

test('override layers blend masked bones toward their clip, on the state clock or their own', async () => {
  const h = await host(clips(), { initial: 'walk', states: { walk: 'Move' } });
  const layer = { clip: 'Hold', weight: 0.5, mask: [1], blend: 'override' };
  const remove = h.animator.addLayer(layer);
  h.frame(0.5); // Move puts the joint at (0.2, 0, 0); Hold at (0, 1, 0)
  const p = h.local(1);
  near(p[0], 0.1, 1e-6, 'x halfway');
  near(p[1], 0.5, 1e-6, 'y halfway');
  layer.weight = 1;
  h.frame(0);
  near(h.local(1)[0], 0, 1e-6, 'full weight replaces the pose');
  remove();
  // An override of Move on its own clock: frozen at 0.75 s while the state plays Hold.
  const g = await host(clips(), { initial: 'hold', states: { hold: 'Hold' } });
  g.animator.addLayer({ clip: 'Move', weight: 1, mask: [1], blend: 'override', time: 0.75 });
  g.frame(0.1);
  g.frame(0.3);
  near(g.local(1)[0], 0.3, 1e-6, 'the layer samples its own time');
  near(g.local(1)[1], 0, 1e-6, 'and replaces the state pose');
  assert.throws(() => g.animator.addLayer({ clip: 'Move', weight: 1, mask: [1], blend: 'multiply' }), /override/);
  assert.throws(() => g.animator.addLayer({ clip: 'Move', weight: 1, mask: [1], time: -1 }), RangeError);
  h.release();
  g.release();
});

test('transitions, events and triggers reject invalid input with messages that name the fix', async () => {
  const f = clips();
  const make = (options) => host(clips(), { initial: 'a', states: { a: 'Move', b: 'Hold' }, ...options });
  await assert.rejects(make({ transitions: [{ from: 'a', to: 'b' }] }), /at least one of a when function/);
  await assert.rejects(make({ transitions: [{ from: 'x', to: 'b', trigger: 't' }] }), /known from/);
  await assert.rejects(make({ transitions: [{ from: 'a', to: 'b', exitTime: -1 }] }), /exitTime/);
  await assert.rejects(make({ events: [{ state: 'a', time: 2, name: 'x' }] }), /normalized time from 0 to 1/);
  await assert.rejects(make({ events: [{ state: 'z', time: 0.5, name: 'x' }] }), /known state/);
  await assert.rejects(host(f, { initial: '*', states: { '*': 'Move' } }), /reserved/);
  const h = await make({});
  assert.throws(() => h.animator.setTrigger(''), /non-empty name/);
  assert.throws(() => h.animator.on('event', null), /function/);
  h.release();
});

// Pelvis (node 1) at y 1 carries two legs: hip, knee, ankle at x -0.2 (left) and 0.2 (right); ankles at y 0.05.
function legs() {
  const f = animatedTriangle(),
    add = adder(f.doc, f.buffers),
    doc = f.doc;
  doc.nodes[1] = { name: 'Pelvis', translation: [0, 1, 0], children: [2, 5] };
  doc.nodes.push(
    { name: 'HipL', translation: [-0.2, 0, 0], children: [3] },
    { name: 'KneeL', translation: [0, -0.5, 0.03], children: [4] },
    { name: 'AnkleL', translation: [0, -0.45, -0.03] },
    { name: 'HipR', translation: [0.2, 0, 0], children: [6] },
    { name: 'KneeR', translation: [0, -0.5, 0.03], children: [7] },
    { name: 'AnkleR', translation: [0, -0.45, -0.03] },
  );
  doc.skins[0].joints = [1, 2, 3, 4, 5, 6, 7];
  doc.animations = [
    {
      name: 'Stand',
      channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
      samplers: [{ input: add([0, 1], 'SCALAR'), output: add([0, 1, 0, 0, 1, 0], 'VEC3') }],
    },
  ];
  return f;
}
const slope = Math.sin(0.2),
  ground = (x) => (x < 0 ? 0.1 : -0.2); // a 10 cm step under the left foot, a 20 cm drop under the right

test('foot placement raises and lowers feet, drops the pelvis and keeps the feet level or on the slope', async () => {
  const h = await host(legs(), { initial: 'stand', states: { stand: 'Stand' } });
  const placement = {
    pelvis: 1,
    legs: [
      { hip: 2, knee: 3, ankle: 4, pole: [-0.2, 0.5, 1] },
      { hip: 5, knee: 6, ankle: 7, pole: [0.2, 0.5, 1] },
    ],
    raycast: (origin, direction) => {
      assert.deepEqual(direction, [0, -1, 0]);
      return { position: [origin[0], ground(origin[0]), origin[2]] };
    },
  };
  const handle = addFootPlacement(h.animator, placement);
  h.frame(1 / 60);
  near(handle.pelvisOffset, -0.2, 1e-9, 'the pelvis drops by the deeper foot');
  assert.deepEqual(
    handle.footOffsets.map((v) => Math.round(v * 1e6) / 1e6),
    [0.1, -0.2],
  );
  near(h.world(1)[1], 0.8, 1e-6, 'pelvis height');
  near(h.world(4)[1], 0.15, 1e-4, 'left ankle on the step');
  near(h.world(7)[1], -0.15, 1e-4, 'right ankle down the drop');
  near(h.world(4)[0], -0.2, 1e-4, 'feet keep their animated x');
  near(h.world(4)[2], 0, 1e-4, 'and z');
  assert.ok(h.world(3)[2] > 0.03, 'the bent left knee points at its pole');
  for (const ankle of [4, 7]) {
    const up = h.up(ankle);
    near(up[1], 1, 1e-6, `ankle ${ankle} keeps its animated (level) orientation`);
  }
  // Every frame restarts from the animated pose: nothing accumulates.
  for (let i = 0; i < 5; i++) h.frame(1 / 60);
  near(h.world(1)[1], 0.8, 1e-6, 'pelvis height is stable over frames');
  near(h.world(7)[1], -0.15, 1e-4, 'and so is the foot');

  // Half weight: half the offsets.
  placement.weight = 0.5;
  h.frame(1 / 60);
  near(h.world(1)[1], 0.9, 1e-6, 'pelvis half way');
  near(h.world(4)[1], 0.1, 1e-4, 'left ankle half way');
  placement.weight = 1;

  // A capped pelvis drop: the right leg straightens toward the ground it cannot reach.
  placement.maxPelvisDrop = 0.05;
  h.frame(1 / 60);
  near(h.world(1)[1], 0.95, 1e-6, 'pelvis drop capped');
  assert.ok(h.world(7)[1] > -0.15 + 0.05, 'the right foot stays short of the drop');
  placement.maxPelvisDrop = 0.5;

  // Sloped ground under the left foot tilts it to the normal.
  placement.raycast = (origin) => ({
    position: [origin[0], ground(origin[0]), origin[2]],
    normal: origin[0] < 0 ? [slope, Math.cos(0.2), 0] : [0, 1, 0],
  });
  h.frame(1 / 60);
  const up = h.up(4);
  near(up[0], slope, 1e-5, 'left foot tilted to the slope');
  near(h.up(7)[1], 1, 1e-6, 'the right foot stays level on flat ground');

  // Nothing hit: the feet stay animated.
  placement.raycast = () => null;
  h.frame(1 / 60);
  near(handle.pelvisOffset, 0, 0, 'no pelvis offset without ground');
  near(h.world(4)[1], 0.05, 1e-6, 'animated ankle height');

  // Removed: the next frame plays the animated pose.
  placement.raycast = (origin) => ({ position: [origin[0], ground(origin[0]), origin[2]] });
  handle.dispose();
  h.frame(1 / 60);
  near(h.world(1)[1], 1, 1e-6, 'pelvis back at its animated height');
  near(h.world(7)[1], 0.05, 1e-6, 'right foot back');
  h.release();
});

test('foot placement checks its legs and settings', async () => {
  const h = await host(legs(), { initial: 'stand', states: { stand: 'Stand' } });
  const raycast = () => null,
    leg = { hip: 2, knee: 3, ankle: 4, pole: [0, 0, 1] };
  assert.throws(() => addFootPlacement(h.animator, { pelvis: 99, legs: [leg], raycast }), /pelvis 99/);
  assert.throws(() => addFootPlacement(h.animator, { pelvis: 1, legs: [], raycast }), /1-8 legs/);
  assert.throws(() => addFootPlacement(h.animator, { pelvis: 1, legs: [leg] }), /raycast/);
  assert.throws(
    () => addFootPlacement(h.animator, { pelvis: 1, legs: [{ ...leg, knee: 6 }], raycast }),
    /direct chain/,
  );
  assert.throws(() => addFootPlacement(h.animator, { pelvis: 5, legs: [leg], raycast }), /below the pelvis/);
  assert.throws(() => addFootPlacement(h.animator, { pelvis: 1, legs: [leg], raycast, weight: 2 }), /weight/);
  h.release();
});
