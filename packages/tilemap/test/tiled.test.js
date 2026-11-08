import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, gzipSync } from 'node:zlib';
import { FLIP_D, FLIP_H, FLIP_V, validateTileMap } from '../dist/index.js';
import { MapImportError, fromTMX, parseTiled } from '../dist/tiled.js';

const HEX_BIT = 0x10000000;

/** A minimal orthogonal Tiled map (.tmj) in the shape the Tiled JSON format documents. */
const baseMap = (over = {}) => ({
  type: 'map',
  version: '1.10',
  orientation: 'orthogonal',
  width: 2,
  height: 2,
  tilewidth: 16,
  tileheight: 16,
  infinite: false,
  tilesets: [
    {
      firstgid: 1,
      name: 'grass',
      tilewidth: 16,
      tileheight: 16,
      tilecount: 4,
      columns: 2,
      image: 'grass.png',
      imagewidth: 32,
      imageheight: 32,
    },
  ],
  layers: [{ type: 'tilelayer', id: 1, name: 'ground', width: 2, height: 2, data: [1, 2, 0, 4] }],
  ...over,
});

const littleEndian = (values) => {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => out.writeUInt32LE(v >>> 0, i * 4));
  return out;
};

const rejects = async (promise, code) => {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof MapImportError, `expected MapImportError, got ${e}`);
    assert.equal(e.code, code);
    assert.equal(e.format, 'Tiled');
    assert.match(e.message, /^Tiled: /);
    return true;
  });
};

test('a CSV (array) tile layer, an embedded tileset and the map header', async () => {
  const map = await parseTiled(
    baseMap({ backgroundcolor: '#112233', properties: [{ name: 'level', type: 'int', value: 3 }] }),
  );
  assert.deepEqual([map.width, map.height, map.tileWidth, map.tileHeight], [2, 2, 16, 16]);
  assert.equal(map.backgroundColor, '#112233');
  assert.deepEqual(map.properties, { level: 3 });
  assert.equal(map.tilesets.length, 1);
  assert.deepEqual(
    { ...map.tilesets[0] },
    {
      name: 'grass',
      firstGid: 1,
      tileWidth: 16,
      tileHeight: 16,
      tileCount: 4,
      columns: 2,
      image: { source: 'grass.png', width: 32, height: 32 },
    },
  );
  const layer = map.layers[0];
  assert.equal(layer.type, 'tile');
  assert.equal(layer.name, 'ground');
  assert.equal(layer.id, 1);
  assert.ok(layer.data instanceof Uint32Array);
  assert.deepEqual([...layer.data], [1, 2, 0, 4]);
  validateTileMap(map);
});

test('JSON text and UTF-8 bytes parse like an object', async () => {
  const text = JSON.stringify(baseMap());
  const a = await parseTiled(text);
  const b = await parseTiled(new TextEncoder().encode(text));
  assert.deepEqual([...b.layers[0].data], [...a.layers[0].data]);
  assert.deepEqual([...a.layers[0].data], [1, 2, 0, 4]);
});

test('flip bits are kept and the hexagonal rotation bit is cleared', async () => {
  const data = [(1 | FLIP_H) >>> 0, (2 | FLIP_V) >>> 0, (3 | FLIP_D | FLIP_H) >>> 0, (4 | HEX_BIT) >>> 0];
  const map = await parseTiled(baseMap({ layers: [{ type: 'tilelayer', name: 'l', width: 2, height: 2, data }] }));
  assert.deepEqual([...map.layers[0].data], [(1 | FLIP_H) >>> 0, (2 | FLIP_V) >>> 0, (3 | FLIP_D | FLIP_H) >>> 0, 4]);
});

test('base64 layers: plain, zlib and gzip decode to the same cells, little endian', async () => {
  const cells = [(1 | FLIP_H) >>> 0, 2, 3, (4 | FLIP_D) >>> 0];
  const raw = littleEndian(cells);
  const variants = [
    { encoding: 'base64', data: raw.toString('base64') },
    { encoding: 'base64', compression: 'zlib', data: deflateSync(raw).toString('base64') },
    { encoding: 'base64', compression: 'gzip', data: gzipSync(raw).toString('base64') },
  ];
  for (const v of variants) {
    const map = await parseTiled(baseMap({ layers: [{ type: 'tilelayer', name: 'l', width: 2, height: 2, ...v }] }));
    assert.deepEqual([...map.layers[0].data], cells, v.compression ?? 'plain');
  }
});

