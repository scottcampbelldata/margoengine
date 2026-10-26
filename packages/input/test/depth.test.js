import test from 'node:test';
import assert from 'node:assert/strict';
import { Input, Gestures, bindingLabel } from '../dist/index.js';

const key = (target, type, code, extra = {}) =>
  target.dispatchEvent(Object.assign(new Event(type), { code, ...extra }));
const make = (actions, options = {}) => {
  const target = new EventTarget();
  return { target, input: new Input(actions, { target, gamepads: () => [], ...options }) };
};

test('chords need every modifier and a plain key does not satisfy them', () => {
  const { target, input } = make({ save: [{ type: 'key', code: 'KeyS', modifiers: ['ctrl'] }] });
  key(target, 'keydown', 'KeyS');
  input.update();
  assert.equal(input.state('save').down, false);
  key(target, 'keydown', 'ControlLeft');
  input.update();
  assert.equal(input.state('save').pressed, true);
  key(target, 'keyup', 'ControlLeft');
  input.update();
  assert.equal(input.state('save').released, true);
  assert.throws(() => make({ a: [{ type: 'key', code: 'KeyA', modifiers: ['hyper'] }] }), TypeError);
  input.dispose();
});

test('contexts mute the actions they own and release held ones', () => {
  const { target, input } = make(
    {
      jump: [{ type: 'key', code: 'Space' }],
      confirm: [{ type: 'key', code: 'Enter' }],
      quit: [{ type: 'key', code: 'KeyQ' }],
    },
    { contexts: { game: ['jump'], menu: ['confirm'] } },
  );
  key(target, 'keydown', 'Space');
  key(target, 'keydown', 'Enter');
  key(target, 'keydown', 'KeyQ');
  input.update();
  assert.deepEqual(
    [input.state('jump').down, input.state('confirm').down, input.state('quit').down],
    [true, true, true],
  );
  input.setContext('game', false);
  input.update();
  assert.equal(input.state('jump').down, false);
  assert.equal(input.state('jump').released, true);
  assert.equal(input.state('quit').down, true, 'unlisted actions are always active');
  assert.equal(input.hasContext('game'), false);
  assert.throws(() => input.setContext('nope', true), TypeError);
  input.setContext('game', true);
  input.update();
  assert.equal(input.state('jump').pressed, true);
  assert.throws(() => make({ a: [{ type: 'key', code: 'KeyA' }] }, { contexts: { c: ['missing'] } }), TypeError);
  input.dispose();
});

test('rebind, export, import and reset round-trip through JSON and validate before changing anything', () => {
  const { target, input } = make({ jump: [{ type: 'key', code: 'Space' }], fire: [{ type: 'mouse', button: 0 }] });
  input.rebind('jump', [{ type: 'key', code: 'KeyJ', modifiers: ['shift'] }]);
  const saved = JSON.stringify(input.exportBindings());
  input.resetBindings();
  assert.equal(input.actions.jump[0].code, 'Space');
  input.importBindings(saved);
  assert.equal(input.actions.jump[0].code, 'KeyJ');
  assert.throws(
    () => input.importBindings({ fire: [{ type: 'mouse', button: 9 }], jump: [{ type: 'key', code: 'KeyZ' }] }),
    TypeError,
  );
  assert.equal(input.actions.jump[0].code, 'KeyJ', 'a rejected import leaves bindings unchanged');
  input.importBindings({ renamedAway: [{ type: 'key', code: 'KeyX' }] });
  assert.throws(() => input.importBindings('{not json'), TypeError);
  assert.throws(() => input.rebind('missing', [{ type: 'key', code: 'A' }]), TypeError);
  assert.throws(() => input.rebind('jump', []), TypeError);
  key(target, 'keydown', 'KeyJ');
  key(target, 'keydown', 'ShiftLeft');
  input.update();
  assert.equal(input.state('jump').down, true);
  input.dispose();
});

test('captureBinding resolves the next key with its modifiers, cancels on Escape and honours abort', async () => {
  const { target, input } = make({ jump: [{ type: 'key', code: 'Space' }] });
  let p = input.captureBinding();
  key(target, 'keydown', 'KeyK', { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  assert.deepEqual(await p, { type: 'key', code: 'KeyK', modifiers: ['ctrl'] });
  p = input.captureBinding();
  target.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 2, pointerType: 'mouse' }));
  assert.deepEqual(await p, { type: 'mouse', button: 2 });
  p = input.captureBinding();
  key(target, 'keydown', 'Escape');
  await assert.rejects(p, { name: 'AbortError' });
  const controller = new AbortController();
  p = input.captureBinding({ signal: controller.signal });
  controller.abort();
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(target.listenerCount?.('keydown') ?? 0, 0);
  // a captured key does not leave a stray listener that later fires
  p = input.captureBinding();
  key(target, 'keydown', 'KeyA', {});
  await p;
  key(target, 'keydown', 'KeyB', {});
  input.dispose();
  await assert.rejects(input.captureBinding(), { code: 'disposed' });
});

