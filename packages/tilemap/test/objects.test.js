import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMapQuads, ObjectTileMap } from '../dist/objects.js';
import { createTileLayer, FLIP_D, FLIP_H, validateTileMap } from '../dist/index.js';

const collection = {
  name: 'props',
  firstGid: 1,
  tileWidth: 4,
  tileHeight: 4,
  columns: 0,
  tileCount: 3,
  tiles: [
    { id: 0, image: { source: 'red', width: 4, height: 8 } },
    { id: 1, image: { source: 'blue', width: 6, height: 4 } },
    {
      id: 2,
      animation: [
        { tileId: 0, duration: 20 },
        { tileId: 1, duration: 20 },
      ],
    },
  ],
};
const map = (layers) => ({ width: 2, height: 1, tileWidth: 4, tileHeight: 4, tilesets: [collection], layers });
test('collection texels, animation and mixed layers keep painter order', () => {
  const m = map([
    createTileLayer('floor', 2, 1, Uint32Array.of(1, 2)),
    { type: 'image', name: 'mist', image: { source: 'mist', width: 2, height: 2 } },
    { type: 'object', name: 'props', drawOrder: 'index', objects: [{ id: 1, x: 3, y: 8, gid: 3 }] },
  ]);
  validateTileMap(m);
  const q = buildMapQuads(m, { time: 25 });
  assert.deepEqual(
    q.map((q) => q.source),
    ['red', 'blue', 'mist', 'blue'],
  );
  assert.deepEqual(q[0].origin, [0, -4]);
  assert.deepEqual(q[1].size, [6, 4]);
  assert.deepEqual(q[3].origin, [3, 4]);
});
test('topdown is stable and index preserves stored object order', () => {
  const layer = {
    type: 'object',
    name: 'props',
    objects: [
      { id: 1, x: 0, y: 8, gid: 1 },
      { id: 2, x: 1, y: 2, gid: 2 },
      { id: 3, x: 2, y: 2, gid: 1 },
    ],
  };
  assert.deepEqual(
    buildMapQuads(map([layer])).map((q) => q.source),
    ['blue', 'red', 'red'],
  );
  assert.deepEqual(
    buildMapQuads(map([{ ...layer, drawOrder: 'index' }])).map((q) => q.source),
    ['red', 'blue', 'red'],
  );
});
test('object alignment, display size, rotation, offsets and diagonal flips', () => {
  const m = map([
    {
      type: 'object',
      name: 'props',
      objects: [{ id: 1, x: 10, y: 20, gid: (1 | FLIP_D | FLIP_H) >>> 0, width: 16, height: 8, rotation: 90 }],
    },
  ]);
  m.tilesets = [{ ...collection, objectAlignment: 'center', tileOffset: [1, 2] }];
  const [q] = buildMapQuads(m);
  assert.ok(Math.abs(q.origin[0] - 10) < 1e-12);
  assert.ok(Math.abs(q.origin[1] - 14) < 1e-12);
  assert.ok(Math.abs(q.axisX[1] - 16) < 1e-12);
  assert.equal(q.flags, 5);
  assert.deepEqual(q.size, [4, 8]);
});
test('image repeats cover a negative camera view and honour layer state', () => {
  const m = map([
    {
      type: 'image',
      name: 'repeat',
      offset: [1, 0],
      parallax: [0.5, 1],
      tint: '#80ffffff',
      opacity: 0.5,
      image: { source: 'i' },
      repeatX: true,
      repeatY: true,
    },
    { type: 'image', name: 'hidden', visible: false, image: { source: 'absent' } },
  ]);
  const q = buildMapQuads(m, { camera: { x: 4, y: 0 }, view: [-2, -2, 6, 4], imageSize: () => [2, 2] });
  assert.equal(q.length, 15);
  assert.deepEqual(q[0].origin, [-3, -2]);
  assert.equal(q[0].tint[3], (128 / 255) * 0.5);
});
test('oversize images outside the view still draw and orthogonal render order is explicit', () => {
  const m = map([createTileLayer('floor', 2, 1, Uint32Array.of(1, 2))]);
  m.renderOrder = 'left-up';
  assert.deepEqual(
    buildMapQuads(m).map((q) => q.source),
    ['blue', 'red'],
  );
  assert.equal(buildMapQuads(m, { view: [0, -4, 2, 0] }).length, 1);
});
test('empty, replaced and disposed renderers have defined lifecycle', () => {
  const renderer = new ObjectTileMap({ map: map([]), atlases: {} });
  renderer.setMap(map([]));
  renderer.setImage('i', { width: 1, height: 1, data: new Uint8Array(4) });
  renderer.dispose();
  renderer.dispose();
  assert.throws(() => renderer.setMap(map([])), /disposed/);
});
