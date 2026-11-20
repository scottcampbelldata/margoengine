import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { engine } from '../../../tests/support/review56-engine.js';
import { Tonemap } from '../dist/index.js';

test('Tonemap cleanup never removes a plugin through the active-scene facade', () => {
  assert.doesNotMatch(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'), /\bengine\??\.removePlugin\(/);
});
for (const remove of [false, true])
  test(`Tonemap ${remove ? 'owner removal' : 'direct disposal'} preserves other scenes`, async (t) => {
    const e = await engine(t),
      owner = e.createScene('tonemap-owner');
    const primary = new Tonemap(),
      effect = new Tonemap();
    e.use(primary);
    owner.use(effect);
    if (remove) owner.removePlugin(effect.name);
    else effect.dispose();
    effect.dispose();
    assert.equal(e.sceneOf(effect) === undefined, true, 'effect remains registered');
    assert.equal(owner.plugins.size, 0);
    assert.equal(e.scene.plugins.get(primary.name) === primary, true, 'default effect was removed');
    const replacement = new Tonemap();
    owner.use(replacement);
    replacement.dispose();
    assert.equal(owner.plugins.size, 0);
  });

// KB-OWN-TONE1: a Tonemap removed by its scene, disposed or restored after a device loss kept its extensions' own GPU
// objects (LocalExposure's three r32float textures and its uniform buffer) alive, with nothing left to draw them.
for (const how of ['dispose', 'removal', 'scene', 'restore'])
  test(`Tonemap ${how} releases what its extensions made on the device`, async (t) => {
    const e = await engine(t),
      owner = e.createScene('tonemap-owner'),
      calls = [],
      extension = { key: 'spy', patch: (shader) => shader, dispose: () => calls.push('dispose') },
      plain = { key: 'plain', patch: (shader) => shader },
      effect = new Tonemap({ extensions: [plain, extension] });
    owner.use(effect);
    if (how === 'dispose') effect.dispose();
    else if (how === 'removal') owner.removePlugin(effect.name);
    else if (how === 'scene') owner.dispose();
    else effect.onDeviceRestored(e);
    assert.deepEqual(calls, ['dispose']);
    if (how === 'restore') effect.dispose();
  });
