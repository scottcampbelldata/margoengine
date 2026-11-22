// Disposal leaves the scene the plugin joined, never the active one (docs/integration-fixtures.md, "Scene owner"; the
// one-argument engine.removePlugin(name) removed a same-name plugin from the active scene instead).
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLeavesOwnScene, attachIn } from '../../../tests/support/scene-owner-decoy.js';
import { createTileLayer, TileMap } from '../dist/index.js';
import { GridTileMap } from '../dist/iso.js';
import { ObjectTileMap } from '../dist/objects.js';

const set = {
  name: 'g',
  firstGid: 1,
  tileWidth: 4,
  tileHeight: 4,
  tileCount: 2,
  columns: 2,
  image: { source: 'g', width: 8, height: 4 },
};
const map = () => ({
  width: 2,
  height: 1,
  tileWidth: 4,
  tileHeight: 4,
  tilesets: [set],
  layers: [createTileLayer('floor', 2, 1, Uint32Array.of(1, 2))],
});
const atlases = () => ({ g: { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) } });
const target = { width: 8, height: 4, format: 'rgba8unorm', createView: () => ({}), destroy() {} };
for (const [label, make] of [
  ['TileMap', () => new TileMap({ map: map(), atlases: atlases(), target })],
  ['GridTileMap', () => new GridTileMap({ map: map(), atlases: atlases(), target })],
  ['ObjectTileMap', () => new ObjectTileMap({ map: map(), atlases: atlases(), target })],
])
  test(`${label} disposal leaves the scene it joined and keeps the active scene's same-name map`, (t) =>
    assertLeavesOwnScene(t, make));

test('a hidden TileMap draws nothing and costs no draws; showing it again draws it', () => {
  const touched = [];
  const device = new Proxy(
    {},
    {
      get: (_, key) => {
        touched.push(String(key));
        throw new Error('device used');
      },
    },
  );
  let run;
  const tiles = new TileMap({ map: map(), atlases: atlases(), target });
  tiles.setup({ backend: 'webgpu', frameGraph: { add: (pass) => (run = pass.execute) }, sceneOf: () => undefined });
  const context = { backend: 'webgpu', device, width: 8, height: 4, format: 'rgba8unorm' };
  assert.equal(tiles.visible, true, 'visible by default');
  tiles.visible = false;
  tiles.stats.draws = 5;
  run(context);
  assert.deepEqual(touched, [], 'a hidden map never touches the device');
  tiles.onPreUpdate(1 / 60);
  assert.equal(tiles.stats.draws, 0);
  assert.equal(tiles.stats.uploadedBytes, 0);
  tiles.visible = true;
  assert.throws(() => run(context), /device used/, 'a shown map goes on to draw');
  assert.ok(touched.length > 0);
});
