import assert from 'node:assert/strict';
import test from 'node:test';
import { Tileset, cartographicToEcef } from '../dist/index.js';
import { parseS2Token, s2, s2Bounds, s2CellBounds, s2LonLat, s2Token } from '../dist/s2.js';
import { memoryFetch, settle, subtree } from './generator.js';

const encoder = new TextEncoder();
const morton = (m) => {
  let x = 0,
    y = 0;
  for (let b = 0; b < 16; b++) {
    x |= ((m >> (2 * b)) & 1) << b;
    y |= ((m >> (2 * b + 1)) & 1) << b;
  }
  return [x, y];
};
/** Unit vector of a cell point (fractions s, t across it), from its longitude and latitude. */
const unit = (cell, s, t) => {
  const [lon, lat] = s2LonLat(cell, s, t);
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};

test('S2 tokens: the extension README ids and tokens, root cell 1 down three levels', () => {
  // The README's table: token, decimal cell ID, level.
  const rows = [
    ['3', 3458764513820540928n, 0],
    ['2c', 3170534137668829184n, 1],
    ['2f', 3386706919782612992n, 2],
    ['2e4', 3332663724254167040n, 3],
  ];
  let parent;
  for (const [token, id, level] of rows) {
    assert.equal(BigInt(`0x${token.padEnd(16, '0')}`), id);
    const cell = parseS2Token(token);
    assert.equal(cell.face, 1);
    assert.equal(cell.level, level);
    assert.equal(s2Token(cell), token);
    if (parent) {
      // Each is a child of the one before: its (i, j) halves to the parent's.
      assert.equal(Math.floor(cell.i / 2), parent.i);
      assert.equal(Math.floor(cell.j / 2), parent.j);
    }
    parent = cell;
  }
});

test('S2 tokens: the README availability figure, face 0 children in Morton order of (i, j)', () => {
  // "S2 cells in Morton order" of the extension's availability figure: level 1, then level 2, of root cell "1".
  const level1 = ['04', '1c', '0c', '14'],
    level2 = ['01', '03', '07', '05', '1d', '1f', '1b', '19', '09', '0f', '0b', '0d', '11', '17', '13', '15'];
  assert.equal(s2Token({ face: 0, level: 0, i: 0, j: 0 }), '1');
  for (const [level, tokens] of [
    [1, level1],
    [2, level2],
  ])
    tokens.forEach((token, m) => {
      const [i, j] = morton(m);
      assert.equal(s2Token({ face: 0, level, i, j }), token, `level ${level} Morton ${m}`);
      assert.deepEqual(parseS2Token(token), { face: 0, level, i, j });
    });
});

test('S2 tokens: malformed tokens are refused with a TypeError naming the problem', () => {
  for (const bad of ['', 'xyz', '0', 'd', '12345678901234567', '18'])
    assert.throws(() => parseS2Token(bad), TypeError, bad);
  assert.throws(() => s2Token({ face: 6, level: 0, i: 0, j: 0 }), RangeError);
  assert.throws(() => s2Token({ face: 0, level: 1, i: 2, j: 0 }), RangeError);
});

test('S2 cells: the README example "89c6c7" covers Philadelphia Center City', () => {
  const cell = parseS2Token('89c6c7');
  assert.equal(cell.face, 4);
  assert.equal(cell.level, 10);
  const [lon, lat] = s2LonLat(cell),
    centre = cartographicToEcef(lon, lat),
    city = cartographicToEcef((-75.1652 * Math.PI) / 180, (39.9526 * Math.PI) / 180),
    corner = cartographicToEcef(...s2LonLat(cell, 0, 0)),
    reach = Math.hypot(...corner.map((v, k) => v - centre[k]));
  // A level-10 cell is about 7 to 10 km across; City Hall lies inside it, so within its centre-to-corner reach.
  assert.ok(reach > 3_000 && reach < 10_000, `reach ${reach}`);
  assert.ok(Math.hypot(...city.map((v, k) => v - centre[k])) < reach, 'City Hall is in the cell');
});