test('bad layer data is refused with a coded error that names the layer', async () => {
  const layer = (extra) => baseMap({ layers: [{ type: 'tilelayer', name: 'ground', width: 2, height: 2, ...extra }] });
  const four = littleEndian([1, 2, 3, 4]).toString('base64');
  await rejects(parseTiled(layer({ data: [1, 2, 3] })), 'truncated');
  await rejects(parseTiled(layer({ data: [1, 2, 3, -1] })), 'syntax');
  await rejects(parseTiled(layer({ data: [1, 2, 3, 1.5] })), 'syntax');
  await rejects(parseTiled(layer({ data: [1, 2, 3, 4294967296] })), 'syntax');
  await rejects(parseTiled(layer({})), 'syntax');
  await rejects(parseTiled(layer({ encoding: 'base64', data: '!!!not base64!!!' })), 'syntax');
  await rejects(parseTiled(layer({ encoding: 'hex', data: 'abcd' })), 'unsupported');
  await rejects(parseTiled(layer({ encoding: 'base64', compression: 'zstd', data: four })), 'unsupported');
  await rejects(
    parseTiled(layer({ encoding: 'base64', data: littleEndian([1, 2, 3]).toString('base64') })),
    'truncated',
  );
  await rejects(
    parseTiled(layer({ encoding: 'base64', data: littleEndian([1, 2, 3, 4, 5]).toString('base64') })),
    'syntax',
  );
  await rejects(
    parseTiled(
      layer({ encoding: 'base64', compression: 'zlib', data: Buffer.from('not zlib data').toString('base64') }),
    ),
    'syntax',
  );
  await assert.rejects(parseTiled(layer({ data: [1, 2, 3] })), /layer "ground"/);
});

test('a compressed layer cannot expand past its declared size', async () => {
  const bomb = deflateSync(Buffer.alloc(4 * 1024 * 1024)).toString('base64');
  await rejects(
    parseTiled(
      baseMap({
        layers: [
          { type: 'tilelayer', name: 'l', width: 2, height: 2, encoding: 'base64', compression: 'zlib', data: bomb },
        ],
      }),
    ),
    'limit',
  );
});

test('input that is not a Tiled map is refused', async () => {
  await rejects(parseTiled('{"layers": '), 'syntax');
  await rejects(parseTiled('[1, 2]'), 'syntax');
  await rejects(parseTiled(42), 'syntax');
  await rejects(parseTiled({ width: 1 }), 'syntax');
  await rejects(parseTiled(baseMap({ tilewidth: 0 })), 'syntax');
  await rejects(parseTiled(baseMap({ orientation: 'oblique' })), 'unsupported');
  await rejects(parseTiled(baseMap({ width: 5000, height: 5000 })), 'limit');
  await rejects(
    parseTiled(baseMap({ layers: [{ type: 'tilelayer', name: 'big', width: 5000, height: 5000, data: [] }] })),
    'limit',
  );
});

test('an already aborted signal stops the import', async () => {
  const controller = new AbortController();
  controller.abort();
  await rejects(parseTiled(baseMap(), { signal: controller.signal }), 'aborted');
});

test('group layers pass offset, opacity, visibility and parallax down to their children', async () => {
  const warnings = [];
  const map = await parseTiled(
    baseMap({
      layers: [
        {
          type: 'group',
          name: 'outer',
          offsetx: 10,
          offsety: 20,
          opacity: 0.5,
          parallaxx: 0.5,
          layers: [
            {
              type: 'group',
              name: 'inner',
              visible: false,
              layers: [
                { type: 'tilelayer', name: 'deep', width: 2, height: 2, offsetx: 1, opacity: 0.5, data: [1, 1, 1, 1] },
              ],
            },
          ],
        },
        { type: 'imagelayer', name: 'sky', image: 'sky.png' },
      ],
    }),
    { onWarning: (m) => warnings.push(m) },
  );
  assert.equal(map.layers.length, 1);
  const deep = map.layers[0];
  assert.equal(deep.name, 'deep');
  assert.deepEqual([...deep.offset], [11, 20]);
  assert.equal(deep.opacity, 0.25);
  assert.equal(deep.visible, false);
  assert.deepEqual([...deep.parallax], [0.5, 1]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"sky" is a imagelayer; skipped/);
});

