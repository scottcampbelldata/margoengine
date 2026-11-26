import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionManager,
  ActionSystem,
  run,
  wait,
  setValue,
  increment,
  interpolate,
  play,
  stop,
  when,
} from '../dist/actions.js';

const box = (x) => ({ min: [x, 0, 0], max: [x + 1, 1, 1] });
const world = () => {
  const a = { name: 'a', at: 0 };
  const b = { name: 'b', at: 5 };
  let under = null;
  const system = new ActionSystem({ pick: () => under, bounds: (n) => box(n.at) });
  return { a, b, system, under: (n) => (under = n) };
};

test('pick fires on press and release over one node, not when the pointer left in between', () => {
  const { a, b, system, under } = world();
  const log = [];
  const m = system.manager(a);
  m.registerAction('pick', run(() => log.push('pick')));
  m.registerAction('pickDown', run(() => log.push('down')));
  m.registerAction('pickUp', run(() => log.push('up')));
  under(a);
  system.pointerDown({ x: 1, y: 1 });
  system.pointerUp({ x: 1, y: 1 });
  assert.deepEqual(log, ['down', 'up', 'pick']);
  log.length = 0;
  system.pointerDown({ x: 1, y: 1 });
  under(b);
  system.pointerUp({ x: 9, y: 9 });
  assert.deepEqual(log, ['down']);
});

test('doublePick needs two picks inside the window; long press fires once and suppresses pick', () => {
  const { a, system, under } = world();
  const log = [];
  const m = system.manager(a);
  m.registerAction('pick', run(() => log.push('pick')));
  m.registerAction('doublePick', run(() => log.push('double')));
  m.registerAction({ type: 'longPick', delay: 1 }, run(() => log.push('long')));
  under(a);
  const click = () => (system.pointerDown({ x: 0, y: 0 }), system.pointerUp({ x: 0, y: 0 }));
  click();
  system.update(0.1);
  click();
  assert.deepEqual(log, ['pick', 'pick', 'double']);
  log.length = 0;
  system.update(1);
  click();
  system.update(1);
  click();
  assert.deepEqual(log, ['pick', 'pick']);
  log.length = 0;
  system.pointerDown({ x: 0, y: 0 });
  system.update(0.9);
  assert.deepEqual(log, []);
  system.update(0.2);
  system.update(0.5);
  system.pointerUp({ x: 0, y: 0 });
  assert.deepEqual(log, ['long']);
});

test('pointerOver and pointerOut fire once per change', () => {
  const { a, b, system, under } = world();
  const log = [];
  for (const n of [a, b]) {
    system.manager(n).registerAction('pointerOver', run(() => log.push(n.name + ' over')));
    system.manager(n).registerAction('pointerOut', run(() => log.push(n.name + ' out')));
  }
  under(a);
  system.pointerMove({ x: 0, y: 0 });
  system.pointerMove({ x: 1, y: 0 });
  under(b);
  system.pointerMove({ x: 2, y: 0 });
  system.pointerLeave();
  assert.deepEqual(log, ['a over', 'a out', 'b over', 'b out']);
});

test('intersectEnter and intersectExit follow the boxes touching, once per change', () => {
  const { a, b, system } = world();
  const log = [];
  const m = system.manager(a);
  m.registerAction({ type: 'intersectEnter', other: b }, run((c) => log.push('enter ' + c.other.name)));
  m.registerAction({ type: 'intersectExit', other: b }, run(() => log.push('exit')));
  system.update(0.016);
  assert.deepEqual(log, []);
  b.at = 0.5;
  system.update(0.016);
  system.update(0.016);
  b.at = 2;
  system.update(0.016);
  system.update(0.016);
  assert.deepEqual(log, ['enter b', 'exit']);
});

test('keys: filter by key, list of keys, any key; repeats ignored; keyUp', () => {
  const { a, system } = world();
  const log = [];
  const m = system.manager(a);
  m.registerAction({ type: 'keyDown', key: 'e' }, run((c) => log.push('e' + c.key)));
  m.registerAction({ type: 'keyDown', key: ['x', 'y'] }, run((c) => log.push('list ' + c.key)));
  m.registerAction('keyUp', run((c) => log.push('up ' + c.key)));
  system.keyDown({ key: 'e' });
  system.keyDown({ key: 'e', repeat: true });
  system.keyDown({ key: 'y' });
  system.keyDown({ key: 'q' });
  system.keyUp({ key: 'e' });
  assert.deepEqual(log, ['ee', 'list y', 'up e']);
});

test('everyFrame fires on each update and a unregistered trigger stops', () => {
  const m = new ActionManager({});
  let n = 0;
  m.registerAction('everyFrame', run(() => n++));
  m.update(0.1);
  m.update(0.1);
  assert.equal(n, 2);
  assert.equal(m.unregister('everyFrame'), 1);
  m.update(0.1);
  assert.equal(n, 2);
});

