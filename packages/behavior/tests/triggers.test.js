import test from 'node:test';
import assert from 'node:assert/strict';
import { TriggerSystem, sphereRegion, boxRegion, touchesRegion, triggerStateKey } from '../dist/triggers.js';
import { Blackboard } from '../dist/index.js';

test('namespace and agent text cannot alias another memory key', () => {
  assert.notEqual(triggerStateKey('string:a', 'foo').name, triggerStateKey('a', 'foo:string').name);
});

test('sphere/box contact includes boundaries and agent radius but excludes expanded-box corner false positives', () => {
  const sphere = sphereRegion([0, 0, 0], 5),
    box = boxRegion([-1, -1, -1], [1, 1, 1]);
  assert.equal(touchesRegion(sphere, [3, 4, 0]), true);
  assert.equal(touchesRegion(sphere, [6, 0, 0]), false);
  assert.equal(touchesRegion(sphere, [6, 0, 0], 1), true);
  assert.equal(touchesRegion(box, [2, 1, 0], 1), true);
  assert.equal(touchesRegion(box, [2, 2, 0], 1), false);
  assert.equal(touchesRegion(box, [2, 2, 0], Math.SQRT2), true);
  assert.equal(touchesRegion(box, [1, 1, 1]), true);
  assert.equal(touchesRegion(boxRegion([0, 0, 0], [0, 0, 0]), [0, 0, 0]), true);
  const huge = Number.MAX_VALUE;
  assert.equal(touchesRegion(sphereRegion([-huge, 0, 0], huge * 0.1), [huge, 0, 0], huge), false);
});
test('enter/stay/exit transitions, region movement, disabled/removed agents and blackboard memory', () => {
  const board = new Blackboard(),
    agent = { id: 'npc', position: [0, 0, 0], blackboard: board };
  const system = new TriggerSystem()
    .set('sphere', sphereRegion([0, 0, 0], 1))
    .set('box', boxRegion([-1, -1, -1], [1, 1, 1]));
  const phases = () => system.events.map((event) => `${event.region}:${event.phase}`);
  system.update([agent]);
  assert.deepEqual(phases(), ['sphere:enter', 'box:enter']);
  assert.deepEqual(board.get(triggerStateKey('npc')).inside, ['sphere', 'box']);
  system.update([agent]);
  assert.deepEqual(phases(), ['sphere:stay', 'box:stay']);
  agent.position = [1, 1, 0];
  system.update([agent]);
  assert.deepEqual(phases(), ['box:stay', 'sphere:exit']);
  system.set('box', boxRegion([5, 5, 5], [6, 6, 6]));
  system.update([agent]);
  assert.deepEqual(phases(), ['box:exit']);
  agent.position = [0, 0, 0];
  system.update([agent]);
  assert.deepEqual(phases(), ['sphere:enter']);
  system.setEnabled('sphere', false);
  system.update([agent]);
  assert.deepEqual(phases(), ['sphere:exit']);
  system.setEnabled('sphere', true);
  system.update([agent]);
  agent.enabled = false;
  system.update([agent]);
  assert.deepEqual(phases(), ['sphere:exit']);
  agent.enabled = true;
  system.update([agent]);
  system.delete('sphere');
  system.update([agent]);
  assert.deepEqual(phases(), ['sphere:exit']);
  system.set('sphere', sphereRegion([0, 0, 0], 1));
  system.update([agent]);
  system.update([]);
  assert.deepEqual(phases(), ['sphere:exit']);
  assert.deepEqual(board.get(triggerStateKey('npc')).inside, []);
  system.update([]);
  assert.deepEqual(system.events, []);
});
test('shared blackboards distinguish string/numeric ids and system namespaces; geometry is detached', () => {
  const board = new Blackboard(),
    center = [0, 0, 0],
    system = new TriggerSystem('squad').set('zone', { type: 'sphere', center, radius: 1 });
  center[0] = 100;
  const agents = [
    { id: 1, position: [0, 0, 0], blackboard: board },
    { id: '1', position: [10, 0, 0], blackboard: board },
  ];
  system.update(agents);
  assert.deepEqual(board.get(triggerStateKey(1, 'squad')).inside, ['zone']);
  assert.deepEqual(board.get(triggerStateKey('1', 'squad')).inside, []);
  assert.deepEqual(board.get(triggerStateKey(1)).inside, []);
  const other = new Blackboard();
  agents[0].blackboard = other;
  system.update(agents);
  assert.deepEqual(board.get(triggerStateKey(1, 'squad')).inside, []);
  assert.deepEqual(other.get(triggerStateKey(1, 'squad')).inside, ['zone']);
  system[Symbol.dispose]();
  system.dispose();
  assert.deepEqual(other.get(triggerStateKey(1, 'squad')).inside, []);
  assert.equal(system.events[0].phase, 'exit');
  assert.throws(() => system.update(agents), /disposed/);
});
test('bad updates leave contacts intact and invalid geometry rejects with a repair', () => {
  const system = new TriggerSystem().set('x', sphereRegion([0, 0, 0], 1)),
    a = { id: 'a', position: [0, 0, 0] };
  system.update([a]);
  const before = system.events;
  assert.throws(() => system.update([a, a]), /unique/);
  assert.equal(system.events, before);
  assert.throws(() => system.update([{ ...a, position: [NaN, 0, 0] }]), /finite/);
  assert.equal(system.events, before);
  system.update([a]);
  assert.equal(system.events[0].phase, 'stay');
  assert.throws(() => sphereRegion([0, 0, 0], -1), /radius/);
  assert.throws(() => boxRegion([1, 0, 0], [0, 0, 0]), /bounds/);
  assert.throws(() => system.setEnabled('absent', false), /register/);
  assert.throws(() => triggerStateKey(Infinity), /finite/);
});
