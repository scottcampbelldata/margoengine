import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { boneStiffness, createTissueFixture as system, elastic, length, mass, step } from './tissue-fixture.js';

const bound = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 16 * 2 ** -23 * length, `${actual} versus ${expected}`);

await Physics.load();

test('live kinematic skeletal positions drive an attachment through the bodies field', async () => {
  const { world, tissue, bone } = await system(false, [0.125, 0, 0.03125]);
  world.advance(1);
  assert.deepEqual(tissue.particlePosition(3), [0.125, 0, 0.53125]);
  bone.setPosition([0.25, 0.125, 0.0625]);
  world.advance(2);
  assert.deepEqual(tissue.particlePosition(3), [0.25, 0.125, 0.5625]);
  bone.setRotation([0, 1, 0, 0]);
  world.advance(3);
  assert.deepEqual(tissue.particlePosition(3), [0.25, 0.125, -0.4375]);
  bone.setType('dynamic');
  assert.throws(() => world.advance(4), /Tissue bones must remain fixed or kinematic/);
});

test('a sliding attachment transfers the analytic normal response and leaves tangential motion free', async () => {
  const first = await system(true, [0, 0, 0.03125]);
  const second = await system(true, [0.5, 0, 0.03125]);
  const saved = first.world.takeSnapshot();
  first.world.advance(1);
  second.world.advance(1);
  const impulse = (step * boneStiffness * 0.03125) / (1 + (step * step * boneStiffness) / mass);
  const elasticStiffness = (elastic * length) / 6;
  const expected = length + (step * impulse) / (mass + step * step * elasticStiffness);
  bound(first.tissue.particlePosition(3)[2], expected);
  assert.deepEqual(
    second.tissue.particlePosition(3),
    first.tissue.particlePosition(3),
    'sliding ignores a tangential bone shift',
  );
  const replay = await system(true, [0, 0, 0.03125]);
  replay.world.restoreSnapshot(saved.bytes);
  replay.world.advance(1);
  assert.equal(replay.world.hash(), first.world.hash());
});
