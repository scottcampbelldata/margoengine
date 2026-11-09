import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { ComputePass, storage } from '../dist/index.js';
import { ScenePass } from '../dist/pass.js';
import { RawShaders } from '../dist/raw.js';

for (const [name, make] of [
  [
    'ComputePass',
    () => {
      const out = storage(1, 'u32');
      return new ComputePass(1, (i) => out.store(i, 1));
    },
  ],
  ['ScenePass', () => new ScenePass({ outputs: { color: 'rgba16float' } })],
  ['RawShaders', () => new RawShaders()],
])
  for (const remove of [false, true]) {
    test(`${name} ${remove ? 'owner removal' : 'direct disposal'} frees its scene registration`, async (t) => {
      const e = await engine(t),
        owner = e.createScene('shader-owner'),
        effect = make();
      let primaryDisposals = 0;
      const primary = {
        name: effect.name,
        setup() {},
        dispose() {
          primaryDisposals++;
        },
      };
      e.use(primary);
      owner.use(effect);
      if (effect.onDeviceRestored) effect.onDeviceRestored(e);
      assert.equal(e.sceneOf(effect) === owner, true);
      if (remove) owner.removePlugin(effect.name);
      else effect.dispose();
      effect.dispose();
      assert.equal(e.sceneOf(effect) === undefined, true, 'disposed plugin retains its owner');
      assert.equal(owner.plugins.size, 0, 'disposed plugin remains registered');
      assert.equal(e.scene.plugins.get(primary.name), primary, 'same-name default plugin was removed');
      assert.equal(primaryDisposals, 0, 'disposed another scene plugin');
      const replacement = { name: effect.name, setup() {}, dispose() {} };
      owner.use(replacement);
      owner.removePlugin(replacement.name);
    });
  }
