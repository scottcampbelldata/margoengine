import test from 'node:test';
import assert from 'node:assert/strict';
import { addStateLayer } from '../dist/layers.js';
import { animatorDocument, animatorRun } from '../../../tests/support/animator-rig.js';

async function rig(t) {
  const data = animatorDocument(
    { Root: [null, 0, 0, 0], Arm: ['Root', 0, 0, 0] },
    {
      Walk: { duration: 2, fps: 1, tracks: { 'Root.translation': (s) => [s, 0, 0] } },
      Aim: { duration: 2, fps: 1, tracks: { 'Arm.translation': () => [0, 2, 0] } },
      Shoot: { duration: 2, fps: 1, tracks: { 'Arm.translation': () => [0, 4, 0] } },
    },
  );
  const f = await animatorRun(data, { initial: 'walk', states: { walk: 'Walk' } });
  t.after(() => f.release());
  return f;
}
const document = () => ({
  initial: 'aim',
  parameters: { fire: 'trigger' },
  states: { aim: 'Aim', shoot: 'Shoot' },
  transitions: [{ from: 'aim', to: 'shoot', conditions: [['fire']], duration: 0.5 }],
});

test('layer graphs switch independently, crossfade and mask while locomotion advances', async (t) => {
  const f = await rig(t);
  const upper = addStateLayer(f.animator, { graph: document(), mask: [1], weight: 0.5 });
  f.step(0.25);
  assert.equal(f.translation(0)[0], 0.25);
  assert.equal(f.translation(1)[1], 1);
  upper.graph.trigger('fire');
  f.step(0.25);
  assert.equal(upper.graph.state, 'shoot');
  assert.equal(f.animator.state, 'walk');
  assert.equal(f.translation(0)[0], 0.5);
  assert.equal(f.translation(1)[1], 1.5);
  assert.equal(upper.graph.get('fire'), false);
  upper.dispose();
  upper.dispose();
  f.step(0.25);
  assert.equal(f.translation(1)[1], 0);
  assert.equal(f.animation.playing, false);
});

test('zero-weight layers keep time; ordered additive/override layers pause and scale once', async (t) => {
  const f = await rig(t);
  const a = addStateLayer(f.animator, { graph: document(), weight: 0 });
  const b = addStateLayer(f.animator, {
    graph: { initial: 'shoot', states: { shoot: 'Shoot' } },
    weight: 0.25,
    blend: 'additive',
  });
  f.animation.options.speed = 2;
  f.step(0.25);
  assert.equal(a.graph.animator.time, 0.5);
  assert.equal(f.translation(1)[1], 1);
  a.weight = 0.5;
  f.step(0.25);
  assert.equal(f.translation(1)[1], 2);
  f.animator.playing = false;
  f.step(1);
  assert.equal(a.graph.animator.time, 1);
  b.mask = [];
  f.step(0);
  assert.equal(f.translation(1)[1], 1);
  a.weight = NaN;
  assert.throws(() => f.step(0), RangeError);
});

test('late installation retains loaded references; disposing base disposes graphs', async (t) => {
  const f = await rig(t);
  f.step(0.5);
  const upper = addStateLayer(f.animator, { graph: document(), blend: 'additive' });
  f.step(0.25);
  assert.equal(f.translation(0)[0], 0.75);
  assert.equal(f.translation(1)[1], 2);
  f.animator.dispose();
  assert.throws(() => upper.graph.set('fire', true), /disposed/);
  assert.equal(f.animation.playing, true);
});
