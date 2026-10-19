import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, gzipSync } from 'node:zlib';
import { LoaderError, parseTMX, tmxLayerQuads } from '../dist/index.js';

const close = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
};
const rejects = (promise, code, pattern) =>
  assert.rejects(
    promise,
    (error) => error instanceof LoaderError && error.code === code && (!pattern || pattern.test(error.message)),
  );
const H = 0x80000000,
  V = 0x40000000,
  D = 0x20000000,
  HEX = 0x10000000;
/** Little-endian uint32 cells, base64-encoded after an optional compressor: the writer half of a round trip. */
const encode = (gids, compress = (bytes) => bytes) =>
  Buffer.from(compress(Buffer.from(new Uint32Array(gids.map((g) => g >>> 0)).buffer))).toString('base64');

const ATLAS =
  '<tileset firstgid="1" name="atlas" tilewidth="16" tileheight="16" tilecount="12" columns="4">' +
  '<image source="tiles/atlas.png" width="64" height="48"/></tileset>';
const map = (body, attributes = 'width="3" height="2"') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.10" orientation="orthogonal" renderorder="right-down" ${attributes} tilewidth="16" tileheight="16" infinite="0">${body}</map>`;

// Row 0: plain, horizontal, vertical; row 1: diagonal, hex-rotate bit (cleared), empty.
const CSV_GIDS = [1, H + 2, V + 3, D + 4, HEX + 5, 0];
const CSV = map(
  `<properties><property name="title" value="demo"/><property name="level" type="int" value="3"/></properties>${ATLAS}` +
    `<layer id="1" name="Ground" width="3" height="2" offsetx="8"><data encoding="csv">\n${CSV_GIDS.slice(0, 3).join(',')},\n${CSV_GIDS.slice(3).join(',')}\n</data></layer>`,
);

test('TMX: map attributes, embedded tileset, csv data and GID flip bits', async () => {
  const tmx = await parseTMX(new TextEncoder().encode(CSV));
  assert.deepEqual(
    { ...tmx, tilesets: undefined, layers: undefined, properties: { ...tmx.properties } },
    {
      orientation: 'orthogonal',
      renderorder: 'right-down',
      width: 3,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      infinite: false,
      tilesets: undefined,
      tilesetRefs: [{ firstgid: 1, tileset: 0 }],
      layers: undefined,
      properties: { title: 'demo', level: 3 },
      warnings: [],
    },
  );
  assert.deepEqual(tmx.tilesets, [
    {
      name: 'atlas',
      tilewidth: 16,
      tileheight: 16,
      spacing: 0,
      margin: 0,
      columns: 4,
      tilecount: 12,
      image: { path: 'tiles/atlas.png', width: 64, height: 48 },
      properties: Object.create(null),
    },
  ]);
  const [layer] = tmx.layers;
  assert.equal(layer.type, 'tile');
  assert.equal(layer.name, 'Ground');
  assert.equal(layer.id, 1);
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height, layer.offsetx, layer.visible], [0, 0, 3, 2, 8, true]);
  assert.deepEqual([...layer.gids], [1, 2, 3, 4, 5, 0]);
  assert.deepEqual([...layer.flips], [0, 1, 2, 4, 0, 0]);
});

