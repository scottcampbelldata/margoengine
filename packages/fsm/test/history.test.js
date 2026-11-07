import test from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine } from '../dist/index.js';
import { ParallelRegions } from '../dist/parallel.js';

const game = (history, log = []) => {
  const hook = (name) => ({ enter: () => log.push(`${name}+`), exit: () => log.push(`${name}-`) });
  return new StateMachine(
    {
      play: { history, initial: 'explore', ...hook('play') },
      explore: { parent: 'play', ...hook('explore') },
      combat: { parent: 'play', initial: 'melee', ...hook('combat') },
      melee: { parent: 'combat', ...hook('melee') },
      ranged: { parent: 'combat', ...hook('ranged') },
      pause: hook('pause'),
    },
    'play',
    {},
    [
      { from: 'explore', to: 'combat', event: 'enemy' },
      { from: 'melee', to: 'ranged', event: 'switch' },
      { from: 'play', to: 'pause', event: 'pause' },
      { from: 'pause', to: 'play', event: 'resume' },
      { from: 'pause', to: 'explore', event: 'restart' },
    ],
  );
};
const interrupted = (history, log) => {
  const machine = game(history, log);
  for (const event of ['enemy', 'switch', 'pause', 'resume']) machine.send(event);
  return machine;
};

test('initial goes on to a child, at the start and on a transition', () => {
  const log = [],
    machine = game(undefined, log);
  assert.equal(machine.state, 'explore');
  assert.deepEqual(log, ['play+', 'explore+']);
  machine.send('enemy');
  assert.equal(machine.state, 'melee');
  assert.deepEqual(log.slice(2), ['explore-', 'combat+', 'melee+']);
});

test('deep history returns to the exact state, shallow to the child, which starts as usual, none to initial', () => {
  assert.equal(interrupted('deep').state, 'ranged');
  assert.equal(interrupted('shallow').state, 'melee');
  assert.equal(interrupted(undefined).state, 'explore');
});

test('coming back runs the enter hooks of the way in, outermost first', () => {
  const log = [],
    machine = game('deep', log);
  for (const event of ['enemy', 'switch', 'pause']) machine.send(event);
  log.length = 0;
  machine.send('resume');
  assert.deepEqual(log, ['pause-', 'play+', 'combat+', 'ranged+']);
});

test('before the first visit initial applies, and a transition straight to a child passes the memory by', () => {
  const machine = game('deep');
  machine.goto('pause');
  assert.equal(machine.memory.get('play'), 'explore');
  machine.memory.clear();
  machine.send('resume');
  assert.equal(machine.state, 'explore');
  for (const event of ['enemy', 'switch', 'pause', 'restart']) machine.send(event);
  assert.equal(machine.state, 'explore');
  // That visit ended somewhere new, and the memory says so.
  machine.send('pause');
  machine.send('resume');
  assert.equal(machine.state, 'explore');
});

test('forgetting one state brings back its initial', () => {
  const machine = game('deep');
  for (const event of ['enemy', 'switch', 'pause']) machine.send(event);
  assert.equal(machine.memory.delete('play'), true);
  machine.send('resume');
  assert.equal(machine.state, 'explore');
});

test('a parent still active was never left: its memory does not count', () => {
  const machine = new StateMachine(
    {
      menu: { history: 'shallow', initial: 'main' },
      main: { parent: 'menu' },
      sound: { parent: 'menu' },
      video: { parent: 'menu' },
      out: {},
    },
    'menu',
    {},
  );
  machine.goto('video');
  machine.goto('out');
  machine.goto('menu');
  assert.equal(machine.state, 'video');
  machine.goto('sound');
  // Inside the menu, the old memory of video does not apply: the menu goes to its initial.
  machine.goto('menu');
  assert.equal(machine.state, 'main');
});

test('a parent without initial still rests on itself, as it did', () => {
  const log = [],
    machine = new StateMachine(
      { root: {}, a: { parent: 'root', exit: () => log.push('a-') }, b: { parent: 'root' } },
      'a',
      {},
    );
  machine.goto('root');
  assert.equal(machine.state, 'root');
  assert.deepEqual(log, ['a-']);
});

test('a machine that rested on the parent itself remembers nothing, not an older child', () => {
  const machine = new StateMachine({ p: { history: 'shallow' }, a: { parent: 'p' }, out: {} }, 'a', {});
  machine.goto('out');
  assert.equal(machine.memory.get('p'), 'a');
  machine.goto('a');
  machine.goto('p');
  assert.equal(machine.state, 'p');
  machine.goto('out');
  assert.equal(machine.memory.has('p'), false);
  machine.goto('p');
  assert.equal(machine.state, 'p');
});

test('every level keeps its own memory', () => {
  const machine = new StateMachine(
    {
      outer: { history: 'shallow', initial: 'left' },
      left: { parent: 'outer' },
      inner: { parent: 'outer', history: 'shallow', initial: 'one' },
      one: { parent: 'inner' },
      two: { parent: 'inner' },
      out: {},
    },
    'outer',
    {},
  );
  machine.goto('two');
  machine.goto('out');
  machine.goto('outer');
  assert.equal(machine.state, 'two');
});

test('history on the starting state of a machine with no memory is its initial', () => {
  assert.equal(new StateMachine({ p: { history: 'deep', initial: 'c' }, c: { parent: 'p' } }, 'p', {}).state, 'c');
});

test('regions inside a remembered state resume only with their own history', () => {
  for (const [history, expected] of [
    [true, 'b'],
    [false, 'a'],
  ]) {
    const regions = new ParallelRegions(
        { r: { states: { a: {}, b: {} }, initial: 'a', transitions: [{ from: 'a', to: 'b', event: 'go' }] } },
        {},
        { history },
      ),
      machine = new StateMachine(
        { p: { history: 'deep', initial: 'held' }, held: { ...regions.asState(), parent: 'p' }, out: {} },
        'p',
        {},
        [
          { from: 'p', to: 'out', event: 'leave' },
          { from: 'out', to: 'p', event: 'back' },
        ],
      );
    machine.send('go');
    machine.send('leave');
    machine.send('back');
    assert.equal(regions.active.r, expected);
  }
});

test('a wrong initial or history is refused', () => {
  assert.throws(() => new StateMachine({ a: { initial: 'b' }, b: {} }, 'a', {}), /Invalid initial/);
  assert.throws(() => new StateMachine({ a: { initial: 'a' } }, 'a', {}), /Invalid initial/);
  assert.throws(() => new StateMachine({ a: { initial: 'nowhere' } }, 'a', {}), /Invalid initial/);
  assert.throws(() => new StateMachine({ a: { history: 'all' } }, 'a', {}), /Invalid history/);
});