test('layer tint, id and custom properties (list form) are kept; __proto__ stays an own property', async () => {
  const properties = JSON.parse(
    '[{"name":"__proto__","type":"string","value":"x"},{"name":"solid","type":"bool","value":true}]',
  );
  const map = await parseTiled(
    baseMap({
      layers: [
        {
          type: 'tilelayer',
          id: 7,
          name: 'l',
          width: 2,
          height: 2,
          data: [0, 0, 0, 0],
          tintcolor: '#ff8800',
          properties,
        },
      ],
    }),
  );
  const layer = map.layers[0];
  assert.equal(layer.id, 7);
  assert.equal(layer.tint, '#ff8800');
  assert.equal(layer.properties.solid, true);
  assert.equal(Object.hasOwn(layer.properties, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(layer.properties), Object.prototype);
});

test('object layers: shapes, tile objects, class, visibility and warnings', async () => {
  const warnings = [];
  const map = await parseTiled(
    baseMap({
      layers: [
        {
          type: 'objectgroup',
          name: 'things',
          offsetx: 4,
          objects: [
            {
              id: 1,
              name: 'box',
              type: 'Crate',
              x: 8,
              y: 9,
              width: 16,
              height: 32,
              rotation: 15,
              properties: [{ name: 'hp', type: 'int', value: 5 }],
            },
            { id: 2, x: 1, y: 2, width: 6, height: 4, ellipse: true },
            { id: 3, x: 3, y: 4, point: true },
            {
              id: 4,
              x: 0,
              y: 0,
              polygon: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 0, y: 10 },
              ],
            },
            {
              id: 5,
              x: 0,
              y: 0,
              polyline: [
                { x: 0, y: 0 },
                { x: 5, y: 5 },
              ],
            },
            { id: 6, x: 16, y: 32, width: 16, height: 16, gid: (2 | FLIP_H) >>> 0, class: 'Tree', visible: false },
            { id: 7, x: 0, y: 0, width: 20, height: 10, text: { text: 'hi' } },
            { id: 8, x: 0, y: 0, template: 'enemy.tx' },
          ],
        },
      ],
    }),
    { onWarning: (m) => warnings.push(m) },
  );
  const layer = map.layers[0];
  assert.equal(layer.type, 'object');
  assert.deepEqual([...layer.offset], [4, 0]);
  assert.equal(layer.objects.length, 8);
  const [box, ellipse, point, polygon, polyline, tile, text] = layer.objects;
  assert.deepEqual({ ...box.shape }, { kind: 'rect', x: 0, y: 0, width: 16, height: 32 });
  assert.equal(box.name, 'box');
  assert.equal(box.type, 'Crate');
  assert.equal(box.rotation, 15);
  assert.deepEqual(box.properties, { hp: 5 });
  assert.equal(ellipse.shape.kind, 'ellipse');
  assert.equal(ellipse.shape.width, 6);
  assert.equal(point.shape.kind, 'point');
  assert.equal(polygon.shape.kind, 'polygon');
  assert.deepEqual(
    polygon.shape.points.map((p) => [...p]),
    [
      [0, 0],
      [10, 0],
      [0, 10],
    ],
  );
  assert.equal(polyline.shape.kind, 'polyline');
  assert.equal(tile.gid, (2 | FLIP_H) >>> 0);
  assert.equal(tile.shape, undefined);
  assert.equal(tile.type, 'Tree');
  assert.equal(tile.visible, false);
  assert.equal(text.shape.kind, 'rect');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /object 7 is a text object/);
  assert.match(warnings[1], /object 8 uses a template/);
  validateTileMap(map);
});

