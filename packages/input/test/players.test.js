import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPlayers } from '../dist/players.js';

const ACTIONS = {
  move: [
    { type: 'key', code: 'KeyD' },
    { type: 'key', code: 'KeyA', scale: -1 },
    { type: 'gamepad-axis', index: 0 },
  ],
  jump: [
    { type: 'key', code: 'Space' },
    { type: 'gamepad-button', index: 0 },
    { type: 'touch', id: 'jump' },
  ],
  start: [
    { type: 'key', code: 'Enter' },
    { type: 'gamepad-button', index: 9 },
  ],
  pause: [{ type: 'key', code: 'Escape' }],
};
const SCHEMES = {
  arrows: {
    move: [
      { type: 'key', code: 'ArrowRight' },
      { type: 'key', code: 'ArrowLeft', scale: -1 },
    ],
    jump: [{ type: 'key', code: 'ArrowUp' }],
    start: [{ type: 'key', code: 'ShiftRight' }],
  },
};
const pad = () => ({ axes: [0], buttons: Array.from({ length: 10 }, () => ({ value: 0 })) });
function rig(options = {}) {
  const target = new EventTarget(),
    pads = [pad(), pad()],
    party = new LocalPlayers(ACTIONS, { target, gamepads: () => pads, schemes: SCHEMES, ...options }),
    key = (type, code) => target.dispatchEvent(Object.assign(new Event(type), { code }));
  return { target, pads, party, key };
}

test('each player reads only their own devices', () => {
  const { party, pads, key } = rig(),
    one = party.add('keyboard'),
    two = party.add('gamepad:1'),
    three = party.add('gamepad:0');
  assert.deepEqual(
    party.players.map((p) => p.index),
    [0, 1, 2],
  );
  key('keydown', 'Space');
  pads[1].axes[0] = 1;
  pads[1].buttons[0].value = 0;
  party.update();
  assert.equal(one.input.state('jump').pressed, true);
  assert.equal(two.input.state('jump').down, false);
  assert.equal(two.input.state('move').value, 1);
  assert.equal(one.input.state('move').value, 0);
  assert.equal(three.input.state('move').value, 0);
  assert.equal(party.owner('gamepad:1'), two);
  assert.equal(party.owner('gamepad:3'), undefined);
  party.dispose();
});

test('two players share a keyboard through schemes', () => {
  const { party, key } = rig(),
    left = party.add('keyboard'),
    right = party.add('keyboard:arrows');
  key('keydown', 'ArrowLeft');
  key('keydown', 'KeyD');
  party.update();
  assert.equal(left.input.state('move').value, 1);
  assert.equal(right.input.state('move').value, -1);
  party.dispose();
});

test('an action with no binding on the player devices reads 0', () => {
  const { party, key } = rig(),
    player = party.add('gamepad:0');
  key('keydown', 'Escape');
  party.update();
  assert.equal(player.input.state('pause').down, false);
  party.dispose();
});

test('touch and several devices on one player', () => {
  const { party, pads, key } = rig(),
    player = party.add();
  assert.deepEqual(player.devices, []);
  party.assign(player, 'keyboard');
  party.assign(player, 'gamepad:1');
  party.assign(player, 'touch');
  assert.deepEqual(player.devices, ['keyboard', 'gamepad:1', 'touch']);
  pads[1].buttons[0].value = 1;
  party.update();
  assert.equal(player.input.state('jump').pressed, true);
  pads[1].buttons[0].value = 0;
  key('keydown', 'Space');
  party.update();
  assert.equal(player.input.state('jump').down, true);
  party.unassign('keyboard');
  party.update();
  assert.equal(player.input.state('jump').released, true);
  assert.equal(party.owner('keyboard'), undefined);
  party.unassign('keyboard');
  const button = Object.assign(new EventTarget(), { setPointerCapture() {} });
  player.input.bindTouchButton(button, 'jump');
  button.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 1 }));
  party.update();
  assert.equal(player.input.state('jump').pressed, true);
  party.dispose();
});

