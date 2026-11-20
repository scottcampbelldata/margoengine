// Painterly.attach and AnisotropicPainterly.attach join the scene's PostStack (GAP-POST-ADD1): before, a scene that
// already had a PostStack refused them on the repeated plugin name 'post:stack'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { PostStack } from '../../post/dist/stack.js';
import { Painterly } from '../dist/paint.js';
import { AnisotropicPainterly } from '../dist/paint-aniso.js';

/** A stackable stand-in that draws nothing. */
const other = (kind) => ({
  name: 'other-' + kind,
  setup() {},
  joinStack: () => ({ kind, render() {} }),
});

for (const [name, Type] of [
  ['Painterly', Painterly],
  ['AnisotropicPainterly', AnisotropicPainterly],
])
  test(`${name}.attach joins the scene's PostStack after its LDR effects and leaves it when disposed`, async (t) => {
    const e = await engine(t);
    e.gpu.createComputePipeline = () => ({ getBindGroupLayout: () => ({}) });
    const first = other('hdr'),
      last = other('ldr'),
      stack = PostStack.attach(e, [first, last]);
    const effect = Type.attach(e);
    assert.equal(e.scene.plugins.get('post:stack'), stack);
    assert.deepEqual(stack.effects, [first, last, effect]);
    effect.dispose();
    assert.deepEqual(stack.effects, [first, last]);
    assert.equal(e.scene.plugins.get('post:stack'), stack);
    stack.dispose();
    const alone = Type.attach(e);
    assert.ok(e.scene.plugins.get('post:stack') instanceof PostStack);
    alone.dispose();
    assert.equal(e.scene.plugins.size, 0);
  });
