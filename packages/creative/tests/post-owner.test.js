import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { PostProcessing } from '../dist/post.js';
import { PostStack } from '../../post/dist/stack.js';
import { Painterly } from '../dist/paint.js';

for (const stacked of [false, true])
  for (const remove of [false, true])
    test(`PostProcessing ${stacked ? 'stacked' : 'standalone'} ${remove ? 'owner removal' : 'disposal'} preserves other scenes`, async (t) => {
      const e = await engine(t),
        owner = e.createScene('creative-post-owner');
      e.gpu.createComputePipeline = () => ({ getBindGroupLayout: () => ({}) });
      const primary = new PostProcessing(),
        effect = new PostProcessing();
      const attach = (scene, child) => scene.use(stacked ? new PostStack([child]) : child);
      attach(e, primary);
      attach(owner, effect);
      // A restore releases GPU resources, not the plugin's registration or passes.
      const uniform = effect.uniform;
      effect.onDeviceRestored(e);
      assert.notEqual(effect.uniform, uniform);
      assert.equal(e.sceneOf(effect) === owner, true);
      if (remove) owner.removePlugin(effect.name);
      else effect.dispose();
      effect.dispose();
      assert.equal(e.sceneOf(effect) === undefined, true, 'effect remains registered');
      assert.equal(e.scene.plugins.get(primary.name) === primary, true, 'default effect was removed');
      owner.removePlugin('post:stack');
      assert.equal(owner.plugins.size, 0);
      const replacement = new PostProcessing();
      attach(owner, replacement);
      replacement.dispose();
      owner.removePlugin('post:stack');
      assert.equal(owner.plugins.size, 0);
    });

for (const remove of [false, true])
  test(`Painterly ${remove ? 'owner removal' : 'disposal'} preserves other scenes`, async (t) => {
    const e = await engine(t),
      owner = e.createScene('paint-owner');
    const primary = new Painterly(),
      effect = new Painterly();
    e.use(new PostStack([primary]));
    owner.use(new PostStack([effect]));
    effect.onDeviceRestored(e);
    assert.equal(e.sceneOf(effect) === owner, true);
    if (remove) owner.removePlugin(effect.name);
    else effect.dispose();
    effect.dispose();
    assert.equal(e.sceneOf(effect) === undefined, true, 'effect remains registered');
    assert.equal(e.scene.plugins.get(primary.name) === primary, true, 'default effect was removed');
    owner.removePlugin('post:stack');
    const replacement = new Painterly();
    owner.use(new PostStack([replacement]));
    replacement.dispose();
    owner.removePlugin('post:stack');
    assert.equal(owner.plugins.size, 0);
  });
