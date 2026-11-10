import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTiled, MapImportError } from '../dist/tiled.js';
import { resolveWang } from '../dist/autotile.js';
import { FLIP_H, validateTileMap } from '../dist/index.js';
import { buildMapQuads } from '../dist/objects.js';
const base = (extra) => ({ width: 2, height: 1, tilewidth: 4, tileheight: 4, tilesets: [], layers: [], ...extra });
test('XML templates inherit shape/style/properties and local overrides including false and zero', async () => {
  const calls = [];
  const map = await parseTiled(
    base({
      layers: [
        {
          type: 'objectgroup',
          name: 'objects',
          draworder: 'index',
          objects: [
            {
              id: 7,
              x: 0,
              y: 2,
              template: 'templates/sign.tx',
              visible: false,
              rotation: 0,
              properties: [{ name: 'hp', value: 0 }],
            },
            { id: 8, x: 5, y: 2, template: 'templates/sign.tx' },
          ],
        },
      ],
    }),
    {
      baseUrl: 'maps/level.tmj',
      resolve: async (path) => {
        calls.push(path);
        return '<template><object name="sign" width="12" height="8" rotation="45"><properties><property name="hp" type="int" value="10"/><property name="solid" type="bool" value="true"/></properties><text bold="1" kerning="0" pixelsize="20" color="#ff8800" halign="center" valign="bottom">Hello &amp; world</text></object></template>';
      },
    },
  );
  assert.deepEqual(calls, ['maps/templates/sign.tx']);
  const [a, b] = map.layers[0].objects;
  assert.equal(map.layers[0].drawOrder, 'index');
  assert.equal(a.rotation, undefined);
  assert.equal(a.visible, false);
  assert.deepEqual(a.properties, { hp: 0, solid: true });
  assert.equal(b.properties.hp, 10);
  assert.equal(b.rotation, 45);
  assert.deepEqual(a.text, {
    text: 'Hello & world',
    fontFamily: 'sans-serif',
    pixelSize: 20,
    color: '#ff8800',
    bold: true,
    italic: false,
    underline: false,
    strikeout: false,
    kerning: false,
    wrap: false,
    horizontalAlign: 'center',
    verticalAlign: 'bottom',
  });
  validateTileMap(map);
});
test('template tile gid remaps by external tileset identity, including flips and relative image paths', async () => {
  const files = {
    'tiles/props.tsx':
      '<tileset name="props" tilewidth="4" tileheight="4" tilecount="1" columns="1" objectalignment="center"><image source="img/props.png" width="4" height="4"/></tileset>',
    'objects/tree.tx': `<template><tileset firstgid="1" source="../tiles/props.tsx"/><object gid="${(1 | FLIP_H) >>> 0}" width="8" height="8"/></template>`,
  };
  const map = await parseTiled(
    base({
      tilesets: [{ firstgid: 10, source: 'tiles/props.tsx' }],
      layers: [{ type: 'objectgroup', name: 'props', objects: [{ id: 1, x: 4, y: 4, template: 'objects/tree.tx' }] }],
    }),
    {
      resolve: async (p) => {
        assert.ok(p in files, p);
        return files[p];
      },
    },
  );
  assert.equal(map.tilesets.length, 1);
  assert.equal(map.tilesets[0].image.source, 'tiles/img/props.png');
  assert.equal(map.layers[0].objects[0].gid, (10 | FLIP_H) >>> 0);
  const [q] = buildMapQuads(map);
  assert.deepEqual(q.origin, [0, 0]);
  assert.equal(q.flags, 1);
  assert.equal(map.tilesets[0].objectAlignment, 'center');
});
test('template-only tilesets are added once, sparse collection ids retain their gid span', async () => {
  const files = {
    'obj/item.tj': { tileset: { firstgid: 1, source: '../tiles/items.tsj' }, object: { gid: 8 } },
    'tiles/items.tsj': {
      name: 'items',
      tilewidth: 4,
      tileheight: 4,
      columns: 0,
      tilecount: 1,
      tiles: [{ id: 7, image: 'item.png', imagewidth: 3, imageheight: 5 }],
    },
  };
  const map = await parseTiled(
    base({
      layers: [
        {
          type: 'objectgroup',
          name: 'items',
          objects: [
            { id: 1, template: 'obj/item.tj', x: 0, y: 5 },
            { id: 2, template: 'obj/item.tj', x: 3, y: 5 },
          ],
        },
      ],
    }),
    { resolve: async (p) => files[p] },
  );
  assert.equal(map.tilesets.length, 1);
  assert.equal(map.tilesets[0].tileCount, 8);
  assert.deepEqual(
    buildMapQuads(map).map((q) => q.source),
    ['tiles/item.png', 'tiles/item.png'],
  );
  validateTileMap(map);
});
test('XML map, external TSX, image layers, text and CSV use the same import model', async () => {
  const map = await parseTiled(
    '<map width="2" height="1" tilewidth="4" tileheight="4" renderorder="left-up"><tileset firstgid="1" source="tiles.tsx"/><layer name="ground" width="2" height="1"><data encoding="csv">1,1</data></layer><group offsetx="2" opacity="0.5" tintcolor="#ff8080"><imagelayer name="sky" repeatx="1" tintcolor="#80ffff" offsety="3"><image source="sky.png" width="4" height="2"/></imagelayer><objectgroup name="labels"><object id="2" x="4" y="5"><text wrap="1">Hi</text></object></objectgroup></group></map>',
    {
      resolve: async () =>
        '<tileset name="tiles" tilewidth="4" tileheight="4" columns="1" tilecount="1"><image source="a.png" width="4" height="4"/></tileset>',
    },
  );
  assert.equal(map.renderOrder, 'left-up');
  assert.deepEqual([...map.layers[0].data], [1, 1]);
  const image = map.layers[1];
  assert.equal(image.type, 'image');
  assert.equal(image.repeatX, true);
  assert.deepEqual(image.offset, [2, 3]);
  assert.equal(image.tint, '#ff808080');
  assert.equal(image.opacity, 0.5);
  assert.equal(map.layers[2].objects[0].text.wrap, true);
});
test('missing template resolver, cycles, bad XML and pending cancellation reject with codes', async () => {
  const input = base({ layers: [{ type: 'objectgroup', objects: [{ id: 1, template: 'a.tx' }] }] });
  await assert.rejects(parseTiled(input), (e) => e instanceof MapImportError && e.code === 'missing');
  await assert.rejects(
    parseTiled(input, { resolve: async () => ({ object: { template: 'a.tx' } }) }),
    (e) => e.code === 'limit',
  );
  await assert.rejects(parseTiled('<map><layer></map>'), (e) => e.code === 'syntax');
  const controller = new AbortController();
  const task = parseTiled(input, { signal: controller.signal, resolve: () => new Promise(() => {}) });
  queueMicrotask(() => controller.abort());
  await assert.rejects(task, (e) => e.code === 'aborted');
});
test('imported mixed Wang rules resolve every edge and corner, weights are seeded and zero excludes variants', async () => {
  const pattern = [1, 2, 2, 1, 1, 2, 2, 1];
  const tileset = {
    firstgid: 10,
    name: 'wang',
    tilewidth: 4,
    tileheight: 4,
    tilecount: 3,
    columns: 3,
    tiles: [
      { id: 0, probability: 0 },
      { id: 1, probability: 1 },
      { id: 2, probability: 3 },
    ],
    wangsets: [
      {
        name: 'mixed',
        type: 'mixed',
        colors: [
          { name: 'water', color: '#00ffff', tile: 0 },
          { name: 'land', color: '#00ff00', tile: 1 },
        ],
        wangtiles: [0, 1, 2].map((tileid) => ({ tileid, wangid: pattern })),
      },
    ],
  };
  const map = await parseTiled(base({ tilesets: [tileset] })),
    rules = map.tilesets[0].wangSets[0];
  assert.equal(rules.mode, 'wang');
  assert.equal(rules.colors[1].name, 'land');
  const grid = { horizontal: [1, 1], vertical: [2, 2], vertices: [1, 2, 2, 1] };
  const a = resolveWang(grid, 1, 1, rules, { firstGid: 10, seed: 5 });
  assert.ok(a[0] === 11 || a[0] === 12);
  assert.deepEqual(a, resolveWang(grid, 1, 1, rules, { firstGid: 10, seed: 5 }));
  for (const key of ['horizontal', 'vertical', 'vertices']) {
    const wrong = { ...grid, [key]: [...grid[key]] };
    wrong[key][0] = 0;
    assert.equal(resolveWang(wrong, 1, 1, rules)[0], 0, key);
  }
  assert.throws(() => resolveWang({ vertices: [9, 9, 9, 9] }, 1, 1, rules), RangeError);
});
test('XML edge Wang sets import directly as executable rules', async () => {
  const map = await parseTiled(
    '<map width="1" height="1" tilewidth="4" tileheight="4"><tileset firstgid="1" name="roads" tilewidth="4" tileheight="4" tilecount="1" columns="1"><wangsets><wangset name="roads" type="edge"><wangcolor name="road" color="#ffffff" tile="0" probability="1"/><wangtile tileid="0" wangid="1,0,1,0,1,0,1,0"/></wangset></wangsets></tileset></map>',
  );
  const rules = map.tilesets[0].wangSets[0];
  assert.deepEqual([...resolveWang({ horizontal: [1, 1], vertical: [1, 1] }, 1, 1, rules)], [1]);
});
