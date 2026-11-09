import test from 'node:test';
import assert from 'node:assert/strict';
import { animatorGLB, animatorRun, RIGGED_FIGURE } from '../../../tests/support/animator-rig.js';

test('actual RiggedFigure leg carries its intermediate joint while solving endpoint IK', async () => {
  const data = animatorGLB(RIGGED_FIGURE),
    f = await animatorRun(data, { initial: 'idle', states: { idle: 'Animation 0' } });
  try {
    // Original file hierarchy is 3 -> 4 -> 5 -> 6; solve on 3/4/6 without removing joint 5.
    assert.ok(data.doc.nodes[4].children.includes(5));
    assert.ok(data.doc.nodes[5].children.includes(6));
    f.step(0);
    const local = (id) => [...f.translation(id), ...f.rotation(id)],
      before = local(5);
    const hip = f.world(3),
      ankle = f.world(6),
      knee = f.world(4);
    const target = ankle.map((v, k) => hip[k] + (v - hip[k]) * 0.9);
    const pole = [knee[0], knee[1], knee[2] + 1];
    const remove = f.animator.addFootIK({ hip: 3, knee: 4, ankle: 6, pole, raycast: () => ({ position: target }) });
    f.step(0);
    assert.deepEqual(local(5), before, 'intermediate local transform is carried without rewrites');
    const after = f.world(6);
    assert.ok(Math.hypot(...after.map((v, k) => v - target[k])) < 1e-5, `${after} vs ${target}`);
    assert.equal(f.store.parents[f.node(6).id], f.node(5).id);
    remove();
  } finally {
    f.release();
  }
});

test('IK rejects an unordered or disconnected ancestry with coded help before changing the rig', async () => {
  const f = await animatorRun(animatorGLB(RIGGED_FIGURE), { initial: 'idle', states: { idle: 'Animation 0' } });
  try {
    for (const [hip, knee, ankle] of [
      [3, 3, 6],
      [3, 6, 4],
      [3, 4, 10],
    ])
      assert.throws(
        () => f.animator.addFootIK({ hip, knee, ankle, pole: [0, 0, 1], raycast() {} }),
        (e) => e.code === 'unsupported' && /ancestry.*https:\/\/margoengine.com\/errors#geometry/.test(e.message),
      );
    f.step(0);
  } finally {
    f.release();
  }
});
