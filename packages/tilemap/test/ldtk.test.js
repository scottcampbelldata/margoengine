// Node checks of @margoengine/tilemap/ldtk. Fixtures are written here from the public LDtk JSON format description.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeTile, validateTileMap } from '../dist/index.js';
import { MapImportError, parseLDtk } from '../dist/ldtk.js';

const defs = {
  tilesets: [
    {
      uid: 10,
      identifier: 'Grass',
      relPath: 'grass.png',
      pxWid: 32,
      pxHei: 16,
      tileGridSize: 16,
      spacing: 0,
      padding: 0,
      __cWid: 2,
      __cHei: 1,
      customData: [{ tileId: 1, data: 'solid' }],
      enumTags: [{ enumValueId: 'Water', tileIds: [0] }],
    },
    {
      uid: 11,
      identifier: 'Big',
      relPath: 'big.png',
      pxWid: 64,
      pxHei: 32,
      tileGridSize: 32,
      spacing: 1,
      padding: 2,
      __cWid: 2,
      __cHei: 1,
    },
  ],
};
const tile = (x, y, t, f = 0, a = 1) => ({ px: [x, y], src: [0, 0], f, t, a, d: [0] });
const tilesLayer = (id, gridTiles, extra = {}) => ({
  __identifier: id,
  __type: 'Tiles',
  __cWid: 2,
  __cHei: 2,
  __gridSize: 16,
  __opacity: 1,
  __pxTotalOffsetX: 0,
  __pxTotalOffsetY: 0,
  __tilesetDefUid: 10,
  visible: true,
  gridTiles,
  autoLayerTiles: [],
  entityInstances: [],
  intGridCsv: [],
  ...extra,
});
const level = (layerInstances, extra = {}) => ({
  identifier: 'Level_0',
  iid: 'abc',
  worldX: 100,
  worldY: 200,
  worldDepth: 1,
  pxWid: 32,
  pxHei: 32,
  __bgColor: '#102030',
  fieldInstances: [{ __identifier: 'music', __value: 'calm', __type: 'String' }],
  layerInstances,
  ...extra,
});
const project = (levels, extra = {}) => ({ jsonVersion: '1.5.3', defs, levels, ...extra });

test('Tiles layers: gids, flips, tilesets, level data', () => {
  const { version, levels } = parseLDtk(
    project([level([tilesLayer('Ground', [tile(0, 0, 0), tile(16, 0, 1, 1), tile(0, 16, 1, 2), tile(16, 16, 0, 3)])])]),
  );
  assert.equal(version, '1.5.3');
  const [first] = levels,
    { map } = first;
  validateTileMap(map);
  assert.deepEqual(
    [first.name, first.iid, first.worldX, first.worldY, first.worldDepth],
    ['Level_0', 'abc', 100, 200, 1],
  );
  assert.deepEqual(first.fields, { music: 'calm' });
  assert.deepEqual(
    [map.width, map.height, map.tileWidth, map.tileHeight, map.backgroundColor],
    [2, 2, 16, 16, '#102030'],
  );
  assert.deepEqual(
    map.tilesets.map((s) => [s.name, s.firstGid, s.tileCount, s.columns, s.margin, s.spacing]),
    [
      ['Grass', 1, 2, 2, 0, 0],
      ['Big', 3, 2, 2, 2, 1],
    ],
  );
  assert.equal(map.tilesets[0].image.source, 'grass.png');
  assert.deepEqual(map.tilesets[0].tiles, [
    { id: 0, type: 'Water' },
    { id: 1, properties: { customData: 'solid' } },
  ]);
  const cells = [...map.layers[0].data].map(decodeTile);
  assert.deepEqual(
    cells.map((c) => [c.gid, c.flipH, c.flipV, c.flipD]),
    [
      [1, false, false, false],
      [2, true, false, false],
      [2, false, true, false],
      [1, true, true, false],
    ],
  );
});