test('a press on a free device joins, and that press is no action', () => {
  const { party, pads, key } = rig({ joinAction: 'start' }),
    joined = [];
  party.on('join', (event) => joined.push(event));
  party.update();
  assert.equal(party.players.length, 0);
  pads[1].buttons[9].value = 1;
  party.update();
  assert.equal(party.players.length, 1);
  assert.equal(joined[0].device, 'gamepad:1');
  const player = joined[0].player;
  assert.equal(player.input.state('start').down, true);
  assert.equal(player.input.state('start').pressed, false, 'the join press does not reach the game');
  pads[1].buttons[9].value = 0;
  party.update();
  pads[1].buttons[9].value = 1;
  party.update();
  assert.equal(party.players.length, 1, 'an owned device joins nobody');
  assert.equal(player.input.state('start').pressed, true);
  key('keydown', 'Enter');
  party.update();
  key('keydown', 'ShiftRight');
  party.update();
  assert.deepEqual(
    party.players.map((p) => p.devices[0]),
    ['gamepad:1', 'keyboard', 'keyboard:arrows'],
  );
  party.dispose();
});

test('a held join key does not press its action through key repeat', () => {
  const { party, target, key } = rig({ joinAction: 'start' });
  key('keydown', 'Enter');
  party.update();
  const player = party.owner('keyboard');
  target.dispatchEvent(Object.assign(new Event('keydown'), { code: 'Enter', repeat: true }));
  party.update();
  assert.equal(player.input.state('start').pressed, false);
  party.dispose();
});

test('joining stops at maxPlayers, and add refuses past it', () => {
  const { party, pads } = rig({ joinAction: 'start', maxPlayers: 1 });
  pads[0].buttons[9].value = 1;
  pads[1].buttons[9].value = 1;
  party.update();
  assert.equal(party.players.length, 1);
  assert.throws(() => party.add('keyboard'), RangeError);
  party.dispose();
});

test('slots stay put, a free slot is reused and a removed player frees their devices', () => {
  const { party } = rig(),
    left = [];
  party.on('leave', (event) => left.push(event.player.index));
  const a = party.add('gamepad:0'),
    b = party.add('gamepad:1');
  party.remove(a);
  assert.deepEqual(left, [0]);
  assert.equal(b.index, 1);
  assert.equal(party.owner('gamepad:0'), undefined);
  assert.throws(() => a.input.update(), /disposed/);
  party.remove(a);
  assert.deepEqual(left, [0], 'removing twice does nothing');
  assert.throws(() => party.assign(a, 'keyboard'), TypeError);
  const c = party.add('gamepad:0');
  assert.equal(c.index, 0);
  party.dispose();
});

test('an unplugged gamepad is lost, its player stays and it returns to them', () => {
  const { party, pads } = rig(),
    events = [];
  for (const type of ['lost', 'regained']) party.on(type, (e) => events.push([e.type, e.player.index, e.device]));
  const player = party.add('gamepad:1');
  pads[1].buttons[0].value = 1;
  party.update();
  assert.equal(player.input.state('jump').down, true);
  const held = pads[1];
  pads[1] = null;
  party.update();
  assert.equal(player.connected, false);
  assert.equal(player.input.state('jump').released, true);
  party.update();
  assert.deepEqual(events, [['lost', 0, 'gamepad:1']], 'told once');
  pads[1] = { ...held, connected: false };
  party.update();
  assert.equal(events.length, 1, 'a slot marked disconnected is still gone');
  pads[1] = held;
  party.update();
  assert.equal(player.connected, true);
  assert.deepEqual(events[1], ['regained', 0, 'gamepad:1']);
  party.unassign('gamepad:1');
  party.dispose();
});

