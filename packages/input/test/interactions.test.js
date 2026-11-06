import test from 'node:test';
import assert from 'node:assert/strict';
import { Input } from '../dist/index.js';
import { Interactions } from '../dist/interactions.js';

// tick(ms) moves the clock by ms and then samples, as a game loop does.
function rig(rules, actions = { use: [{ type: 'key', code: 'KeyE' }] }, options = {}) {
  const target = new EventTarget(),
    pads = [{ axes: [], buttons: [{ value: 0 }] }],
    input = new Input(actions, { target, gamepads: () => pads, ...options });
  let time = 1000;
  const interactions = new Interactions(input, rules, { now: () => time });
  const key = (type, code = 'KeyE') => target.dispatchEvent(Object.assign(new Event(type), { code }));
  const tick = (ms = 0) => {
    time += ms;
    input.update();
    interactions.update();
  };
  return { input, interactions, key, tick, pads, target };
}
const edges = ({ started, performed, canceled, active }) => ({ started, performed, canceled, active });

test('tap performs on a quick release and cancels once held too long', () => {
  const { interactions, key, tick } = rig({ open: { type: 'tap', action: 'use', time: 200 } }),
    open = interactions.state('open');
  key('keydown');
  tick(16);
  assert.deepEqual(edges(open), { started: true, performed: false, canceled: false, active: true });
  tick(100);
  assert.deepEqual(edges(open), { started: false, performed: false, canceled: false, active: true });
  assert.equal(open.duration, 100);
  assert.equal(open.progress, 0.5);
  key('keyup');
  tick(100);
  assert.deepEqual(edges(open), { started: false, performed: true, canceled: false, active: false });
  assert.equal(open.progress, 1);
  tick(16);
  assert.equal(open.performed, false);

  key('keydown');
  tick(16);
  tick(201);
  assert.deepEqual(edges(open), { started: false, performed: false, canceled: true, active: false });
  tick(16);
  assert.equal(open.started, false, 'the same press never starts the rule again');
  key('keyup');
  tick(16);
  assert.equal(open.performed, false, 'a late release is no tap');
  key('keydown');
  tick(16);
  assert.equal(open.started, true, 'the next press does');
});

test('hold performs at its time while held, once per press, and cancels on an early release', () => {
  const { interactions, key, tick } = rig({ inspect: { type: 'hold', action: 'use', time: 400 } }),
    inspect = interactions.state('inspect');
  key('keydown');
  tick();
  tick(399);
  assert.equal(inspect.performed, false);
  assert.equal(inspect.active, true);
  tick(1);
  assert.equal(inspect.performed, true);
  tick(1000);
  assert.equal(inspect.performed, false);
  assert.equal(inspect.active, false);
  key('keyup');
  tick(16);
  assert.equal(inspect.canceled, false, 'releasing after the hold succeeded cancels nothing');

  key('keydown');
  tick();
  tick(100);
  key('keyup');
  tick(16);
  assert.equal(inspect.canceled, true);
});

test('hold with time 0 performs on the press itself', () => {
  const { interactions, key, tick } = rig({ now: { type: 'hold', action: 'use', time: 0 } });
  key('keydown');
  tick();
  assert.equal(interactions.state('now').started, true);
  assert.equal(interactions.state('now').performed, true);
});

test('slow tap performs on release only after its time', () => {
  const { interactions, key, tick } = rig({ heavy: { type: 'slow-tap', action: 'use', time: 500 } }),
    heavy = interactions.state('heavy');
  key('keydown');
  tick();
  tick(600);
  assert.equal(heavy.performed, false, 'nothing until the release');
  assert.equal(heavy.progress, 1);
  key('keyup');
  tick(16);
  assert.equal(heavy.performed, true);
  assert.equal(heavy.duration, 616);

  key('keydown');
  tick();
  tick(100);
  key('keyup');
  tick(16);
  assert.equal(heavy.canceled, true);
  assert.equal(heavy.performed, false);
});

test('double press performs on the last press and cancels on a long press or a long gap', () => {
  const { interactions, key, tick } = rig({ dash: { type: 'double-press', action: 'use', time: 200, gap: 300 } }),
    dash = interactions.state('dash');
  const tap = (held = 50) => {
    key('keydown');
    tick();
    tick(held);
    key('keyup');
    tick();
  };
  tap();
  assert.equal(dash.active, true);
  assert.equal(dash.progress, 0.5);
  tick(250);
  key('keydown');
  tick();
  assert.equal(dash.performed, true);
  key('keyup');
  tick(16);

  tap();
  tick(301);
  assert.equal(dash.canceled, true, 'the gap ran out: the app can treat this as a single press');

  key('keydown');
  tick();
  tick(201);
  assert.equal(dash.canceled, true, 'the first press was too long');
  key('keyup');
  tick(16);

  tap();
  tick(100);
  key('keydown');
  tick();
  assert.equal(dash.performed, true);
});