test('layers go back to front, with opacity, visibility and offset', () => {
  const { map } = parseLDtk(
    project([
      level([
        tilesLayer('Front', [tile(0, 0, 0)], {
          __opacity: 0.5,
          visible: false,
          __pxTotalOffsetX: 3,
          __pxTotalOffsetY: 4,
        }),
        tilesLayer('Back', [tile(0, 0, 1)]),
      ]),
    ]),
  ).levels[0];
  assert.deepEqual(
    map.layers.map((l) => l.name),
    ['Back', 'Front'],
  );
  assert.equal(map.layers[1].opacity, 0.5);
  assert.equal(map.layers[1].visible, false);
  assert.deepEqual(map.layers[1].offset, [3, 4]);
});

test('AutoLayer tiles stacked on one cell become extra layers, first at the back', () => {
  const { map } = parseLDtk(
    project([
      level([
        {
          ...tilesLayer('Auto', []),
          __type: 'AutoLayer',
          autoLayerTiles: [tile(0, 0, 0), tile(0, 0, 1), tile(16, 0, 1), tile(0, 0, 0, 1)],
        },
      ]),
    ]),
  ).levels[0];
  assert.deepEqual(
    map.layers.map((l) => [l.name, [...l.data]]),
    [
      ['Auto', [1, 2, 0, 0]],
      ['Auto#2', [2, 0, 0, 0]],
      ['Auto#3', [0x80000001 >>> 0, 0, 0, 0]],
    ],
  );
});

test('IntGrid values are kept, with auto tiles beside them', () => {
  const { map, intGrids } = parseLDtk(
    project([
      level([
        {
          ...tilesLayer('Walls', []),
          __type: 'IntGrid',
          intGridCsv: [1, 0, 2, 0],
          autoLayerTiles: [tile(0, 0, 1)],
        },
        { ...tilesLayer('Solid', []), __type: 'IntGrid', intGridCsv: [0, 0, 0, 3], __tilesetDefUid: null },
      ]),
    ]),
  ).levels[0];
  assert.deepEqual([...intGrids.Walls.values], [1, 0, 2, 0]);
  assert.deepEqual(
    [intGrids.Solid.width, intGrids.Solid.height, intGrids.Solid.gridSize, intGrids.Solid.values[3]],
    [2, 2, 16, 3],
  );
  assert.deepEqual(
    map.layers.map((l) => l.name),
    ['Walls'],
    'an IntGrid with no tiles draws nothing',
  );
});

test('entities with fields, as a list and as an object layer', () => {
  const entity = {
    __identifier: 'Player',
    iid: 'p1',
    __grid: [1, 1],
    __pivot: [0.5, 1],
    __tags: ['hero'],
    __worldX: 124,
    __worldY: 232,
    width: 16,
    height: 32,
    px: [24, 32],
    fieldInstances: [
      { __identifier: 'hp', __value: 10 },
      { __identifier: '__proto__', __value: 'safe' },
      { __identifier: 'none', __value: null },
    ],
  };
  const { map, entities } = parseLDtk(
    project([level([{ ...tilesLayer('Things', []), __type: 'Entities', entityInstances: [entity] }])]),
  ).levels[0];
  const [player] = entities;
  assert.deepEqual(
    [
      player.name,
      player.iid,
      player.layer,
      player.x,
      player.y,
      player.worldX,
      player.worldY,
      player.width,
      player.height,
    ],
    ['Player', 'p1', 'Things', 24, 32, 124, 232, 16, 32],
  );
  assert.deepEqual(player.pivot, [0.5, 1]);
  assert.deepEqual(player.tags, ['hero']);
  assert.equal(player.fields.hp, 10);
  assert.equal(player.fields.none, null);
  assert.equal(Object.getPrototypeOf(player.fields), Object.prototype, 'a __proto__ field stays a plain field');
  assert.equal(Object.getOwnPropertyDescriptor(player.fields, '__proto__').value, 'safe');
  validateTileMap(map);
  assert.equal(map.layers[0].type, 'object');
  assert.deepEqual(
    [map.layers[0].objects[0].x, map.layers[0].objects[0].y, map.layers[0].objects[0].shape.width],
    [16, 0, 16],
    'the object holds the top left of the pivoted box',
  );
});

test('a tile bigger than the cell lands on the cell its bottom left is in, and mixed grids use their common divisor', () => {
  const { map } = parseLDtk(
    project([
      level([
        tilesLayer('Trees', [tile(16, 0, 1)], { __tilesetDefUid: 11, __gridSize: 32 }),
        tilesLayer('Ground', [tile(16, 16, 0)]),
      ]),
    ]),
  ).levels[0];
  assert.equal(map.tileWidth, 16, 'the common divisor of 32 and 16');
  const trees = map.layers.find((l) => l.name === 'Trees');
  // 32 tall at y 0 ends at pixel 32: bottom cell row 1.
  assert.equal(trees.data[1 * 2 + 1], 4);
});

