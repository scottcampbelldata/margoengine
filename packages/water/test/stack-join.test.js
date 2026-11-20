// Caustics.attach, Underwater.attach and ParticleLiquid.attach join the scene's PostStack (GAP-POST-ADD1): before, a
// scene that already had a PostStack refused them on the repeated plugin name 'post:stack'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { PostStack } from '../../post/dist/stack.js';
import { Water } from '../dist/index.js';
import { Caustics } from '../dist/caustics.js';
import { Underwater } from '../dist/underwater.js';
import { ParticleLiquid } from '../dist/liquid.js';

/** A stackable stand-in that draws nothing. */
const other = (kind) => ({
  name: 'other-' + kind,
  setup() {},
  joinStack: () => ({ kind, render() {} }),
});
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

for (const [name, attach] of [
  ['Caustics', (e) => Caustics.attach(e, { surface: new Water() })],
  ['Underwater', (e) => Underwater.attach(e, { surface: new Water() })],
  ['ParticleLiquid', (e) => ParticleLiquid.attach(e, { particles: { positions } })],
])
  test(`${name}.attach joins the scene's PostStack after its HDR effects and leaves it when disposed`, async (t) => {
    const e = await engine(t),
      first = other('hdr'),
      last = other('ldr'),
      stack = PostStack.attach(e, [first, last]);
    const effect = attach(e);
    assert.equal(e.scene.plugins.get('post:stack'), stack);
    assert.deepEqual(stack.effects, [first, effect, last]);
    effect.dispose();
    assert.deepEqual(stack.effects, [first, last]);
    assert.equal(e.scene.plugins.get('post:stack'), stack);
    stack.dispose();
    const alone = attach(e);
    assert.ok(e.scene.plugins.get('post:stack') instanceof PostStack);
    alone.dispose();
    assert.equal(e.scene.plugins.size, 0);
  });
