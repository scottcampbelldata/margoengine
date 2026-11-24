import test from 'node:test';
import assert from 'node:assert/strict';
import { Input } from '../dist/index.js';
import { Interactions } from '../dist/interactions.js';
import { InputRecorder, InputReplay } from '../dist/replay.js';

const ACTIONS = {
  move: [
    { type: 'key', code: 'KeyD' },
    { type: 'key', code: 'KeyA', scale: -1 },
    { type: 'gamepad-axis', index: 0 },
  ],
  look: [{ type: 'pointer', axis: 'x', scale: 0.01 }],
  use: [
    { type: 'key', code: 'KeyE' },
    { type: 'gamepad-button', index: 0 },
  ],
};
const RULES = {
  open: { type: 'tap', action: 'use' },
  inspect: { type: 'hold', action: 'use', binding: 1 },
  dash: { type: 'double-press', action: 'use', binding: 0 },
};
function rig(actions = ACTIONS) {
  const target = new EventTarget(),
    pads = [{ axes: [0], buttons: [{ value: 0 }] }],
    input = new Input(actions, { target, gamepads: () => pads }),
    send = (type, fields) => target.dispatchEvent(Object.assign(new Event(type), fields));
  return { target, pads, input, send };
}
// A seeded session: keys, a gamepad and mouse motion, ticks of uneven length.
function play(steps = 400) {
  const { pads, input, send } = rig();
  let seed = 7,
    time = 0;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32,
    rules = new Interactions(input, RULES, { now: () => time }),
    recorder = new InputRecorder(input, { now: () => time + 5000 }),
    trace = [],
    held = new Set();
  for (let i = 0; i < steps; i++) {
    time += 8 + Math.floor(random() * 30);
    if (random() < 0.2) {
      const code = ['KeyD', 'KeyA', 'KeyE'][Math.floor(random() * 3)];
      send(held.has(code) ? 'keyup' : 'keydown', { code });
      held.has(code) ? held.delete(code) : held.add(code);
    }
    if (random() < 0.1) pads[0].axes[0] = random() * 2 - 1;
    if (random() < 0.1) pads[0].buttons[0].value = pads[0].buttons[0].value ? 0 : 1;
    if (random() < 0.3) send('pointermove', { pointerType: 'mouse', movementX: Math.floor(random() * 40) - 20 });
    input.update();
    rules.update();
    recorder.capture();
    trace.push(snapshot(input, rules));
  }
  input.dispose();
  return { clip: recorder.clip(), trace, recorder };
}
function snapshot(input, rules) {
  return JSON.stringify([
    ...Object.keys(ACTIONS).map((name) => ({ ...input.state(name) })),
    ...Object.keys(RULES).map((name) => ({ ...rules.state(name) })),
  ]);
}

test('a replay gives the same states and rule results, tick for tick, through JSON', async () => {
  const { clip, trace } = play(),
    { input } = rig(),
    replay = new InputReplay(input, JSON.stringify(clip)),
    rules = new Interactions(input, RULES, { now: () => replay.time });
  assert.equal(replay.frame, -1);
  assert.equal(replay.frames, trace.length);
  const seen = [];
  for (let i = 0; i < trace.length; i++) {
    input.update();
    rules.update();
    seen.push(snapshot(input, rules));
  }
  // The live rules ran on a clock that started before the first tick, so durations match: all times are differences.
  assert.deepEqual(seen, trace);
  input.update();
  await replay.finished;
  input.dispose();
});

test('the session under test really used every kind of source', () => {
  const { clip, trace } = play();
  assert.deepEqual(
    clip.channels.map(([action, binding]) => `${action}${binding}`).sort(),
    ['look0', 'move0', 'move1', 'move2', 'use0', 'use1'],
  );
  assert.ok(trace.some((line) => /"performed":true/.test(line)));
  assert.ok(clip.events.length / 3 < clip.channels.length * trace.length, 'only changes are stored');
  assert.equal(clip.times[0], 0, 'times start at the first tick');
});

test('live devices are ignored during a replay and return after it', async () => {
  const live = rig(),
    recorder = new InputRecorder(live.input);
  live.send('keydown', { code: 'KeyE' });
  live.input.update();
  recorder.capture();
  live.input.update();
  recorder.capture();
  const { input, send } = rig(),
    replay = new InputReplay(input, recorder.clip());
  send('keydown', { code: 'KeyD' });
  input.update();
  assert.equal(input.state('use').pressed, true);
  assert.equal(input.state('move').value, 0, 'the held key does not reach the game');
  input.update();
  assert.equal(input.state('use').down, true);
  input.update();
  await replay.finished;
  assert.equal(input.state('use').released, true, 'what the clip held is let go at the end');
  assert.equal(input.state('move').value, 1, 'the devices are back');
});

test('a binding value change to 0 and a press of one tick are both kept', () => {
  const { input, send } = rig(),
    recorder = new InputRecorder(input);
  send('keydown', { code: 'KeyE' });
  send('keyup', { code: 'KeyE' });
  input.update();
  recorder.capture();
  input.update();
  recorder.capture();
  const use = recorder.clip().channels.findIndex((c) => c[0] === 'use');
  assert.deepEqual(recorder.clip().events, [0, use, 1, 1, use, 0]);
});

