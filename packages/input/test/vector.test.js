import test from 'node:test';
import assert from 'node:assert/strict';
import { VectorInput, wasd } from '../dist/vector.js';
import { InputRecorder, InputReplay } from '../dist/replay.js';
const key = (target, type, code) => target.dispatchEvent(Object.assign(new Event(type), { code }));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
test('WASD diagonal is unit length, opposite keys cancel and state is reused', () => {
  const target = new EventTarget();
  const input = new VectorInput({ move: wasd() }, { target, gamepads: () => [] });
  const state = input.vector('move');
  key(target, 'keydown', 'KeyW');
  key(target, 'keydown', 'KeyD');
  input.update();
  near(state.x, Math.SQRT1_2);
  near(state.y, -Math.SQRT1_2);
  near(state.magnitude, 1);
  assert.equal(state.pressed, true);
  input.update();
  assert.equal(state.pressed, false);
  assert.equal(input.vector('move'), state);
  key(target, 'keydown', 'KeyS');
  input.update();
  near(state.y, 0);
  near(state.x, 1);
  input.reset();
  assert.equal(state.magnitude, 0);
  assert.equal(state.released, true);
  input.dispose();
  assert.throws(() => input.update(), { code: 'disposed' });
});
test('radial deadzone preserves direction and sub-axis-threshold diagonals', () => {
  const pad = { axes: [0.12, 0.12] };
  const input = new VectorInput(
    { stick: { x: [{ type: 'gamepad-axis', index: 0 }], y: [{ type: 'gamepad-axis', index: 1 }] } },
    { target: new EventTarget(), gamepads: () => [pad] },
  );
  input.update();
  assert.ok(input.vector('stick').magnitude > 0);
  pad.axes = [0.3, 0.4];
  input.update();
  near(input.vector('stick').magnitude, (0.5 - 0.15) / 0.85);
  near(input.vector('stick').x / input.vector('stick').y, 0.75);
  pad.axes = [0.1, 0];
  input.update();
  assert.equal(input.vector('stick').released, true);
  pad.axes = [1, 1];
  input.update();
  near(input.vector('stick').magnitude, 1);
  input.dispose();
});
test('normalization, contexts, scalar actions, rebind and replay use the same binding channels', async () => {
  const target = new EventTarget();
  const input = new VectorInput(
    { move: { ...wasd(), normalize: true } },
    {
      target,
      gamepads: () => [],
      actions: { fire: [{ type: 'mouse', button: 0 }] },
      contexts: { game: ['move.x', 'move.y'] },
    },
  );
  const record = new InputRecorder(input, { now: () => 0 });
  key(target, 'keydown', 'KeyD');
  input.update();
  record.capture();
  input.setContext('game', false);
  input.update();
  record.capture();
  assert.equal(input.vector('move').magnitude, 0);
  input.setContext('game', true);
  input.reset();
  const replay = new InputReplay(input, record.clip());
  input.update();
  assert.equal(input.vector('move').x, 1);
  input.update();
  assert.equal(input.vector('move').released, true);
  replay.stop();
  await replay.finished;
  input.rebind('move.x', [{ type: 'control', id: 'stick', axis: 'x' }]);
  input.control('stick').x = 0.2;
  input.update();
  near(input.vector('move').magnitude, 1);
  input.dispose();
});
test('invalid vector definitions fail before listeners attach', () => {
  const options = { target: new EventTarget(), gamepads: () => [] };
  for (const deadzone of [-1, 1, NaN, Infinity])
    assert.throws(() => new VectorInput({ a: { ...wasd(), deadzone } }, options), RangeError);
  assert.throws(
    () => new VectorInput({ a: wasd() }, { ...options, actions: { 'a.x': [{ type: 'key', code: 'X' }] } }),
    TypeError,
  );
  assert.throws(() => new VectorInput({ a: { x: [], y: [] } }, options), TypeError);
});
