import assert from 'node:assert/strict';
import test from 'node:test';
import { Camera } from '@margoengine/core';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Cutscene, validateCutscene } from '@margoengine/cutscene';
import { TakeRecorder, appendTake, inputTracks, takeDocument } from '@margoengine/cutscene/record';
import { Input } from '@margoengine/input';

const STEP = 1 / 60;
const rotationAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((sum, x, i) => sum + x * b[i], 0))));
const yaw = (angle) => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];

/** A repeatable wobble, so a path is not a smooth curve a thinner could get right by luck. */
const noise = (i) => Math.sin(i * 12.9898) * 43758.5453 % 1;

test('every sample of a take stays within the tolerance of what the tracks play', () => {
  const recorder = new TakeRecorder({ tolerance: { position: 0.01, rotation: 0.005, scale: 0.02 } });
  const samples = [];
  let i = 0;
  recorder.transform('hero', () => {
    const t = i * STEP,
      position = [Math.sin(t) * 5 + noise(i) * 0.003, t * 2, Math.cos(t * 3)],
      rotation = yaw(t * 1.7),
      scale = [1 + 0.2 * Math.sin(t * 2), 1, 1];
    samples.push({ t, position, rotation, scale });
    return { position, rotation, scale };
  });
  for (; i < 600; i++) recorder.capture(i * STEP);
  const take = recorder.stop(),
    cutscene = new Cutscene(takeDocument(take));
  for (const { t, position, rotation, scale } of samples) {
    const seen = cutscene.evaluate(t).transforms.hero;
    assert.ok(Math.hypot(...seen.position.map((x, k) => x - position[k])) <= 0.01 + 1e-9, `position at ${t}`);
    assert.ok(rotationAngle(seen.rotation, rotation) <= 0.005 + 1e-6, `rotation at ${t}`);
    assert.ok(Math.hypot(...seen.scale.map((x, k) => x - scale[k])) <= 0.02 + 1e-9, `scale at ${t}`);
  }
  const { samples: count, keys } = take.kept['transform-hero'];
  assert.equal(count, 600);
  assert.ok(keys < 300, `keys thinned: ${keys}`);
});

test('a straight move keeps its two ends, and a still channel one key', () => {
  const recorder = new TakeRecorder();
  let x = 0;
  recorder.transform('box', () => ({ position: [x, 0, 0], scale: [2, 2, 2] }));
  for (let i = 0; i <= 100; i++) {
    x = i * 0.1;
    recorder.capture(i * 0.1);
  }
  const { tracks } = recorder.stop(),
    keys = tracks[0].keys;
  assert.equal(keys.filter((key) => key.position).length, 2);
  assert.equal(keys.filter((key) => key.scale).length, 1);
  assert.deepEqual(keys[0].scale, [2, 2, 2]);
});

test('tolerance 0 keeps a change the line does not explain', () => {
  const recorder = new TakeRecorder({ tolerance: { value: 0 } });
  const values = [0, 1, 1.25, 1.5, 0];
  let i = 0;
  recorder.property('light', 'intensity', () => values[i]);
  for (; i < values.length; i++) recorder.capture(i);
  assert.deepEqual(recorder.stop().tracks[0].keys.map((key) => key.value), [0, 1, 1.5, 0]);
});

test('a quaternion that flips sign between ticks still turns the short way', () => {
  const recorder = new TakeRecorder({ tolerance: { rotation: 0.001 } });
  let i = 0;
  // The same steady turn, with every other sample negated as a physics engine may give it.
  recorder.transform('wheel', () => ({
    rotation: yaw(i * 0.1).map((x) => (i % 2 ? -x : x)),
  }));
  for (; i < 20; i++) recorder.capture(i);
  const take = recorder.stop(),
    cutscene = new Cutscene(takeDocument(take));
  assert.equal(take.kept['transform-wheel'].keys, 2, 'a steady turn is one slerp once the signs agree');
  assert.ok(rotationAngle(cutscene.evaluate(9.5).transforms.wheel.rotation, yaw(0.95)) < 1e-4);
});

test('a Mesh records as it is: vector members and Euler rotation', () => {
  const vector = (x, y, z) => ({ x, y, z });
  const mesh = { position: vector(1, 2, 3), rotation: vector(0, Math.PI / 2, 0), scale: vector(1, 1, 1) };
  const recorder = new TakeRecorder();
  recorder.transform('crate', mesh).capture(0);
  const [key] = recorder.stop().tracks[0].keys;
  assert.deepEqual(key.position, [1, 2, 3]);
  assert.ok(rotationAngle(key.rotation, yaw(Math.PI / 2)) < 1e-7);
});