test('a clip keeps growing after clip() and the copy does not', () => {
  const { input } = rig(),
    recorder = new InputRecorder(input);
  input.update();
  recorder.capture();
  const first = recorder.clip();
  input.update();
  recorder.capture();
  assert.equal(recorder.frames, 2);
  assert.equal(first.times.length, 1);
});

test('rebinding while recording adds channels', () => {
  const { input, send } = rig({ a: [{ type: 'key', code: 'KeyA' }] }),
    recorder = new InputRecorder(input);
  input.update();
  recorder.capture();
  input.rebind('a', [
    { type: 'key', code: 'KeyA' },
    { type: 'key', code: 'KeyB' },
  ]);
  send('keydown', { code: 'KeyB' });
  input.update();
  recorder.capture();
  const replayed = rig({
    a: [
      { type: 'key', code: 'KeyA' },
      { type: 'key', code: 'KeyB' },
    ],
  }).input;
  new InputReplay(replayed, recorder.clip());
  replayed.update();
  assert.equal(replayed.state('a').down, false);
  replayed.update();
  assert.equal(replayed.bindingValue('a', 1), 1);
});

test('an Input with fewer bindings or more actions than the clip plays what it can', () => {
  const { input } = rig({ use: [{ type: 'key', code: 'KeyE' }], extra: [{ type: 'key', code: 'KeyX' }] });
  new InputReplay(input, { version: 1, channels: [['use', 3]], times: [0], events: [0, 0, 1] });
  input.update();
  assert.equal(input.state('use').value, 0);
  assert.equal(input.state('extra').value, 0);
});

test('contexts still mute a replayed action', () => {
  const target = new EventTarget(),
    input = new Input(
      { use: [{ type: 'key', code: 'KeyE' }] },
      { target, gamepads: () => [], contexts: { game: ['use'] } },
    );
  new InputReplay(input, { version: 1, channels: [['use', 0]], times: [0, 16], events: [0, 0, 1] });
  input.setContext('game', false);
  input.update();
  assert.equal(input.state('use').down, false);
  input.setContext('game', true);
  input.update();
  assert.equal(input.state('use').down, true);
});

test('loop starts again with released state and a clock that keeps rising', () => {
  const { input } = rig(),
    clip = { version: 1, channels: [['use', 0]], times: [0, 10, 20], events: [1, 0, 1] },
    replay = new InputReplay(input, clip, { loop: true }),
    down = [],
    times = [];
  for (let i = 0; i < 7; i++) {
    input.update();
    down.push(input.state('use').down);
    times.push(replay.time);
  }
  assert.deepEqual(down, [false, true, true, false, true, true, false]);
  assert.deepEqual(times, [0, 10, 20, 30, 40, 50, 60]);
  replay.stop();
});

test('stop hands back the devices and resolves; a signal rejects', async () => {
  const clip = { version: 1, channels: [], times: [0, 1, 2], events: [] };
  const one = rig(),
    replay = new InputReplay(one.input, clip);
  one.input.update();
  replay.stop();
  replay.stop();
  await replay.finished;
  one.send('keydown', { code: 'KeyE' });
  one.input.update();
  assert.equal(one.input.state('use').down, true);

  const two = rig(),
    controller = new AbortController(),
    aborted = new InputReplay(two.input, clip, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted.finished, { name: 'AbortError' });
  two.send('keydown', { code: 'KeyE' });
  two.input.update();
  assert.equal(two.input.state('use').down, true);

  const three = rig(),
    late = new InputReplay(three.input, clip, { signal: AbortSignal.abort() });
  await assert.rejects(late.finished, { name: 'AbortError' });
  three.send('keydown', { code: 'KeyE' });
  three.input.update();
  assert.equal(three.input.state('use').down, true, 'an aborted signal never takes the Input over');
  {
    using scoped = new InputReplay(rig().input, clip);
    assert.equal(scoped.frame, -1);
  }
});

test('an empty clip ends on the first update', async () => {
  const { input } = rig(),
    replay = new InputReplay(input, { version: 1, channels: [], times: [], events: [] }, { loop: true });
  assert.equal(replay.time, 0);
  input.update();
  await replay.finished;
});

test('a bad clip is refused before it touches the Input', () => {
  const { input, send } = rig();
  const good = { version: 1, channels: [['use', 0]], times: [0, 1], events: [0, 0, 1] };
  for (const clip of [
    'not json',
    'null',
    { ...good, version: 2 },
    { ...good, channels: 1 },
    { ...good, times: 1 },
    { ...good, events: [0, 0] },
    { ...good, channels: [['use', -1]] },
    { ...good, channels: [[1, 0]] },
    { ...good, channels: [null] },
    { ...good, channels: [['nope', 0]] },
    { ...good, times: [1, 0] },
    { ...good, times: [0, NaN] },
    { ...good, events: [1, 0, 1, 0, 0, 1] },
    { ...good, events: [5, 0, 1] },
    { ...good, events: [0.5, 0, 1] },
    { ...good, events: [0, 1, 1] },
    { ...good, events: [0, 0, null] },
  ])
    assert.throws(() => new InputReplay(input, clip), TypeError, JSON.stringify(clip));
  assert.throws(() => new InputReplay({}, good), TypeError);
  assert.throws(() => new InputRecorder({}), TypeError);
  send('keydown', { code: 'KeyE' });
  input.update();
  assert.equal(input.state('use').down, true);
});
