// The optional entries: the integer toolkit, the relief and digest entries the world loads only when used, the zone
// classifiers, and the layer descriptions of the editor entry. Each is shared with the root through the package name,
// so an app holds one copy of every module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { BiomeWorld, DEFAULT_LAYERS, LAYERS } from '../dist/index.js';
import { canonicalBytes, sha256, tileDigest } from '../dist/digest.js';
import { LAYER_ABOUT } from '../dist/editor.js';
import { createRelief } from '../dist/relief.js';
import * as toolkit from '../dist/toolkit.js';
import { holdridge, whittaker } from '../dist/zones.js';

test('the toolkit entry holds the integer helpers, and the package name resolves to the same module', async () => {
  for (const name of ['ONE', 'qmul', 'divFloor', 'atan2', 'sincos', 'qlog2', 'qexp2', 'pcg', 'hash5', 'fbm', 'ridged'])
    assert.ok(name in toolkit, name);
  assert.equal(toolkit.ONE, 65536);
  assert.equal((await import('@margoengine/biomes/toolkit')).qmul, toolkit.qmul, 'one module, not a copy');
  assert.deepEqual([...toolkit.quantizeHeights(Float32Array.of(1.5, -2), 1)], [1500, -2000]);
});

test('digest entry: tileDigest equals world.digest, over the canonical bytes of the default layers', async () => {
  const w = await BiomeWorld.create({ size: [512, 512] }),
    t = await w.tile(1, 0);
  assert.deepEqual([...t.layers], [...DEFAULT_LAYERS]);
  const bytes = canonicalBytes(t.layers.map((n) => t.layer(n)));
  assert.equal(await tileDigest(t), await w.digest(1, 0));
  assert.equal(await sha256(bytes), await w.digest(1, 0));
});

test('relief entry: createRelief is the landscape a relief world samples, with its rivers as water cells', async () => {
  const w = await BiomeWorld.create({ seed: 4, size: [512, 512], height: { relief: { coast: 'east', rivers: 1 } } }),
    relief = createRelief({ seed: 4, origin: [-256, -256], size: [512, 512], coast: 'east', rivers: 1 }),
    height = (await w.tile(0, 0)).layer('height');
  // Cells on the 4 m relief lattice take the relief's value exactly (Catmull-Rom weights 0, 1, 0, 0).
  for (const [i, j] of [
    [0, 0],
    [4, 8],
    [100, 36],
  ])
    assert.equal(height.data[j * 256 + i], relief.height(-256000 + i * 1000, -256000 + j * 1000));
  const water = relief.waterCells([-256000, -256000], 16000, 33, 33);
  assert.ok(water.some((v) => v === 1) && water.every((v) => v === 0 || v === 1));
});

test('relief entry is loaded only by worlds that use it; update to a relief height without it names the fix', () => {
  // A fresh process: nothing has loaded the relief entry yet.
  const index = new URL('../dist/index.js', import.meta.url).href,
    script = `
      const { BiomeWorld } = await import(${JSON.stringify(index)});
      const w = await BiomeWorld.create({ size: [256, 256], height: { field: () => 10 } });
      try { w.update({ height: { relief: {} } }); console.log('no error'); }
      catch (e) { console.log(e.name, e.code, e.message.includes('@margoengine/biomes/relief')); }
      await BiomeWorld.create({ size: [256, 256] });
      w.update({ height: { relief: {} } });
      console.log('after load', (await w.tile(0, 0)).layers.length);`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(out, /MargoError state true/);
  assert.match(out, new RegExp(`after load ${DEFAULT_LAYERS.length}`));
});

test('zone classifiers are imported objects; the old strings name the entry to import', async () => {
  assert.equal(whittaker.kind, 'whittaker');
  assert.equal(holdridge.kind, 'holdridge');
  await assert.rejects(BiomeWorld.create({ size: [256, 256], classifier: 'whittaker' }), (e) => {
    assert.equal(e.name, 'RangeError');
    assert.match(e.message, /@margoengine\/biomes\/zones/);
    return true;
  });
});

test('the editor entry describes every layer', () => {
  assert.deepEqual(Object.keys(LAYER_ABOUT), Object.keys(LAYERS));
  for (const [name, about] of Object.entries(LAYER_ABOUT)) assert.ok(about.length > 8, name);
});
