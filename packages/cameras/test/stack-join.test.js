// WideAngle.attach and WideAngleCube.attach join the scene's PostStack (GAP-POST-ADD1): before, a scene that already had
// a PostStack refused them on the repeated plugin name 'post:stack'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { PostStack } from '../../post/dist/stack.js';
import { WideAngle } from '../dist/panini.js';
import { WideAngleCube } from '../dist/wide-cube.js';

/** A stackable stand-in that draws nothing. */
const other = (kind) => ({
  name: 'other-' + kind,
  setup() {},
  joinStack: () => ({ kind, render() {} }),
});
const cube = () => ({ position: [0, 0, 0], view: {}, update: () => 6, dispose() {} });

for (const [name, attach, kind] of [
  ['WideAngle', (e) => WideAngle.attach(e), 'ldr'],
  ['WideAngleCube', (e) => WideAngleCube.attach(e, { cube: cube() }), 'hdr'],
])
  test(`${name}.attach joins the scene's PostStack and leaves it when disposed`, async (t) => {
    const e = await engine(t),
      first = other('hdr'),
      last = other('ldr'),
      stack = PostStack.attach(e, [first, last]);
    const effect = await attach(e);
    assert.equal(e.scene.plugins.get('post:stack'), stack);
    assert.deepEqual(stack.effects, kind === 'hdr' ? [first, effect, last] : [first, last, effect]);
    effect.dispose();
    assert.deepEqual(stack.effects, [first, last]);
    assert.equal(e.scene.plugins.get('post:stack'), stack);
    stack.dispose();
    // Alone, it gets a stack of its own that goes with it.
    const alone = await attach(e);
    assert.ok(e.scene.plugins.get('post:stack') instanceof PostStack);
    alone.dispose();
    assert.equal(e.scene.plugins.size, 0);
  });