test('overrideTilesetUid wins over the layer tileset', () => {
  const { map } = parseLDtk(
    project([level([tilesLayer('L', [tile(0, 0, 1)], { overrideTilesetUid: 11, __gridSize: 16 })])]),
  ).levels[0];
  assert.equal(decodeTile(map.layers[0].data[2]).gid, 4);
});

test('off-grid tiles and per-tile alpha warn', () => {
  const warnings = [];
  const { map } = parseLDtk(
    project([level([tilesLayer('L', [tile(3, 0, 0), tile(0, 16, 0, 0, 0.5), tile(320, 0, 0)])])]),
    {
      onWarning: (w) => warnings.push(w),
    },
  ).levels[0];
  assert.deepEqual([...map.layers[0].data], [1, 0, 1, 0]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /2 tiles off the grid/);
  assert.match(warnings[1], /1 tiles have their own alpha/);
});

test('multi-world projects read every world', () => {
  const { levels } = parseLDtk({
    jsonVersion: '1.5.3',
    defs,
    levels: [],
    worlds: [
      { identifier: 'A', levels: [level([], { identifier: 'a1' })] },
      { identifier: 'B', levels: [level([], { identifier: 'b1' }), level([], { identifier: 'b2' })] },
    ],
  });
  assert.deepEqual(
    levels.map((l) => [l.world, l.name]),
    [
      ['A', 'a1'],
      ['B', 'b1'],
      ['B', 'b2'],
    ],
  );
});

test('text and UTF-8 bytes parse the same as the object', () => {
  const object = project([level([tilesLayer('L', [tile(0, 0, 0)])])]),
    text = JSON.stringify(object);
  assert.deepEqual([...parseLDtk(text).levels[0].map.layers[0].data], [1, 0, 0, 0]);
  assert.deepEqual([...parseLDtk(new TextEncoder().encode(text)).levels[0].map.layers[0].data], [1, 0, 0, 0]);
});

const coded = (input, code, pattern, options) =>
  assert.throws(
    () => parseLDtk(input, options),
    (error) => {
      assert.ok(error instanceof MapImportError);
      assert.equal(error.code, code);
      assert.equal(error.format, 'LDtk');
      assert.match(error.message, pattern);
      return true;
    },
  );

test('bad input throws coded errors that name the fix', () => {
  coded('{not json', 'syntax', /not valid JSON/);
  coded('[]', 'syntax', /JSON object/);
  coded({ levels: [] }, 'syntax', /\.ldtk project file/);
  coded(project([level(null, { externalRelPath: 'a.ldtkl' })]), 'unsupported', /separate files/);
  coded(project([level([{ ...tilesLayer('X', []), __type: 'Other' }])]), 'unsupported', /IntGrid, Entities/);
  coded(
    project([level([{ ...tilesLayer('I', []), __type: 'IntGrid', intGridCsv: [1] }])]),
    'truncated',
    /1 intGridCsv values/,
  );
  coded(project([level([tilesLayer('L', [tile(0, 0, 99)])])]), 'syntax', /outside tileset/);
  coded(project([level([tilesLayer('L', [{ t: 0 }])])]), 'syntax', /no px/);
  coded(project([level([tilesLayer('L', [tile(0, 0, 0)], { __tilesetDefUid: 77 })])]), 'missing', /tileset 77/);
  coded(project([level([], { pxWid: 16 * 5000, pxHei: 16 * 5000 })]), 'limit', /split the level/);
  coded({ jsonVersion: '1', levels: [], defs: { tilesets: [{ identifier: 'T' }] } }, 'missing', /tileset "T"/);
  coded(
    project([level([{ ...tilesLayer('I', []), __type: 'IntGrid', __cWid: 5000, __cHei: 5000 }])]),
    'limit',
    /split the level/,
  );
  const stop = new AbortController();
  stop.abort();
  coded(project([]), 'aborted', /aborted/, { signal: stop.signal });
});
