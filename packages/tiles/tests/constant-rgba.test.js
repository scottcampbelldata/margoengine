// pnts CONSTANT_RGBA (3D Tiles 1.1, Point Cloud feature table: "A constant color for all points", used when no RGBA,
// RGB or RGB565 is present) reaches the point cloud the renderer makes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TilesRenderer } from '../dist/index.js';
import { memoryFetch } from './generator.js';

test('a pnts tile with only CONSTANT_RGBA draws every point in that colour', async () => {
  const memory = memoryFetch(
    new Map([
      [
        'tileset.json',
        new TextEncoder().encode(
          JSON.stringify({
            asset: { version: '1.1' },
            geometricError: 10,
            root: { boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] }, geometricError: 0 },
          }),
        ),
      ],
    ]),
  );
  const renderer = await TilesRenderer.load({ use() {} }, memory.url, { fetch: memory.fetch });
  const mesh = { setQuaternion() {}, setScale() {}, setPosition() {}, dispose() {} },
    made = [];
  // Stand-ins for the engine and the points plugin: this checks what the renderer hands the cloud.
  renderer.engine = { createMesh: () => mesh };
  renderer.points = Promise.resolve({
    host: { add: (cloud) => cloud, remove() {} },
    PointCloud: class {
      constructor(options) {
        this.options = options;
        made.push(this);
      }
      attach() {}
    },
  });
  const content = {
    type: 'pnts',
    positions: new Float32Array([0, 0, 0, 1, 1, 1]),
    constantColor: [255, 128, 0, 64],
    byteLength: 24,
  };
  const tile = await renderer.createContent(content, renderer.tileset.root, new AbortController().signal);
  // Before: colors was undefined, so the points drew in the cloud's default colour.
  assert.deepEqual([...made[0].options.colors], [255, 128, 0, 64, 255, 128, 0, 64]);
  assert.equal(made[0].options.colorComponents, 4);
  assert.equal(tile.bytes, 2 * 16);
  tile.dispose();
});
