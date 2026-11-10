// Disposal leaves the scene the plugin joined, never the active one (docs/integration-fixtures.md, "Scene owner"; the
// one-argument engine.removePlugin(name) removed a same-name plugin from the active scene instead).
import test from 'node:test';
import { assertLeavesOwnScene, attachIn } from '../../../tests/support/scene-owner-decoy.js';
import { createTileLayer, TileMap } from '../dist/index.js';
import { GridTileMap } from '../dist/iso.js';
import { ObjectTileMap } from '../dist/objects.js';

const set = { name: 'g', firstGid: 1, tileWidth: 4, tileHeight: 4, tileCount: 2, columns: 2, image: { source: 'g', width: 8, height: 4 } };
const map = () => ({ width: 2, height: 1, tileWidth: 4, tileHeight: 4, tilesets: [set], layers: [createTileLayer('floor', 2, 1, Uint32Array.of(1, 2))] });
const atlases = () => ({ g: { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) } });
const target = { width: 8, height: 4, format: 'rgba8unorm', createView: () => ({}), destroy() {} };
for (const [label, make] of [
  ['TileMap', () => new TileMap({ map: map(), atlases: atlases(), target })],
  ['GridTileMap', () => new GridTileMap({ map: map(), atlases: atlases(), target })],
  ['ObjectTileMap', () => new ObjectTileMap({ map: map(), atlases: atlases(), target })],
])
  test(`${label} disposal leaves the scene it joined and keeps the active scene's same-name map`, (t) =>
    assertLeavesOwnScene(t, make));