test('tmxLayerQuads: XZ quads, atlas UVs with every flip, layer offset, faceSizes', async () => {
  const tmx = await parseTMX(CSV);
  const quads = tmxLayerQuads(tmx, tmx.layers[0], { tileSize: 2 });
  assert.equal(quads.kind, 'mesh');
  assert.deepEqual([...quads.cells], [0, 1, 2, 3, 4]);
  assert.deepEqual([...quads.faceSizes], [4, 4, 4, 4, 4]);
  assert.deepEqual([...quads.indices.subarray(0, 12)], [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  assert.deepEqual(quads.groups, [{ start: 0, count: 30, tileset: 0, name: 'atlas' }]);
  // Cell (1, 0): x 2..4 plus the 8 px offset (half a cell = 1 unit), z 0..2; corners TL, BL, BR, TR; normal +Y.
  close(quads.positions.subarray(12, 24), [3, 0, 0, 3, 0, 2, 5, 0, 2, 5, 0, 0], 'positions');
  close(quads.normals.subarray(12, 15), [0, 1, 0], 'normal');
  const third = 1 / 3,
    uv = (q) => quads.uvs.subarray(q * 8, q * 8 + 8);
  close(uv(0), [0, 0, 0, third, 0.25, third, 0.25, 0], 'plain');
  close(uv(1), [0.5, 0, 0.5, third, 0.25, third, 0.25, 0], 'horizontal');
  close(uv(2), [0.5, third, 0.5, 0, 0.75, 0, 0.75, third], 'vertical');
  close(uv(3), [0.75, 0, 1, 0, 1, third, 0.75, third], 'diagonal');
  close(uv(4), [0, 16 / 48, 0, 32 / 48, 0.25, 32 / 48, 0.25, 16 / 48], 'hex bit cleared');
  // Diagonal + horizontal is a 90 degree clockwise turn: the top-left corner shows the tile's bottom-left texel.
  const turned = await parseTMX(CSV.replace(`${H + 2},`, `${D + H + 1},`));
  close(tmxLayerQuads(turned, turned.layers[0]).uvs.subarray(8, 16), [0, third, 0.25, third, 0.25, 0, 0, 0], 'turned');
  assert.throws(() => tmxLayerQuads(tmx, tmx.layers[0], { tileSize: 0 }), RangeError);
  assert.throws(() => tmxLayerQuads(tmx, { type: 'object' }), TypeError);
  const past = await parseTMX(CSV.replace(`${D + 4},`, '13,'));
  assert.throws(
    () => tmxLayerQuads(past, past.layers[0]),
    (e) => e instanceof LoaderError && e.code === 'range',
  );
});

test('TMX: base64 plain, zlib and gzip, legacy <tile> data and object layers round-trip the same gids', async () => {
  const gids = [1, H + 2, 0, V + D + 12, 7, 8];
  const layer = (name, data) => `<layer name="${name}" width="3" height="2">${data}</layer>`;
  const tmx = await parseTMX(
    map(
      ATLAS +
        layer('plain', `<data encoding="base64">${encode(gids)}</data>`) +
        layer('zlib', `<data encoding="base64" compression="zlib">\n   ${encode(gids, deflateSync)}\n  </data>`) +
        layer('gzip', `<data encoding="base64" compression="gzip">${encode(gids, gzipSync)}</data>`) +
        layer('xml', `<data>${gids.map((g) => (g ? `<tile gid="${g >>> 0}"/>` : '<tile/>')).join('')}</data>`) +
        '<objectgroup id="9" name="Spawns" visible="0"><object id="3" name="hero" type="player" x="16" y="32.5" ' +
        `width="16" height="16" rotation="90" gid="${H + 5}"><properties><property name="hp" type="int" value="10"/>` +
        '<property name="speed" type="float" value="1.5"/><property name="boss" type="bool" value="false"/>' +
        '<property name="note">multi\nline</property></properties></object><object id="4" class="door" x="1" y="2"/>' +
        '</objectgroup>',
    ),
  );
  for (const tile of tmx.layers.slice(0, 4)) {
    assert.deepEqual([...tile.gids], [1, 2, 0, 12, 7, 8], tile.name);
    assert.deepEqual([...tile.flips], [0, 1, 0, 6, 0, 0], tile.name);
  }
  const objects = tmx.layers[4];
  assert.deepEqual([objects.type, objects.name, objects.id, objects.visible], ['object', 'Spawns', 9, false]);
  assert.deepEqual(
    objects.objects.map((o) => ({ ...o, properties: { ...o.properties } })),
    [
      {
        id: 3,
        name: 'hero',
        type: 'player',
        x: 16,
        y: 32.5,
        width: 16,
        height: 16,
        rotation: 90,
        visible: true,
        gid: 5,
        flips: 1,
        properties: { hp: 10, speed: 1.5, boss: false, note: 'multi\nline' },
      },
      { id: 4, name: '', type: 'door', x: 1, y: 2, width: 0, height: 0, rotation: 0, visible: true, properties: {} },
    ],
  );
});

const TERRAIN_TSX = `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" name="terrain" tilewidth="16" tileheight="16" spacing="2" margin="1" tilecount="6" columns="3">
 <image source="../tiles/terrain.png" width="56" height="38"/>
</tileset>`;

test('TMX: external TSX through the resolver, tilesets merged by image and grid, spacing and margin in UVs', async () => {
  const requested = [];
  const resolve = async (path) => {
    requested.push(path);
    if (path === 'sets/terrain.tsx') return new TextEncoder().encode(TERRAIN_TSX);
    throw new Error(`no file ${path}`);
  };
  const xml = map(
    `${ATLAS}<tileset firstgid="13" source="sets/terrain.tsx"/><tileset firstgid="19" source="./sets/terrain.tsx"/>` +
      '<tileset firstgid="25" name="copy" tilewidth="16" tileheight="16" spacing="2" margin="1" tilecount="6" columns="3">' +
      '<image source="tiles/terrain.png" width="56" height="38"/></tileset>' +
      '<layer name="L" width="3" height="1"><data encoding="csv">17,1,30</data></layer>',
    'width="3" height="1"',
  );
  const tmx = await parseTMX(xml, { resolve });
  assert.deepEqual(requested, ['sets/terrain.tsx']);
  assert.equal(tmx.tilesets.length, 2);
  assert.deepEqual(tmx.tilesets[1].image, { path: 'tiles/terrain.png', width: 56, height: 38 });
  assert.equal(tmx.tilesets[1].source, 'sets/terrain.tsx');
  assert.deepEqual(tmx.tilesetRefs, [
    { firstgid: 1, tileset: 0 },
    { firstgid: 13, tileset: 1 },
    { firstgid: 19, tileset: 1 },
    { firstgid: 25, tileset: 1 },
  ]);
  const quads = tmxLayerQuads(tmx, tmx.layers[0]);
  // Grouped by tileset: the atlas tile first, then both terrain tiles.
  assert.deepEqual([...quads.cells], [1, 0, 2]);
  assert.deepEqual(
    quads.groups.map((g) => [g.start, g.count, g.tileset]),
    [
      [0, 6, 0],
      [6, 12, 1],
    ],
  );
  // gid 17 = terrain tile 4: column 1, row 1 -> pixel (1 + 18, 1 + 18).
  close(quads.uvs.subarray(8, 10), [19 / 56, 19 / 38], 'spacing and margin');
  // gid 30 = copy tile 5: column 2, row 1 -> pixel (1 + 36, 19); the copy shares the terrain tileset.
  close(quads.uvs.subarray(16, 18), [37 / 56, 19 / 38], 'merged copy');
  await rejects(parseTMX(xml), 'fetch', /tileset "sets\/terrain.tsx" is external; pass resolve/);
  await rejects(parseTMX(xml, { resolve: async () => Promise.reject(new Error('denied')) }), 'fetch', /denied/);
  await rejects(parseTMX(xml, { resolve: async () => '<map/>' }), 'header', /not <tileset>/);
  await assert.rejects(parseTMX(xml, { resolve: 'sets' }), TypeError);
});

test('TMX: infinite chunks become one grid; groups flatten with combined offsets, opacity and visibility', async () => {
  const xml = map(
    `${ATLAS}<layer name="world" width="4" height="4"><data encoding="csv">` +
      '<chunk x="-2" y="0" width="2" height="2">1,2,3,4</chunk>' +
      '<chunk x="0" y="2" width="2" height="2">5,6,7,8</chunk></data></layer>' +
      '<layer name="empty" width="4" height="4"><data encoding="csv"/></layer>' +
      '<group name="outer" offsetx="10" offsety="5" opacity="0.5">' +
      '<group name="hidden" visible="0" offsetx="1"><objectgroup name="deep" offsety="1"/></group>' +
      '<layer name="inner" width="4" height="4" offsetx="1" offsety="2" opacity="0.5"><data encoding="csv">' +
      '<chunk x="0" y="0" width="1" height="1">9</chunk></data></layer>' +
      '<imagelayer name="sky"><image source="sky.png"/></imagelayer></group>',
    'width="4" height="4" infinite="1"',
  ).replace('infinite="0"', '');
  const tmx = await parseTMX(xml);
  assert.equal(tmx.infinite, true);
  const [world, empty, deep, inner] = tmx.layers;
  assert.deepEqual([world.x, world.y, world.width, world.height], [-2, 0, 4, 4]);
  assert.deepEqual([...world.gids], [1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 5, 6, 0, 0, 7, 8]);
  assert.deepEqual([empty.width, empty.height, empty.gids.length], [0, 0, 0]);
  assert.deepEqual([deep.type, deep.offsetx, deep.offsety, deep.visible, deep.opacity], ['object', 11, 6, false, 0.5]);
  assert.deepEqual(
    [inner.offsetx, inner.offsety, inner.opacity, inner.visible, [...inner.gids]],
    [11, 7, 0.25, true, [9]],
  );
  assert.deepEqual(tmx.warnings, ['image layer "sky" is not imported']);
  // Chunk cells keep their map position: cell (-2, 0) starts at x = -2.
  close(tmxLayerQuads(tmx, world).positions.subarray(0, 3), [-2, 0, 0], 'chunk origin');
});

test('TMX: unsupported and malformed maps are rejected with clear errors', async () => {
  const data = (attributes, body) =>
    map(`${ATLAS}<layer name="L" width="3" height="2"><data ${attributes}>${body}</data></layer>`);
  await rejects(
    parseTMX(map('').replace('orthogonal', 'isometric')),
    'unsupported',
    /isometric maps are not supported/,
  );
  await rejects(parseTMX('<tileset/>'), 'header', /not <map>/);
  await rejects(parseTMX(data('encoding="base64" compression="zstd"', 'AAAA')), 'unsupported', /zstd/);
  await rejects(parseTMX(data('encoding="base64" compression="lz4"', 'AAAA')), 'unsupported', /lz4/);
  await rejects(parseTMX(data('encoding="hex"', '00')), 'unsupported', /encoding "hex"/);
  await rejects(parseTMX(data('encoding="csv"', '1,2,3')), 'syntax', /3 csv values, expected 6/);
  await rejects(parseTMX(data('encoding="csv"', '1,2,3,4,5,x')), 'syntax', /invalid gid "x"/);
  await rejects(parseTMX(data('encoding="base64"', '!!!')), 'syntax', /not valid base64/);
  await rejects(parseTMX(data('encoding="base64"', encode([1, 2, 3]))), 'syntax', /12 bytes, expected 24/);
  await rejects(
    parseTMX(
      data(
        'encoding="base64" compression="zlib"',
        encode([1], () => Buffer.from('nonsense')),
      ),
    ),
    'zip',
  );
  await rejects(
    parseTMX(data('encoding="base64" compression="zlib"', encode(new Array(1000).fill(1), deflateSync))),
    'zip',
    /inflates past its declared size of 24 bytes/,
  );
  await rejects(parseTMX(data('', '<tile gid="1"/>')), 'syntax', /1 <tile>s, expected 6/);
  await rejects(parseTMX(map(`${ATLAS}<layer name="L"/>`)), 'syntax', /has no <data>/);
  await rejects(
    parseTMX(map(ATLAS, 'width="5000" height="5000"').replace('</map>', '<layer name="big"><data/></layer></map>')),
    'limit',
  );
  await rejects(
    parseTMX(map(ATLAS.replace('tilewidth="16"', 'tilewidth="0"'))),
    'syntax',
    /tilewidth must be an integer of at least 1/,
  );
  const controller = new AbortController();
  controller.abort();
  await rejects(parseTMX(CSV, { signal: controller.signal }), 'aborted');
});
