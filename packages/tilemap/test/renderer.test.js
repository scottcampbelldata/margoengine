// Node checks of the tile map renderer's CPU side: chunking, dirty upload contents, culling, animation lookup, colours.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  animatedTile,
  TILE_CHUNK_SIZE,
  chunkGrid,
  createTileLayer,
  fillChunk,
  mapColor,
  TileMap,
  tileReach,
  visibleChunks,
} from '../dist/index.js';

test('a layer splits into 64 x 64 chunks, rounding up', () => {
  assert.equal(TILE_CHUNK_SIZE, 64);
  assert.deepEqual(chunkGrid(0, 0), { chunksWide: 0, chunksHigh: 0 });
  assert.deepEqual(chunkGrid(64, 64), { chunksWide: 1, chunksHigh: 1 });
  assert.deepEqual(chunkGrid(65, 129), { chunksWide: 2, chunksHigh: 3 });
});

test('a chunk holds its cells row by row and zero past the layer', () => {
  const layer = createTileLayer('a', 66, 65);
  layer.data[0] = 7;
  layer.data[65] = 8; // (65, 0): chunk 1
  layer.data[64 * 66 + 2] = 9; // (2, 64): chunk (0, 1)
  const out = new Uint32Array(4096).fill(99);
  fillChunk(layer, 0, 0, out);
  assert.equal(out[0], 7);
  assert.equal(out[64 * 64 - 1], 0);
  fillChunk(layer, 1, 0, out);
  assert.equal(out[1], 8);
  assert.equal(out[2], 0, 'past the layer width');
  assert.equal(
    out.reduce((a, b) => a + b),
    8,
  );
  fillChunk(layer, 0, 1, out);
  assert.equal(out[2], 9);
  assert.equal(
    out.reduce((a, b) => a + b),
    9,
    'past the layer height',
  );
});

const noReach = { left: 0, top: 0, right: 0, bottom: 0 };
const chunks = (x, y, reach = noReach, zoom = 1) => visibleChunks(x, y, zoom, 100, 100, 16, 16, 4, 4, reach);

test('only chunks the target shows are visible', () => {
  // One chunk is 1024 pixels.
  assert.deepEqual(chunks(0, 0), { firstX: 0, firstY: 0, lastX: 0, lastY: 0 });
  assert.deepEqual(chunks(-1000, 0), { firstX: 0, firstY: 0, lastX: 1, lastY: 0 }, 'straddles an edge');
  assert.deepEqual(chunks(-1024, -1024), { firstX: 1, firstY: 1, lastX: 1, lastY: 1 }, 'exactly on a chunk edge');
  const past = chunks(200, 0);
  assert.ok(past.lastX < past.firstX, 'map entirely to the right');
  const after = chunks(-5000, 0);
  assert.ok(after.lastX < after.firstX, 'map entirely to the left');
  assert.deepEqual(chunks(0, 0, noReach, 16), { firstX: 0, firstY: 0, lastX: 0, lastY: 0 }, 'zoom makes chunks larger');
});

test('a tile bigger than its cell keeps the chunk it reaches from visible', () => {
  const reach = tileReach(
    [{ name: 's', firstGid: 1, tileWidth: 48, tileHeight: 32, tileCount: 1, columns: 1 }],
    16,
    16,
  );
  assert.deepEqual(reach, { left: 0, top: 32, right: 32, bottom: 0 });
  // The chunk left of the target ends 8 pixels before it, a tile reaches 32 pixels right.
  assert.equal(chunks(-1032, 0, reach).firstX, 0);
  assert.equal(chunks(-1032, 0).firstX, 1);
  // The chunk below the target starts 8 pixels past it, a tile reaches 32 pixels up.
  assert.equal(chunks(0, -916, reach).lastY, 1);
  assert.equal(chunks(0, -916).lastY, 0);
  assert.deepEqual(
    tileReach(
      [{ name: 's', firstGid: 1, tileWidth: 16, tileHeight: 16, tileCount: 1, columns: 1, tileOffset: [-3, 5] }],
      16,
      16,
    ),
    { left: 3, top: 0, right: 0, bottom: 5 },
  );
});

test('an animation loops through its frames by duration', () => {
  const steps = [
    { tileId: 4, duration: 100 },
    { tileId: 5, duration: 50 },
  ];
  assert.equal(animatedTile(steps, 0), 4);
  assert.equal(animatedTile(steps, 99.5), 4);
  assert.equal(animatedTile(steps, 100), 5);
  assert.equal(animatedTile(steps, 149), 5);
  assert.equal(animatedTile(steps, 150), 4);
  assert.equal(animatedTile(steps, 150 * 1000 + 100), 5);
  assert.equal(animatedTile(steps, -1), 5, 'negative time wraps');
  assert.equal(animatedTile([], 10), -1);
});

test('map colours read as #rrggbb and #aarrggbb', () => {
  assert.deepEqual(mapColor('#ff0000'), [1, 0, 0, 1]);
  assert.deepEqual(mapColor('#80ff0000'), [1, 0, 0, 128 / 255]);
  assert.equal(mapColor('red'), undefined);
  assert.equal(mapColor(undefined), undefined);
});

test('bad options throw errors that link their fix', () => {
  const layer = createTileLayer('a', 2, 2),
    map = { width: 2, height: 2, tileWidth: 16, tileHeight: 16, tilesets: [], layers: [layer] };
  assert.throws(() => new TileMap({}), TypeError);
  assert.throws(() => new TileMap({ map }), /TileMap needs atlases/);
  assert.throws(() => new TileMap({ map, atlases: {}, order: Number.NaN }), RangeError);
  assert.throws(() => new TileMap({ map, atlases: {}, mapLayers: ['b'] }), /Unknown tile layer/);
  const tiles = new TileMap({ map, atlases: {} });
  assert.throws(() => tiles.setTile('a', 2, 0, 1), /Tile outside the layer/);
  assert.throws(() => tiles.setTile('b', 0, 0, 1), /Unknown tile layer/);
  tiles.setTile(layer, 1, 1, 5);
  assert.equal(layer.data[3], 5);
  tiles.dispose();
  assert.throws(() => tiles.setMap(map), /disposed/);
});