test('tile definitions: properties, animation, collision shapes, per-tile image, offset, spacing and margin', async () => {
  const map = await parseTiled(
    baseMap({
      tilesets: [
        {
          firstgid: 5,
          name: 'props',
          tilewidth: 16,
          tileheight: 16,
          tilecount: 2,
          columns: 0,
          spacing: 1,
          margin: 2,
          tileoffset: { x: 3, y: -4 },
          properties: [{ name: 'theme', type: 'string', value: 'cave' }],
          tiles: [
            {
              id: 0,
              type: 'Water',
              properties: [{ name: 'speed', type: 'float', value: 0.5 }],
              animation: [
                { tileid: 0, duration: 100 },
                { tileid: 1, duration: 200 },
              ],
              objectgroup: {
                type: 'objectgroup',
                objects: [
                  { id: 1, x: 2, y: 3, width: 4, height: 5, rotation: 90 },
                  { id: 2, x: 1, y: 1, point: true },
                ],
              },
              image: 'water.png',
              imagewidth: 16,
              imageheight: 16,
            },
            { id: 1 },
          ],
        },
      ],
      layers: [],
    }),
  );
  const set = map.tilesets[0];
  assert.equal(set.firstGid, 5);
  assert.equal(set.spacing, 1);
  assert.equal(set.margin, 2);
  assert.deepEqual([...set.tileOffset], [3, -4]);
  assert.deepEqual(set.properties, { theme: 'cave' });
  assert.equal(set.tileCount, 2);
  const water = set.tiles[0];
  assert.equal(water.type, 'Water');
  assert.deepEqual(water.properties, { speed: 0.5 });
  assert.deepEqual(
    water.animation.map((s) => ({ ...s })),
    [
      { tileId: 0, duration: 100 },
      { tileId: 1, duration: 200 },
    ],
  );
  assert.deepEqual({ ...water.collision[0] }, { kind: 'rect', x: 2, y: 3, width: 4, height: 5, rotation: 90 });
  assert.deepEqual({ ...water.collision[1] }, { kind: 'point', x: 1, y: 1 });
  assert.deepEqual({ ...water.image }, { source: 'water.png', width: 16, height: 16 });
  assert.deepEqual({ ...set.tiles[1] }, { id: 1 });
});

test('an external tileset is loaded through options.resolve with the path written in the map', async () => {
  const external = {
    name: 'rocks',
    tilewidth: 16,
    tileheight: 16,
    tilecount: 3,
    columns: 3,
    image: 'rocks.png',
    imagewidth: 48,
    imageheight: 16,
  };
  const map = baseMap({ tilesets: [{ firstgid: 10, source: 'tilesets/rocks.tsj' }] });
  const asked = [];
  const resolve = async (source, signal) => {
    asked.push([source, signal]);
    return JSON.stringify(external);
  };
  const controller = new AbortController();
  const got = await parseTiled(map, { resolve, signal: controller.signal });
  assert.deepEqual(asked, [['tilesets/rocks.tsj', controller.signal]]);
  assert.equal(got.tilesets[0].firstGid, 10);
  assert.equal(got.tilesets[0].name, 'rocks');
  assert.equal(got.tilesets[0].tileCount, 3);
  const asObject = await parseTiled(map, { resolve: async () => external });
  assert.equal(asObject.tilesets[0].name, 'rocks');
  const asBytes = await parseTiled(map, { resolve: async () => new TextEncoder().encode(JSON.stringify(external)) });
  assert.equal(asBytes.tilesets[0].columns, 3);
  await rejects(parseTiled(map), 'missing');
  await assert.rejects(parseTiled(map), /tilesets\/rocks\.tsj.*options\.resolve/);
  await rejects(parseTiled(map, { resolve: async () => '<tileset name="rocks"/>' }), 'unsupported');
  await rejects(parseTiled(map, { resolve: async () => 'not json' }), 'syntax');
});

test('infinite maps: chunks are joined into one layer positioned by its top left chunk', async () => {
  const chunk = (x, y, data) => ({ x, y, width: 2, height: 2, data });
  const map = await parseTiled(
    baseMap({
      infinite: true,
      width: 0,
      height: 0,
      layers: [
        { type: 'tilelayer', name: 'world', chunks: [chunk(-2, -2, [1, 2, 3, 4]), chunk(0, 0, [5, 6, 7, 8])] },
        { type: 'tilelayer', name: 'empty', chunks: [] },
      ],
    }),
  );
  const world = map.layers[0];
  assert.deepEqual([world.width, world.height], [4, 4]);
  assert.deepEqual([...world.offset], [-32, -32]);
  assert.deepEqual([...world.data], [1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 5, 6, 0, 0, 7, 8]);
  assert.deepEqual([map.width, map.height], [2, 2]);
  const empty = map.layers[1];
  assert.deepEqual([empty.width, empty.height, empty.data.length], [0, 0, 0]);
});

test('infinite maps: chunks spread past the cell limit are refused', async () => {
  await rejects(
    parseTiled(
      baseMap({
        infinite: true,
        layers: [
          {
            type: 'tilelayer',
            name: 'far',
            chunks: [
              { x: 0, y: 0, width: 1, height: 1, data: [1] },
              { x: 100000, y: 100000, width: 1, height: 1, data: [1] },
            ],
          },
        ],
      }),
    ),
    'limit',
  );
});

