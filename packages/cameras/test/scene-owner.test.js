import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { PostStack } from '../../post/dist/stack.js';
import { WideAngle } from '../dist/panini.js';
import { WideAngleCube } from '../dist/wide-cube.js';

for (const [name, Type] of [['WideAngle', WideAngle], ['WideAngleCube', WideAngleCube]])
  for (const remove of [false, true])
    test(`${name} ${remove ? 'owner removal' : 'disposal'} preserves other scenes`, async (t) => {
      const e = await engine(t),
        owner = e.createScene('wide-owner');
      const make = () =>
        new Type({
          cube: {
            position: [0, 0, 0],
            view: {},
            update: () => 6,
            dispose: () => assert.fail('borrowed cube disposed'),
          },
        });
      const primary = make(),
        effect = make();
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
      const replacement = make();
      owner.use(new PostStack([replacement]));
      replacement.dispose();
      owner.removePlugin('post:stack');
      assert.equal(owner.plugins.size, 0);
    });
