import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { PostStack } from '../../post/dist/stack.js';
import { NodePass, inputColor } from '../dist/index.js';

for (const remove of [false, true])
  test(`NodePass ${remove ? 'owner removal' : 'disposal'} preserves other scenes`, async (t) => {
    const e = await engine(t),
      owner = e.createScene('node-post-owner');
    const make = () => new NodePass(inputColor(), { name: 'audit-node-pass' });
    const primary = make(),
      effect = make();
    e.use(new PostStack([primary]));
    owner.use(new PostStack([effect]));
    effect.onDeviceRestored();
    assert.equal(e.sceneOf(effect) === owner, true);
    if (remove) owner.removePlugin(effect.name);
    else effect.dispose();
    effect.dispose();
    assert.equal(e.sceneOf(effect) === undefined, true, 'effect remains registered');
    assert.equal(e.scene.plugins.get(primary.name) === primary, true, 'default effect was removed');
    owner.removePlugin('post:stack');
    const replacement = make();
    owner.use(new PostStack([replacement]));
    replacement.dispose();
    owner.removePlugin('post:stack');
    assert.equal(owner.plugins.size, 0);
  });