test('then() chains run in order, wait for timed actions, and a false condition ends the firing', () => {
  const target = { v: 0, pos: [0, 0, 0], on: true };
  const log = [];
  const m = new ActionManager({});
  m.registerAction('pick', interpolate(target, 'v', 10, 1))
    .then(run(() => log.push('after tween ' + target.v)))
    .then(setValue(target, 'on', false))
    .then(run(() => log.push('never')), when(target, 'on', '==', true));
  m.fire('pick');
  assert.equal(m.running, 1);
  m.update(0.5);
  assert.equal(target.v, 5);
  assert.deepEqual(log, []);
  m.update(0.5);
  assert.deepEqual(log, ['after tween 10']);
  assert.equal(target.on, false);
  assert.equal(m.running, 0);
});

test('actions: setValue, increment, vector interpolate with ease, wait, play and stop', () => {
  const t = { v: 1, pos: [0, 0, 0], o: { x: 1 } };
  const calls = [];
  const player = { play: (...a) => calls.push(['play', ...a]), stop: () => calls.push(['stop']) };
  const m = new ActionManager({});
  m.registerAction('pick', setValue(t, 'o.x', 7))
    .then(increment(t, 'v', 2))
    .then(increment(t, 'v'))
    .then(wait(1))
    .then(interpolate(t, 'pos', [2, 4, 6], 2, (k) => k * k))
    .then(play(player, 'spin'))
    .then(stop(player));
  m.fire('pick');
  assert.equal(t.o.x, 7);
  assert.equal(t.v, 4);
  m.update(0.5);
  m.update(0.5);
  m.update(1);
  assert.deepEqual(t.pos, [0.5, 1, 1.5]);
  assert.deepEqual(calls, []);
  m.update(1);
  assert.deepEqual(t.pos, [2, 4, 6]);
  assert.deepEqual(calls, [['play', 'spin'], ['stop']]);
});

test('step mode runs one link per firing and wraps', () => {
  const m = new ActionManager({});
  const log = [];
  m.registerAction('pick', run(() => log.push('on')), undefined, 'step').then(run(() => log.push('off')));
  m.fire('pick');
  m.fire('pick');
  m.fire('pick');
  assert.deepEqual(log, ['on', 'off', 'on']);
});

test('invalid input and disposal throw coded errors; Symbol.dispose works', () => {
  const m = new ActionManager({});
  assert.throws(() => m.registerAction('nope', () => {}), { name: 'RangeError', message: /Unknown action trigger/ });
  assert.throws(() => m.registerAction({ type: 'intersectEnter' }, () => {}), { name: 'RangeError', message: /other node/ });
  assert.throws(() => m.registerAction({ type: 'longPick', delay: -1 }, () => {}), { name: 'RangeError', message: /delay/ });
  assert.throws(() => m.registerAction('pick', 3), { name: 'TypeError' });
  assert.throws(() => m.update(-1), { name: 'RangeError', message: /dt/ });
  assert.throws(() => new ActionSystem().pointerMove({ x: 0, y: 0 }), { message: /pick option/ });
  m[Symbol.dispose]();
  assert.throws(() => m.fire('pick'), { name: 'MargoError', code: 'disposed' });
  const s = new ActionSystem();
  s.dispose();
  assert.throws(() => s.manager({}), { name: 'MargoError', code: 'disposed' });
});

test('property paths cannot reach prototypes, must exist, and accessors on a prototype still work', () => {
  for (const path of ['__proto__.polluted', 'constructor.prototype.polluted', 'a.__proto__', 'prototype', 'a..b', '']) {
    assert.throws(() => setValue({ a: {} }, path, 1), { name: 'RangeError', message: /not allowed/ });
    assert.throws(() => increment({}, path), { name: 'RangeError' });
    assert.throws(() => interpolate({}, path, 1, 1), { name: 'RangeError' });
    assert.throws(() => when({}, path, '==', 1), { name: 'RangeError' });
  }
  assert.equal({}.polluted, undefined);
  assert.throws(() => setValue({}, 'missing.x', 1)(), { name: 'RangeError', message: /does not lead to an object/ });
  assert.throws(() => setValue({ a: null }, 'a.x', 1)(), { name: 'RangeError' });
  assert.throws(() => setValue({ a: {} }, 'a.nope', 1)(), { name: 'RangeError', message: /existing property/ });
  class P {
    get x() {
      return this._x;
    }
    set x(v) {
      this._x = v;
    }
  }
  const node = { position: new P() };
  setValue(node, 'position.x', 4)();
  assert.equal(node.position.x, 4);
  assert.equal({}.polluted, undefined);
});