test('bindingLabel gives player-facing prompts', () => {
  assert.equal(bindingLabel({ type: 'key', code: 'KeyW' }), 'W');
  assert.equal(bindingLabel({ type: 'key', code: 'KeyS', modifiers: ['ctrl', 'shift'] }), 'Ctrl+Shift+S');
  assert.equal(bindingLabel({ type: 'key', code: 'ArrowUp' }), 'Up');
  assert.equal(bindingLabel({ type: 'key', code: 'ShiftLeft' }), 'Shift Left');
  assert.equal(bindingLabel({ type: 'mouse', button: 2 }), 'Right Mouse');
  assert.equal(bindingLabel({ type: 'gamepad-button', index: 0 }), 'A');
  assert.equal(bindingLabel({ type: 'gamepad-button', index: 0 }, 'playstation'), 'Cross');
  assert.equal(bindingLabel({ type: 'gamepad-button', index: 3 }, 'generic'), 'Button 3');
  assert.equal(bindingLabel({ type: 'gamepad-axis', index: 1 }), 'Left Stick Y');
  assert.equal(bindingLabel({ type: 'pointer', axis: 'wheel' }), 'Mouse Wheel');
});

function pointer(target, type, id, x, y, pointerType = 'touch') {
  target.dispatchEvent(Object.assign(new Event(type), { pointerId: id, clientX: x, clientY: y, pointerType }));
}

test('gestures: tap, double tap, swipe, pinch and rotate; mouse ignored; dispose detaches', () => {
  const target = new EventTarget();
  let t = 0;
  const g = new Gestures(target, { now: () => t });
  const seen = [];
  for (const type of ['tap', 'doubletap', 'swipe', 'pinch', 'rotate']) g.on(type, (e) => seen.push(e));
  pointer(target, 'pointerdown', 1, 100, 100);
  t = 50;
  pointer(target, 'pointerup', 1, 100, 100);
  assert.deepEqual(
    seen.map((e) => e.type),
    ['tap'],
  );
  t = 150;
  pointer(target, 'pointerdown', 1, 101, 100);
  t = 200;
  pointer(target, 'pointerup', 1, 101, 100);
  assert.equal(seen.at(-1).type, 'doubletap');
  seen.length = 0;
  t = 1000;
  pointer(target, 'pointerdown', 1, 100, 100);
  t = 1100;
  pointer(target, 'pointermove', 1, 220, 110);
  pointer(target, 'pointerup', 1, 220, 110);
  assert.equal(seen[0].type, 'swipe');
  assert.equal(seen[0].direction, 'right');
  assert.ok(seen[0].velocity > 1000);
  seen.length = 0;
  t = 3000;
  pointer(target, 'pointerdown', 1, 100, 100);
  pointer(target, 'pointerdown', 2, 200, 100);
  pointer(target, 'pointermove', 2, 300, 100);
  assert.equal(seen[0].type, 'pinch');
  assert.equal(seen[0].scale, 2);
  assert.equal(seen[0].x, 200);
  seen.length = 0;
  pointer(target, 'pointermove', 2, 200, 200);
  const rotate = seen.find((e) => e.type === 'rotate');
  assert.ok(rotate && rotate.rotation > 0.5, 'a quarter-ish turn clockwise');
  pointer(target, 'pointerup', 2, 200, 200);
  pointer(target, 'pointerup', 1, 100, 100);
  seen.length = 0;
  pointer(target, 'pointerdown', 9, 5, 5, 'mouse');
  pointer(target, 'pointerup', 9, 5, 5, 'mouse');
  assert.equal(seen.length, 0);
  g.dispose();
  pointer(target, 'pointerdown', 1, 0, 0);
  pointer(target, 'pointerup', 1, 0, 0);
  assert.equal(seen.length, 0);
  assert.throws(() => g.on('tap', () => {}), { code: 'disposed' });
  assert.throws(() => new Gestures(target, { tapTime: -1 }), RangeError);
});