test('S2 cells: the curve runs on, every cell shares an edge with the next, across all six faces', () => {
  const level = 3,
    cells = [];
  for (let face = 0; face < 6; face++)
    for (let p = 0; p < 4 ** level; p++) {
      const id = (BigInt(face) << 61n) | (BigInt(p) << BigInt(61 - 2 * level)) | (1n << BigInt(60 - 2 * level));
      cells.push(parseS2Token(id.toString(16).padStart(16, '0').replace(/0+$/, '')));
    }
  const corners = (c) => [unit(c, 0, 0), unit(c, 1, 0), unit(c, 0, 1), unit(c, 1, 1)];
  for (let k = 0; k < cells.length; k++) {
    const a = corners(cells[k]),
      b = corners(cells[(k + 1) % cells.length]);
    const shared = a.filter((p) => b.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-12)).length;
    assert.equal(shared, 2, `cell ${k} (${JSON.stringify(cells[k])}) and the next share an edge`);
  }
});

test('S2 volumes: the box holds every point of the extruded cell, and is tight for small cells', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cases = [
    ['1', 0, 1_000_000],
    ['3', -500, 250_000],
    ['89c6c7', 0, 1000],
    ['89c6c7ab', -50, 300],
    [s2Token({ face: 2, level: 6, i: 31, j: 32 }), 0, 100], // at the north pole
    [s2Token({ face: 5, level: 12, i: 0, j: 4095 }), 0, 10], // a corner of the south face
  ];
  for (const [token, min, max] of cases) {
    const cell = parseS2Token(token),
      bounds = s2CellBounds(cell, min, max),
      h = bounds.halfAxes,
      lengths = [0, 1, 2].map((a) => Math.hypot(h[a * 3], h[a * 3 + 1], h[a * 3 + 2]));
    const used = [0, 0, 0];
    for (let n = 0; n < 4000; n++) {
      const s = n < 4 ? n & 1 : random(),
        t = n < 4 ? n >> 1 : random(),
        height = n % 3 === 0 ? min : n % 3 === 1 ? max : min + random() * (max - min),
        p = cartographicToEcef(...s2LonLat(cell, s, t), height);
      for (let a = 0; a < 3; a++) {
        const d =
          ((p[0] - bounds.center[0]) * h[a * 3] +
            (p[1] - bounds.center[1]) * h[a * 3 + 1] +
            (p[2] - bounds.center[2]) * h[a * 3 + 2]) /
          lengths[a];
        // Inside, to float64 rounding at earth scale (1e-6 m).
        assert.ok(Math.abs(d) <= lengths[a] + 1e-6, `${token}: axis ${a} ${Math.abs(d)} > ${lengths[a]}`);
        used[a] = Math.max(used[a], Math.abs(d));
      }
    }
    // The padding is the sagitta of a 16th of the cell: for a cell under 1,000 km it adds under 1% per axis
    // beyond what 4,000 samples reach (and for the flat axis of a short cell, at most a few metres).
    if (cell.level >= 6)
      for (let a = 0; a < 3; a++)
        assert.ok(
          lengths[a] - used[a] <= 0.01 * lengths[a] + 5,
          `${token} axis ${a} loose: ${lengths[a]} vs ${used[a]}`,
        );
  }
});

const s2Volume = (token, minimumHeight, maximumHeight) => ({
  extensions: { '3DTILES_bounding_volume_S2': { token, minimumHeight, maximumHeight } },
});