test('the camera records as a linear camera track, within tolerance', () => {
  const recorder = new TakeRecorder({ tolerance: { position: 0.01, value: 0.1 } }),
    seen = [];
  let i = 0;
  recorder.camera(() => {
    const sample = { position: [Math.sin(i / 30) * 4, 2, 5], target: [0, 1, i / 100], fov: 40 + i / 10, roll: 0 };
    seen.push(sample);
    return sample;
  });
  for (; i < 200; i++) recorder.capture(i * STEP);
  const take = recorder.stop(),
    [track] = take.tracks,
    cutscene = new Cutscene(takeDocument(take));
  assert.equal(track.type, 'camera');
  assert.equal(track.path, 'linear');
  seen.forEach((sample, tick) => {
    const { camera } = cutscene.evaluate(tick * STEP);
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(camera.position[k] - sample.position[k]) <= 0.01 + 1e-9);
      assert.ok(Math.abs(camera.target[k] - sample.target[k]) <= 0.01 + 1e-9);
    }
    assert.ok(Math.abs(camera.fov - sample.fov) <= 0.1 + 1e-9);
  });
  assert.ok(take.kept.camera.keys < 60);
});

test('properties record numbers and arrays', () => {
  const recorder = new TakeRecorder();
  let t = 0;
  recorder.property('door', 'open', () => t).property('lamp', 'color', () => [t, 0, 1 - t]);
  for (t = 0; t <= 1; t += 0.25) recorder.capture(t);
  const { tracks } = recorder.stop();
  assert.equal(tracks[0].target, 'door');
  assert.deepEqual(tracks[0].keys.map((key) => key.value), [0, 1]);
  assert.deepEqual(tracks[1].keys.at(-1).value, [1, 0, 0]);
});

/** An Input's two members, driven by a script of values per tick: a stand-in for a device. */
const fakeInput = () => {
  const values = { jump: [0], move: [0, 0] };
  return {
    values,
    actions: { jump: [{}], move: [{}, {}] },
    bindingValue: (action, binding) => values[action][binding],
  };
};

test('input becomes stepped tracks that give back the value of every tick, and press and release events', () => {
  const input = fakeInput(),
    recorder = new TakeRecorder(),
    script = [
      [0, 0, 0],
      [1, 0.25, 0],
      [1, 0.5, 0],
      [0, 0.5, -1],
      [0, 0, -1],
      [1, 0, 0],
      [0, 0, 0],
    ];
  recorder.input(input);
  script.forEach(([jump, move, strafe], tick) => {
    input.values.jump[0] = jump;
    input.values.move[0] = move;
    input.values.move[1] = strafe;
    recorder.capture(2 + tick * 0.5); // The clock need not start at 0: the first capture is time 0.
  });
  const take = recorder.stop(),
    cutscene = new Cutscene(takeDocument(take));
  script.forEach(([jump, move, strafe], tick) => {
    const { input: seen } = cutscene.evaluate(tick * 0.5).properties;
    assert.deepEqual([seen.jump, seen.move, seen['move#1']], [jump, move, strafe], `tick ${tick}`);
    // Stepped: just before the tick the old value still stands.
    if (tick) {
      const before = cutscene.evaluate(tick * 0.5 - 0.001).properties.input;
      assert.equal(before.jump, script[tick - 1][0]);
    }
  });
  const events = take.tracks.find((track) => track.type === 'event').events;
  assert.deepEqual(
    events.filter((event) => event.name.startsWith('jump')).map((event) => [event.name, event.time]),
    [['jump', 0.5], ['jump:up', 1.5], ['jump', 2.5], ['jump:up', 3]],
  );
  // A held axis that changes value is one press, not many.
  assert.deepEqual(
    events.filter((event) => event.name.startsWith('move') && event.data.binding === 0).map((event) => event.name),
    ['move', 'move:up'],
  );
});

test('input started part way through a take lands at its own time, and inputTracks takes a saved clip', () => {
  const input = fakeInput(),
    recorder = new TakeRecorder();
  recorder.capture(0).capture(1);
  recorder.input(input);
  recorder.capture(2);
  input.values.jump[0] = 1;
  recorder.capture(3);
  const { tracks } = recorder.stop();
  assert.deepEqual(tracks.find((track) => track.id === 'input-jump').keys.map((key) => [key.time, key.value]), [[2, 0], [3, 1]]);
  const saved = { version: 1, channels: [['fire', 0]], times: [0, 100], events: [1, 0, 1] };
  const [property, events] = inputTracks(saved, { at: 1, target: 'p2' });
  assert.equal(property.target, 'p2');
  assert.deepEqual(property.keys.at(-1), { time: 1.1, value: 1, ease: 'step' });
  assert.equal(events.events[0].name, 'fire');
});