test('unassigning a lost gamepad clears the lost mark', () => {
  const { party, pads } = rig(),
    player = party.add('gamepad:1');
  pads[1] = null;
  party.update();
  party.unassign('gamepad:1');
  assert.equal(player.connected, true);
  party.dispose();
});

test('rumble reaches the gamepads of that player alone', async () => {
  const { party, pads } = rig(),
    played = [];
  pads[1].vibrationActuator = { playEffect: async (_, effect) => played.push(effect.duration) };
  const one = party.add('keyboard'),
    two = party.add('gamepad:1');
  assert.equal(await one.rumble(100), false);
  assert.equal(await two.rumble(100, 0.5), true);
  assert.deepEqual(played, [100]);
  party.dispose();
});

test('contexts and rebinding belong to each player', () => {
  const { party, key } = rig({ contexts: { game: ['jump'] } }),
    one = party.add('keyboard'),
    two = party.add('keyboard:arrows');
  one.input.setContext('game', false);
  key('keydown', 'Space');
  key('keydown', 'ArrowUp');
  party.update();
  assert.equal(one.input.state('jump').down, false);
  assert.equal(two.input.state('jump').down, true);
  two.input.rebind('jump', [{ type: 'key', code: 'KeyK' }]);
  party.update();
  assert.equal(two.input.state('jump').released, true);
  party.dispose();
});

test('an event handler may remove a player while update walks them', () => {
  const { party, pads } = rig();
  const a = party.add('gamepad:0');
  party.add('gamepad:1');
  party.on('lost', ({ player }) => party.remove(player));
  pads[0] = null;
  pads[1] = null;
  party.update();
  assert.equal(party.players.length, 0);
  assert.throws(() => a.input.update(), /disposed/);
  party.dispose();
});

test('dispose removes every listener and later calls throw', () => {
  const target = new EventTarget(),
    active = new Set(),
    add = target.addEventListener.bind(target),
    remove = target.removeEventListener.bind(target);
  target.addEventListener = (type, listener) => {
    add(type, listener);
    active.add(listener);
  };
  target.removeEventListener = (type, listener) => {
    remove(type, listener);
    active.delete(listener);
  };
  const party = new LocalPlayers(ACTIONS, { target, gamepads: () => [], joinAction: 'start' });
  const off = party.on('join', () => assert.fail('no longer listening'));
  off();
  party.add('keyboard');
  party.add('touch');
  assert.ok(active.size > 0);
  party.dispose();
  party.dispose();
  assert.equal(active.size, 0);
  assert.throws(() => party.update(), /disposed/);
  assert.throws(() => party.add('keyboard'), /disposed/);
});

test('options, devices and owners are checked', () => {
  const options = { target: new EventTarget(), gamepads: () => [] };
  assert.throws(() => new LocalPlayers(ACTIONS, { ...options, maxPlayers: 0 }), RangeError);
  assert.throws(() => new LocalPlayers(ACTIONS, { ...options, gamepadSlots: 1.5 }), RangeError);
  assert.throws(() => new LocalPlayers(ACTIONS, { ...options, joinAction: 'nope' }), TypeError);
  assert.throws(() => new LocalPlayers({ a: [{ type: 'nope' }] }, options), TypeError);
  assert.throws(
    () => new LocalPlayers(ACTIONS, { ...options, schemes: { s: { nope: [{ type: 'key', code: 'KeyA' }] } } }),
    TypeError,
  );
  assert.throws(() => new LocalPlayers(ACTIONS, { ...options, schemes: { s: { jump: [{ type: 'nope' }] } } }), TypeError);
  const { party } = rig();
  party.add('keyboard');
  for (const device of ['mouse', 'gamepad:x', 'keyboard:nope', 'gamepad:'])
    assert.throws(() => party.add(device), TypeError, device);
  assert.throws(() => party.add('keyboard'), /already owns/);
  assert.equal(party.players.length, 1, 'a refused add adds nobody');
  party.dispose();
});
