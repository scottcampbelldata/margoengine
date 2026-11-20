// LensDrops.attach joins the scene's PostStack (GAP-POST-ADD1-WEATHER): before, it made a one-effect stack with
// PostStack.attach, so a scene that already had a PostStack refused it on the repeated plugin name 'post:stack'
// ("Invalid plugin").
import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { PostStack } from '../../post/dist/stack.js';
import { LensDrops } from '../dist/lens.js';

/** A stackable stand-in that draws nothing. */
const other = (kind) => ({
  name: 'other-' + kind,
  setup() {},
  joinStack: () => ({ kind, render() {} }),
});

test("LensDrops.attach joins the scene's PostStack and leaves it when disposed", async (t) => {
  const e = await engine(t),
    first = other('hdr'),
    last = other('ldr'),
    stack = PostStack.attach(e, [first, last]);
  const lens = await LensDrops.attach(e, { wetness: 0.4 });
  assert.equal(e.scene.plugins.get('post:stack'), stack);
  assert.deepEqual(stack.effects, [first, lens, last]);
  lens.dispose();
  assert.deepEqual(stack.effects, [first, last]);
  assert.equal(e.scene.plugins.get('post:stack'), stack);
  stack.dispose();
  // Alone, it gets a stack of its own that goes with it.
  const alone = await LensDrops.attach(e);
  assert.ok(e.scene.plugins.get('post:stack') instanceof PostStack);
  alone.dispose();
  assert.equal(e.scene.plugins.size, 0);
});