test('double press restarts from a press that arrives after the gap ran out within one long tick', () => {
  const { interactions, key, tick } = rig({ dash: { type: 'double-press', action: 'use' } }),
    dash = interactions.state('dash');
  key('keydown');
  tick();
  key('keyup');
  tick(50);
  key('keydown');
  tick(900);
  assert.equal(dash.canceled, true);
  assert.equal(dash.performed, false);
  tick();
  assert.equal(dash.started, true, 'that press begins a new sequence');
  key('keyup');
  tick(50);
  key('keydown');
  tick(50);
  assert.equal(dash.performed, true);
});

test('triple press counts every press', () => {
  const { interactions, key, tick } = rig({ burst: { type: 'double-press', action: 'use', count: 3 } }),
    burst = interactions.state('burst');
  for (let i = 0; i < 2; i++) {
    key('keydown');
    tick(10);
    assert.equal(burst.performed, false);
    key('keyup');
    tick(10);
  }
  key('keydown');
  tick(10);
  assert.equal(burst.performed, true);
});

test('one press drives a tap and a hold on the same action, each by its own rule', () => {
  const { interactions, key, tick } = rig({
    open: { type: 'tap', action: 'use' },
    inspect: { type: 'hold', action: 'use' },
  });
  key('keydown');
  tick();
  tick(100);
  key('keyup');
  tick();
  assert.equal(interactions.state('open').performed, true);
  assert.equal(interactions.state('inspect').canceled, true);
  key('keydown');
  tick();
  tick(250);
  assert.equal(interactions.state('open').canceled, true);
  tick(150);
  assert.equal(interactions.state('inspect').performed, true);
});

test('a rule on one binding reads that binding alone and follows a rebind', () => {
  const { input, interactions, key, tick, pads } = rig(
    {
      open: { type: 'tap', action: 'use', binding: 0 },
      inspect: { type: 'hold', action: 'use', binding: 1, time: 100 },
    },
    {
      use: [
        { type: 'key', code: 'KeyE' },
        { type: 'gamepad-button', index: 0 },
      ],
    },
  );
  pads[0].buttons[0].value = 1;
  tick();
  assert.equal(interactions.state('open').started, false, 'the gamepad is not binding 0');
  assert.equal(interactions.state('inspect').started, true);
  tick(100);
  assert.equal(interactions.state('inspect').performed, true);
  pads[0].buttons[0].value = 0;
  key('keydown');
  tick();
  assert.equal(interactions.state('open').started, true);
  assert.equal(interactions.state('inspect').started, false, 'the key is not binding 1');
  key('keyup');
  tick(10);
  input.rebind('use', [
    { type: 'key', code: 'KeyF' },
    { type: 'gamepad-button', index: 0 },
  ]);
  key('keydown', 'KeyF');
  tick();
  assert.equal(interactions.state('open').started, true, 'the rule reads what is bound there now');
  input.rebind('use', [{ type: 'key', code: 'KeyG' }]);
  tick(10);
  assert.equal(input.bindingValue('use', 1), 0, 'a binding past the end reads 0');
  assert.throws(() => input.bindingValue('nope', 0), TypeError);
});

test('an analog source presses at the threshold and releases below three quarters of it', () => {
  const { interactions, tick, pads } = rig(
    { fire: { type: 'hold', action: 'use', time: 100, threshold: 0.8 } },
    { use: [{ type: 'gamepad-button', index: 0 }] },
  );
  const fire = interactions.state('fire');
  pads[0].buttons[0].value = 0.7;
  tick();
  assert.equal(fire.started, false);
  pads[0].buttons[0].value = 0.8;
  tick();
  assert.equal(fire.started, true);
  pads[0].buttons[0].value = 0.65;
  tick(50);
  assert.equal(fire.active, true, 'noise near the press point does not end the press');
  pads[0].buttons[0].value = 0.5;
  tick(10);
  assert.equal(fire.canceled, true);
});

test('a negative action value presses like a positive one', () => {
  const { interactions, key, tick } = rig(
    { back: { type: 'tap', action: 'move' } },
    { move: [{ type: 'key', code: 'KeyS', scale: -1 }] },
  );
  key('keydown', 'KeyS');
  tick();
  assert.equal(interactions.state('back').started, true);
});

test('a context switched off mid press cancels the rule', () => {
  const { input, interactions, key, tick } = rig({ inspect: { type: 'hold', action: 'use' } }, undefined, {
    contexts: { game: ['use'] },
  });
  key('keydown');
  tick();
  assert.equal(input.bindingValue('use', 0), 1);
  tick(100);
  input.setContext('game', false);
  tick(10);
  assert.equal(interactions.state('inspect').canceled, true);
  assert.equal(input.bindingValue('use', 0), 0);
});