test('a value held from the very first tick presses at time 0', () => {
  const clip = { version: 1, channels: [['fire', 0]], times: [0, 100], events: [0, 0, 1, 1, 0, 0] };
  const [property, events] = inputTracks(clip);
  assert.deepEqual(property.keys.map((key) => key.value), [1, 0]);
  assert.deepEqual(events.events.map((event) => [event.name, event.time]), [['fire', 0], ['fire:up', 0.1]]);
});

test('the clock, events and markers', () => {
  let now = 5000;
  const recorder = new TakeRecorder({ now: () => now });
  recorder.property('a', 'b', () => 1);
  recorder.capture();
  now += 1500;
  recorder.capture();
  assert.equal(recorder.time, 1.5);
  assert.equal(recorder.frames, 2);
  recorder.event('door', { open: true }).marker('reveal');
  const take = recorder.stop();
  assert.equal(take.duration, 1.5);
  assert.deepEqual(take.markers, [{ time: 1.5, name: 'reveal' }]);
  assert.deepEqual(take.tracks.at(-1).events, [{ time: 1.5, name: 'door', data: { open: true } }]);
});

test('the recorder refuses what it cannot keep', () => {
  assert.throws(() => new TakeRecorder({ tolerance: { position: -1 } }), /tolerance position/);
  const recorder = new TakeRecorder();
  assert.throws(() => recorder.stop(), (error) => error.code === 'state' && /no samples/.test(error.message));
  recorder.transform('a', () => ({ position: [0, 0, 0] }));
  assert.throws(() => recorder.transform('a', {}), /already records 'a'/);
  recorder.camera(() => ({ position: [0, 0, 1], target: [0, 0, 0] }));
  assert.throws(() => recorder.camera({}), /already records a camera/);
  recorder.capture(1);
  assert.throws(() => recorder.capture(0.5) && recorder.capture(0), /went backwards/);
  recorder.stop();
  assert.throws(() => recorder.capture(), (error) => error.code === 'state');
  assert.throws(() => recorder.stop(), (error) => error.code === 'state');
  const bad = new TakeRecorder();
  bad.transform('x', () => ({ position: [Number.NaN, 0, 0] }));
  assert.throws(() => bad.capture(0), /finite/);
  const grows = new TakeRecorder();
  let length = 1;
  grows.property('x', 'y', () => new Array(length).fill(0));
  grows.capture(0);
  length = 2;
  assert.throws(() => grows.capture(1), /changed its length/);
});

test('a take is a valid document, and appending shifts it and leaves the original alone', () => {
  const recorder = new TakeRecorder();
  recorder.transform('hero', () => ({ position: [0, 0, 0] }));
  recorder.capture(0).capture(2);
  recorder.event('hit').marker('end');
  const take = recorder.stop(),
    document = takeDocument(take);
  assert.deepEqual(validateCutscene(document), []);
  const base = { format: 'margo-cutscene', version: 1, duration: 3, tracks: [], markers: [{ time: 1, name: 'a' }] };
  const before = JSON.stringify(base);
  const first = appendTake(base, take);
  assert.equal(JSON.stringify(base), before);
  assert.equal(first.duration, 5);
  assert.deepEqual(first.tracks[0].keys[0].time, 3);
  assert.deepEqual(first.tracks[1].events[0].time, 5);
  assert.deepEqual(first.markers, [{ time: 1, name: 'a' }, { time: 5, name: 'end' }]);
  assert.deepEqual(validateCutscene(first), []);
  assert.throws(() => appendTake(first, take), /Track id 'transform-hero' is taken/);
  const second = appendTake(first, take, { at: 1, prefix: 'b-' });
  assert.equal(second.duration, 5);
  assert.deepEqual(second.tracks.map((track) => track.id), ['transform-hero', 'events', 'b-transform-hero', 'b-events']);
  assert.deepEqual(validateCutscene(second), []);
  assert.throws(() => appendTake(base, take, { at: -1 }), /time of 0 or more/);
});

test('one tick still makes a valid document', () => {
  const recorder = new TakeRecorder();
  recorder.property('a', 'b', () => 1).capture(0);
  assert.deepEqual(validateCutscene(takeDocument(recorder.stop())), []);
});