test('S2 tilesets: the README example loads with boundingVolumes: [s2], and is refused without it', async () => {
  const tileset = {
    asset: { version: '1.1' },
    geometricError: 1_000_000,
    extensionsUsed: ['3DTILES_bounding_volume_S2'],
    extensionsRequired: ['3DTILES_bounding_volume_S2'],
    root: {
      boundingVolume: s2Volume('3', 0, 1_000_000),
      refine: 'REPLACE',
      geometricError: 50_000,
      children: [
        {
          boundingVolume: s2Volume('2c', 0, 500_000),
          geometricError: 500_000,
          children: [
            {
              boundingVolume: s2Volume('2f', 0, 250_000),
              geometricError: 250_000,
              children: [{ boundingVolume: s2Volume('2ec', 0, 125_000), geometricError: 125_000 }],
            },
          ],
        },
      ],
    },
  };
  const memory = memoryFetch(new Map([['tileset.json', encoder.encode(JSON.stringify(tileset))]]));
  await assert.rejects(
    Tileset.load(memory.url, { fetch: memory.fetch }),
    (e) => e.code === 'unsupported' && /tiles\/s2/.test(e.message),
  );
  const loaded = await Tileset.load(memory.url, { fetch: memory.fetch, boundingVolumes: [s2] });
  let tile = loaded.root;
  for (const token of ['3', '2c', '2f', '2ec']) {
    assert.deepEqual([...tile.bounds.center], [...s2Bounds({ token, ...heightsOf(token) }).center], token);
    tile = tile.children[0];
  }
  // A tile transform does not move an S2 volume (the extension ignores it).
  const moved = structuredClone(tileset);
  moved.root.transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1e6, 0, 0, 1];
  const memory2 = memoryFetch(new Map([['tileset.json', encoder.encode(JSON.stringify(moved))]]));
  const shifted = await Tileset.load(memory2.url, { fetch: memory2.fetch, boundingVolumes: [s2] });
  assert.deepEqual([...shifted.root.bounds.center], [...loaded.root.bounds.center]);
  // Selection measures distance to the S2 boxes: 2,000 km above the face-1 cell the root (up to 1,000 km high) is
  // nearer than the camera's height, and a camera on the ground inside the cell is inside the root volume.
  loaded.update({ position: cartographicToEcef(Math.PI / 2, 0.3, 2_000_000), screenHeight: 1080, fov: 60 });
  assert.ok(loaded.root.distance > 0 && loaded.root.distance < 2_000_000, `distance ${loaded.root.distance}`);
  loaded.update({ position: cartographicToEcef(Math.PI / 2, 0.3, 10), screenHeight: 1080, fov: 60 });
  assert.equal(loaded.root.distance, 0);
});
const heightsOf = (token) => ({
  minimumHeight: 0,
  maximumHeight: { 3: 1_000_000, '2c': 500_000, '2f': 250_000, '2ec': 125_000 }[token],
});

test('S2 implicit tiling: a quadtree child is the S2 child cell at Morton (x, y), an octree child its height slab', async () => {
  for (const scheme of ['QUADTREE', 'OCTREE']) {
    const tileset = {
      asset: { version: '1.1' },
      geometricError: 10_000,
      extensionsRequired: ['3DTILES_bounding_volume_S2'],
      root: {
        boundingVolume: s2Volume('04', 0, 500_000),
        refine: 'REPLACE',
        geometricError: 5_000,
        implicitTiling: {
          subdivisionScheme: scheme,
          subtreeLevels: 2,
          availableLevels: 2,
          subtrees: { uri: 'subtrees/{level}/{x}/{y}.subtree' },
        },
      },
    };
    const files = new Map([
      ['tileset.json', encoder.encode(JSON.stringify(tileset))],
      ['subtrees/0/0/0.subtree', subtree({ tiles: 1, contents: 0, children: 0 })],
    ]);
    const memory = memoryFetch(files),
      loaded = await Tileset.load(memory.url, { fetch: memory.fetch, boundingVolumes: [s2] });
    for (let i = 0; i < 20 && !loaded.root.children.length; i++) {
      loaded.update({ position: cartographicToEcef(0.3, 0.3, 100_000), screenHeight: 1080, fov: 60 });
      await settle(4);
    }
    assert.equal(loaded.root.children.length, scheme === 'OCTREE' ? 8 : 4, scheme);
    for (const child of loaded.root.children) {
      const { x, y, z } = child.implicit,
        token = ['01', '03', '07', '05', '1d', '1f', '1b', '19', '09', '0f', '0b', '0d', '11', '17', '13', '15'][
          mortonIndex2(x, y)
        ],
        heights = scheme === 'OCTREE' ? [z * 250_000, (z + 1) * 250_000] : [0, 500_000],
        want = s2Bounds({ token, minimumHeight: heights[0], maximumHeight: heights[1] });
      for (let k = 0; k < 3; k++)
        assert.ok(Math.abs(child.bounds.center[k] - want.center[k]) < 1e-6, `${scheme} ${x} ${y} ${z}`);
    }
  }
});
/** Root "04" is face 0 level 1 at (0, 0): its children are the level-2 cells (x, y), Morton index in the figure. */
const mortonIndex2 = (x, y) => (x & 1) | ((y & 1) << 1) | ((x & 2) << 1) | ((y & 2) << 2);