test('reset drops a press in progress and waits for a new one', () => {
  const { interactions, key, tick } = rig({ inspect: { type: 'hold', action: 'use' } }),
    inspect = interactions.state('inspect');
  key('keydown');
  tick();
  tick(100);
  interactions.reset();
  assert.equal(inspect.active, false);
  assert.equal(inspect.canceled, false);
  tick(1000);
  assert.equal(inspect.started, false);
  assert.equal(inspect.performed, false);
  key('keyup');
  tick();
  key('keydown');
  tick();
  assert.equal(inspect.started, true);
});

test('rules are checked when made', () => {
  const { input } = rig({});
  const bad = (rule) => () => new Interactions(input, { rule });
  assert.throws(() => new Interactions({}, {}), TypeError);
  assert.throws(() => new Interactions(input, {}, { now: 1 }), TypeError);
  assert.throws(() => new Interactions(input, { '': { type: 'tap', action: 'use' } }), TypeError);
  assert.throws(bad(null), TypeError);
  assert.throws(bad({ type: 'toString', action: 'use' }), TypeError);
  assert.throws(bad({ type: 'tap', action: 'nope' }), TypeError);
  assert.throws(bad({ type: 'tap', action: 'use', binding: -1 }), TypeError);
  assert.throws(bad({ type: 'tap', action: 'use', binding: 0.5 }), TypeError);
  assert.throws(bad({ type: 'tap', action: 'use', time: 0 }), RangeError);
  assert.throws(bad({ type: 'hold', action: 'use', time: -1 }), RangeError);
  assert.throws(bad({ type: 'hold', action: 'use', time: Infinity }), RangeError);
  assert.throws(bad({ type: 'double-press', action: 'use', count: 1 }), RangeError);
  assert.throws(bad({ type: 'double-press', action: 'use', gap: 0 }), RangeError);
  for (const threshold of [0, -1, 1.5, NaN]) assert.throws(bad({ type: 'tap', action: 'use', threshold }), RangeError);
  assert.throws(() => new Interactions(input, {}).state('nope'), TypeError);
});

// Regressions in Input found while building the rules.
test('a press and release between two updates counts for one update', () => {
  const target = new EventTarget(),
    input = new Input(
      {
        key: [{ type: 'key', code: 'KeyE' }],
        chord: [{ type: 'key', code: 'KeyS', modifiers: ['ctrl'] }],
        mouse: [{ type: 'mouse', button: 0 }],
      },
      { target, gamepads: () => [] },
    );
  const send = (type, fields) => target.dispatchEvent(Object.assign(new Event(type), fields));
  send('keydown', { code: 'KeyE' });
  send('keyup', { code: 'KeyE' });
  send('keydown', { code: 'ControlLeft' });
  send('keydown', { code: 'KeyS' });
  send('keyup', { code: 'KeyS' });
  send('keyup', { code: 'ControlLeft' });
  send('pointerdown', { pointerType: 'mouse', button: 0 });
  send('pointerup', { pointerType: 'mouse', button: 0 });
  input.update();
  for (const action of ['key', 'chord', 'mouse']) assert.equal(input.state(action).pressed, true, action);
  input.update();
  for (const action of ['key', 'chord', 'mouse']) assert.equal(input.state(action).released, true, action);
  send('keydown', { code: 'KeyE' });
  send('keyup', { code: 'KeyE' });
  input.reset();
  input.update();
  assert.equal(input.state('key').down, false, 'reset forgets it');
});

test('a touch button tapped between two updates counts for one update', () => {
  const element = Object.assign(new EventTarget(), { setPointerCapture() {} }),
    input = new Input({ fire: [{ type: 'touch', id: 'fire' }] }, { target: new EventTarget(), gamepads: () => [] });
  input.bindTouchButton(element, 'fire');
  element.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 1 }));
  element.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1 }));
  input.update();
  assert.equal(input.state('fire').pressed, true);
  input.update();
  assert.equal(input.state('fire').down, false);
});

test('a key repeat is no new press', () => {
  const target = new EventTarget(),
    input = new Input({ jump: [{ type: 'key', code: 'Space' }] }, { target, gamepads: () => [] });
  const keydown = (repeat) => target.dispatchEvent(Object.assign(new Event('keydown'), { code: 'Space', repeat }));
  keydown(false);
  input.update();
  target.dispatchEvent(new Event('blur'));
  input.update();
  assert.equal(input.state('jump').released, true);
  keydown(true);
  input.update();
  assert.equal(input.state('jump').down, false, 'the key was never pressed again after the blur');
});
