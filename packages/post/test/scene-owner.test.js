import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { FXAA, PostStack } from '../dist/index.js';

for (const stacked of [false, true])
  for (const remove of [false, true])
    test(`${stacked ? 'PostStack' : 'FXAA'} ${remove ? 'owner removal' : 'direct disposal'} preserves other scenes`, async (t) => {
      const e = await engine(t),
        owner = e.createScene('post-owner');
      const primaryChild = new FXAA(),
        child = new FXAA();
      const primary = stacked ? new PostStack([primaryChild]) : primaryChild;
      const effect = stacked ? new PostStack([child]) : child;
      e.use(primary);
      owner.use(effect);
      if (remove) owner.removePlugin(effect.name);
      else effect.dispose();
      effect.dispose();
      assert.equal(e.sceneOf(effect) === undefined, true);
      assert.equal(e.sceneOf(child) === undefined, true);
      assert.equal(owner.plugins.size, 0);
      assert.equal(e.scene.plugins.get(primary.name), primary);
      assert.equal(e.scene.plugins.get(primaryChild.name), primaryChild);
      const replacementChild = new FXAA();
      const replacement = stacked ? new PostStack([replacementChild]) : replacementChild;
      owner.use(replacement);
      replacement.dispose();
      assert.equal(owner.plugins.size, 0);
    });

test('PostStack excludes removed children and preserves their same-name replacements', async (t) => {
  const e = await engine(t),
    owner = e.createScene('post-owner'),
    child = new FXAA();
  const stack = new PostStack([child]);
  owner.use(stack);
  owner.removePlugin(child.name);
  const replacement = new FXAA();
  owner.use(replacement);
  // The removed child must never be used by the stack again, even when its name is reused.
  child.paint = () => assert.fail('disposed stack child rendered');
  e.render({ views: [{ scene: owner, camera: e.camera, viewport: [0, 0, 1, 1] }] });
  stack.dispose();
  assert.equal(e.sceneOf(stack) === undefined, true);
  assert.equal(owner.plugins.get(replacement.name), replacement);
  replacement.dispose();
});

test('PostStack setup failure removes only children it successfully attached', async (t) => {
  const e = await engine(t),
    owner = e.createScene('post-owner');
  const primary = new FXAA();
  e.use(primary);
  const child = new FXAA(),
    error = new Error('child setup failed');
  const broken = {
    name: 'broken-stage',
    joinStack: () => ({ kind: 'ldr', render() {} }),
    setup() {
      throw error;
    },
    dispose() {},
  };
  const stack = new PostStack([child, broken]);
  assert.throws(
    () => owner.use(stack),
    (caught) => caught === error,
  );
  assert.equal(owner.plugins.size, 0);
  assert.equal(e.sceneOf(child) === undefined, true);
  assert.equal(e.scene.plugins.get(primary.name), primary);
});
