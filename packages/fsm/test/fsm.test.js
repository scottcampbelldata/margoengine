import test from 'node:test';
import assert from 'node:assert/strict';
import {StateMachine} from '../dist/index.js';
test('hierarchical transitions keep shared parents, bubble events and expose cross-fade progress', () => {
  const calls = [], states = {root: {enter: () => calls.push('root+'), exit: () => calls.push('root-')}, idle: {parent: 'root', enter: () => calls.push('idle+'), exit: () => calls.push('idle-')}, run: {parent: 'root', enter: () => calls.push('run+')}, paused: {enter: () => calls.push('paused+')}};
  const machine = new StateMachine(states, 'idle', {}, [{from: 'idle', to: 'run', event: 'go', duration: 1}, {from: 'root', to: 'paused', event: 'pause'}]);
  assert.equal(machine.send('unknown'), false); machine.send('go'); machine.update(0.25); assert.equal(machine.blend, 0.25); assert.equal(machine.previous, 'idle');
  assert.deepEqual(calls, ['root+', 'idle+', 'idle-', 'run+']); machine.update(1); assert.equal(machine.blend, 1); assert.equal(machine.previous, null);
  machine.send('pause'); assert.deepEqual(calls.slice(-2), ['root-', 'paused+']); assert.throws(() => machine.goto('missing'), /Invalid/);
  assert.throws(() => new StateMachine({a: {parent: 'b'}, b: {parent: 'a'}}, 'a', {}), /cycle/);
});