test('fromTMX turns the loaders TMX result into the same TileMapData', () => {
  const properties = {};
  const map = fromTMX({
    width: 2,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    tilesets: [
      {
        name: 'grass',
        tilewidth: 16,
        tileheight: 16,
        spacing: 0,
        margin: 0,
        columns: 2,
        tilecount: 4,
        image: { path: 'g.png', width: 32, height: 32 },
        properties,
      },
    ],
    tilesetRefs: [{ firstgid: 1, tileset: 0 }],
    layers: [
      {
        type: 'tile',
        name: 'ground',
        visible: true,
        opacity: 1,
        offsetx: 0,
        offsety: 0,
        properties,
        x: 1,
        y: 0,
        width: 2,
        height: 1,
        gids: Uint32Array.of(1, 2),
        flips: Uint8Array.of(1, 2 | 4),
      },
      {
        type: 'object',
        name: 'o',
        visible: false,
        opacity: 0.5,
        offsetx: 3,
        offsety: 0,
        properties: { a: 1 },
        objects: [
          { id: 1, name: 'r', type: 'T', x: 1, y: 2, width: 4, height: 5, rotation: 0, visible: true, properties },
          { id: 2, name: '', type: '', x: 0, y: 0, width: 0, height: 0, rotation: 0, visible: true, properties },
          {
            id: 3,
            name: '',
            type: '',
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            rotation: 0,
            visible: true,
            gid: 3,
            flips: 1,
            properties,
          },
        ],
      },
    ],
    properties,
  });
  validateTileMap(map);
  assert.deepEqual([map.width, map.height, map.tileWidth], [2, 1, 16]);
  assert.deepEqual({ ...map.tilesets[0].image }, { source: 'g.png', width: 32, height: 32 });
  const tiles = map.layers[0];
  assert.deepEqual([...tiles.data], [(1 | FLIP_H) >>> 0, (2 | FLIP_V | FLIP_D) >>> 0]);
  assert.deepEqual([...tiles.offset], [16, 0]);
  const objects = map.layers[1];
  assert.equal(objects.visible, false);
  assert.equal(objects.opacity, 0.5);
  assert.deepEqual(objects.properties, { a: 1 });
  assert.deepEqual({ ...objects.objects[0].shape }, { kind: 'rect', x: 0, y: 0, width: 4, height: 5 });
  assert.equal(objects.objects[1].shape.kind, 'point');
  assert.equal(objects.objects[2].gid, (3 | FLIP_H) >>> 0);
});

test('isometric, staggered and hexagonal maps keep their layout; hex turns keep bit 28, others drop it', async () => {
  const iso = await parseTiled(baseMap({ orientation: 'isometric', staggeraxis: 'x' }));
  assert.equal(iso.orientation, 'isometric');
  assert.equal(iso.staggerAxis, undefined);
  validateTileMap(iso);
  const stag = await parseTiled(baseMap({ orientation: 'staggered', staggeraxis: 'x', staggerindex: 'even' }));
  assert.deepEqual(
    [stag.orientation, stag.staggerAxis, stag.staggerIndex, stag.hexSideLength],
    ['staggered', 'x', 'even', undefined],
  );
  const turned = (0x10000000 | 2) >>> 0;
  const layers = [{ type: 'tilelayer', name: 'ground', width: 2, height: 2, data: [1, turned, 0, 4] }];
  const hex = await parseTiled(baseMap({ orientation: 'hexagonal', hexsidelength: 8, layers }));
  assert.deepEqual(
    [hex.orientation, hex.staggerAxis, hex.staggerIndex, hex.hexSideLength],
    ['hexagonal', 'y', 'odd', 8],
  );
  assert.equal(hex.layers[0].data[1], turned);
  assert.equal((await parseTiled(baseMap({ layers }))).layers[0].data[1], 2, 'an orthogonal map clears bit 28');
  const plain = await parseTiled(baseMap());
  assert.equal('orientation' in plain, false, 'orthogonal maps stay as they were');
  await rejects(parseTiled(baseMap({ orientation: 'isometric', infinite: true })), 'unsupported');
  await rejects(parseTiled(baseMap({ orientation: 'staggered', staggeraxis: 'z' })), 'syntax');
  await rejects(parseTiled(baseMap({ orientation: 'hexagonal', staggerindex: 'third' })), 'syntax');
  assert.throws(() => validateTileMap({ ...plain, orientation: 'oblique' }), /orientation/);
});