/** A real engine on a real transform store and kernel, with no renderer: the meshes, matrices and ticks are the real ones. */
async function realEngine(t) {
  const store = await TransformStore.create(16),
    engine = new Engine(
      { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
      store,
      { backend: 'webgpu', gpu: {}, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  t.after(() => engine.dispose());
  return { engine, store };
}

test('a real Mesh records, and plays back to the same world matrix through setQuaternion', async (t) => {
  const { engine, store } = await realEngine(t),
    mesh = engine.createMesh(),
    copy = engine.createMesh(),
    recorder = new TakeRecorder({ tolerance: { position: 0, rotation: 0, scale: 0 } }).transform('hero', mesh),
    frames = 40;
  const pose = (i) => ({
    position: [i * 0.1, Math.sin(i / 5), 2],
    rotation: [Math.sin(i / 7) * 1.2, i * 0.09, Math.cos(i / 4) * 0.8],
    scale: [1 + i / 40, 1, 2],
  });
  for (let i = 0; i < frames; i++) {
    const { position, rotation, scale } = pose(i);
    mesh.setPosition(position).setRotation(rotation).setScale(scale);
    recorder.capture(i * STEP);
  }
  const cutscene = new Cutscene(takeDocument(recorder.stop()));
  for (let i = 0; i < frames; i++) {
    const { position, rotation, scale } = pose(i),
      seen = cutscene.evaluate(i * STEP).transforms.hero;
    mesh.setPosition(position).setRotation(rotation).setScale(scale);
    copy.setPosition(seen.position).setQuaternion(seen.rotation).setScale(seen.scale);
    store.tick(false);
    // The store is single precision: 1e-5 is a few of its steps at these sizes.
    mesh.matrix.forEach((value, k) => assert.ok(Math.abs(value - copy.matrix[k]) < 1e-5, `frame ${i} element ${k}`));
  }
});

test('a real Camera records through its own fields', () => {
  const camera = new Camera({ position: [0, 2, 5], target: [0, 1, 0], fov: 50 }),
    recorder = new TakeRecorder().camera(camera);
  for (let i = 0; i <= 30; i++) {
    camera.position = [i / 10, 2, 5];
    camera.fov = 50 - i / 3;
    recorder.capture(i / 30);
  }
  const state = new Cutscene(takeDocument(recorder.stop())).evaluate(0.5).camera;
  assert.ok(Math.abs(state.position[0] - 1.5) <= 1e-3 + 1e-9);
  assert.deepEqual(state.target, [0, 1, 0]);
  assert.ok(Math.abs(state.fov - 45) <= 1e-3 + 1e-9);
});

test('a real Input on real key and pointer events comes out of the tracks tick for tick', () => {
  const target = new EventTarget(),
    input = new Input(
      {
        jump: [{ type: 'key', code: 'Space' }],
        walk: [{ type: 'key', code: 'KeyW' }, { type: 'key', code: 'KeyS', scale: -1 }],
        look: [{ type: 'pointer', axis: 'x', scale: 0.5 }],
      },
      { target, gamepads: () => [] },
    ),
    recorder = new TakeRecorder().input(input),
    key = (type, code) => target.dispatchEvent(Object.assign(new Event(type), { code })),
    move = (x) => target.dispatchEvent(Object.assign(new Event('pointermove'), { movementX: x, movementY: 0 })),
    script = [
      () => {},
      () => key('keydown', 'Space'),
      () => key('keydown', 'KeyW'),
      () => {
        key('keyup', 'Space');
        move(8);
      },
      () => key('keydown', 'KeyS'),
      () => {
        key('keyup', 'KeyW');
        key('keyup', 'KeyS');
      },
    ],
    live = [];
  script.forEach((step, tick) => {
    step();
    input.update();
    live.push([input.state('jump').value, input.state('walk').value, input.bindingValue('look', 0)]);
    recorder.capture(tick / 10);
  });
  assert.deepEqual(live.map((row) => row[0]), [0, 1, 1, 0, 0, 0], 'the real device did press');
  assert.deepEqual(live.map((row) => row[2]), [0, 0, 0, 4, 0, 0], 'the real pointer did move');
  const take = recorder.stop(),
    cutscene = new Cutscene(takeDocument(take));
  live.forEach(([jump, walk, look], tick) => {
    const seen = cutscene.evaluate(tick / 10).properties.input;
    assert.equal(seen.jump, jump, `jump at tick ${tick}`);
    assert.equal(seen.walk + seen['walk#1'], walk, `walk at tick ${tick}`);
    assert.equal(seen.look, look, `look at tick ${tick}`);
  });
  const events = take.tracks.find((track) => track.id === 'input-events').events;
  assert.deepEqual(
    events.filter((event) => event.name.startsWith('jump')).map((event) => event.name),
    ['jump', 'jump:up'],
  );
  input.dispose();
});
