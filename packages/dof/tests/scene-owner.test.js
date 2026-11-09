import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { engine } from '../../../tests/support/review56-engine.js';
import { DOF } from '../dist/index.js';
import { Autofocus } from '../dist/autofocus.js';

test('DOF cleanup never removes a plugin through the active-scene facade', () => {
  for (const name of ['index', 'autofocus'])
    assert.doesNotMatch(
      readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'),
      /\bengine\??\.removePlugin\(/,
    );
});
for (const [name, make] of [
  ['DOF', () => new DOF()],
  ['Autofocus', () => new Autofocus(new DOF())],
])
  for (const remove of [false, true])
    test(`${name} ${remove ? 'owner removal' : 'direct disposal'} preserves other scenes`, async (t) => {
      const e = await engine(t),
        owner = e.createScene('dof-owner');
      e.gpu.createComputePipeline = () => ({ getBindGroupLayout: () => ({}) });
      const primary = make(),
        effect = make();
      e.use(primary);
      owner.use(effect);
      if (remove) owner.removePlugin(effect.name);
      else effect.dispose();
      effect.dispose();
      assert.equal(e.sceneOf(effect) === undefined, true, 'effect remains registered');
      assert.equal(owner.plugins.size, 0);
      assert.equal(e.scene.plugins.get(primary.name) === primary, true, 'default effect was removed');
      const replacement = make();
      owner.use(replacement);
      replacement.dispose();
      assert.equal(owner.plugins.size, 0);
    });
