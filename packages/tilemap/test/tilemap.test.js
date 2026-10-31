import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLIP_D,
  FLIP_H,
  FLIP_V,
  GID_MASK,
  createTileLayer,
  decodeTile,
  encodeTile,
  tileAt,
  tileDefForGid,
  tilesetForGid,
  validateTileMap,
} from '../dist/index.js';

const grass = {
  name: 'grass',
  firstGid: 1,
  tileWidth: 16,
  tileHeight: 16,
  tileCount: 4,
  columns: 2,
  image: { source: 'g.png', width: 32, height: 32 },
  tiles: [
    {
      id: 1,
      properties: { solid: true },
      animation: [
        { tileId: 1, duration: 100 },
        { tileId: 2, duration: 150 },
      ],
      collision: [{ kind: 'rect', x: 0, y: 0, width: 16, height: 16 }],
    },
  ],
};
const water = {
  name: 'water',
  firstGid: 5,
  tileWidth: 16,
  tileHeight: 16,
  tileCount: 2,
  columns: 2,
  image: { source: 'w.png', width: 32, height: 16 },
};
const layer = createTileLayer('ground', 3, 2, Uint32Array.of(1, 2, 0, encodeTile(5, FLIP_H | FLIP_D), 6, 0));
const map = {
  width: 3,
  height: 2,
  tileWidth: 16,
  tileHeight: 16,
  tilesets: [grass, water],
  layers: [
    layer,
    {
      type: 'object',
      name: 'things',
      objects: [{ id: 1, x: 4, y: 4, shape: { kind: 'point', x: 0, y: 0 } }],
      parallax: [0.5, 0.5],
      offset: [8, 0],
      opacity: 0.5,
    },
  ],
  properties: { title: 'demo' },
};

test('flip bits survive a round trip as unsigned values', () => {
  const v = encodeTile(123, FLIP_H | FLIP_V | FLIP_D);
  assert.equal(v, 0xe000007b);
  assert.deepEqual(decodeTile(v), { gid: 123, flipH: true, flipV: true, flipD: true });
  assert.deepEqual(decodeTile(0x1000007b), { gid: 123, flipH: false, flipV: false, flipD: false });
  assert.equal(new Uint32Array([v])[0], v);
  assert.throws(() => encodeTile(GID_MASK + 1), RangeError);
  assert.throws(() => encodeTile(-1), RangeError);
});

test('lookups find the owning tileset, tile definition and layer cell', () => {
  assert.equal(tilesetForGid(map, 0), undefined);
  assert.equal(tilesetForGid(map, 4).name, 'grass');
  assert.equal(tilesetForGid(map, encodeTile(5, FLIP_V)).name, 'water');
  assert.equal(tilesetForGid(map, 7), undefined);
  assert.equal(tileDefForGid(map, 2).properties.solid, true);
  assert.equal(tileDefForGid(map, 1), undefined);
  assert.equal(tileAt(layer, 1, 0), 2);
  assert.equal(tileAt(layer, 0, 1), encodeTile(5, FLIP_H | FLIP_D));
  assert.equal(tileAt(layer, 3, 0), 0);
  assert.equal(tileAt(layer, -1, 0), 0);
});

test('a well-formed map validates; bad ones name the field', () => {
  validateTileMap(map);
  assert.throws(() => validateTileMap({ ...map, tileWidth: 0 }), /tileWidth/);
  assert.throws(
    () => validateTileMap({ ...map, tilesets: [grass, { ...water, firstGid: 3 }] }),
    /inside the previous tileset/,
  );
  assert.throws(() => validateTileMap({ ...map, layers: [{ ...layer, data: new Uint32Array(5) }] }), /5 values/);
  assert.throws(() => validateTileMap({ ...map, layers: [{ ...layer, data: [1, 2, 3, 4, 5, 6] }] }), TypeError);
  assert.throws(() => validateTileMap({ ...map, layers: [{ ...layer, opacity: 2 }] }), /opacity/);
  assert.throws(() => validateTileMap({ ...map, tilesets: [{ ...grass, tiles: [{ id: 9 }] }] }), /id 9/);
  assert.throws(
    () =>
      validateTileMap({
        ...map,
        tilesets: [{ ...grass, tiles: [{ id: 0, animation: [{ tileId: 0, duration: 0 }] }] }],
      }),
    /duration/,
  );
  assert.throws(() => validateTileMap({ ...map, layers: [{ type: 'image', name: 'x' }] }), TypeError);
});

test('createTileLayer checks its data length', () => {
  assert.equal(createTileLayer('a', 2, 2).data.length, 4);
  assert.throws(() => createTileLayer('a', 2, 2, new Uint32Array(3)), RangeError);
  assert.throws(() => createTileLayer('a', 1.5, 2), RangeError);
});
