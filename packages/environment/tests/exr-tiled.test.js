// Tiled OpenEXR (@margoengine/environment/exr-tiled). Two independent sources of truth:
// 1. Chunks the reference OpenEXR library wrote (the synthetic, PIZ and openexr-images fixtures) repackaged as tiles.
//    A tile's pixel data is laid out as a scanline block whose lines are the tile's width (OpenEXR File Layout, "Tiled
//    Chunk Layout"), so a W x L tile holds the same bytes as an L-line chunk of a W-wide image: every codec is checked
//    against the reference library's own output.
// 2. Multi-tile, mipmap and ripmap files written here from the File Layout and Technical Introduction, with level sizes
//    checked against the Technical Introduction's 15 x 17 example table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseEXR } from '../dist/index.js';
import { parseTiledEXR } from '../dist/exr-tiled.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const LINES = { 0: 1, 1: 1, 2: 1, 3: 16, 4: 32 };

/** Splits a single-part file into its header attributes and the bytes after them. */
function attributes(bytes) {
  const list = [];
  let at = 8;
  const cstr = () => {
    const end = bytes.indexOf(0, at),
      text = Buffer.from(bytes.subarray(at, end)).toString('latin1');
    at = end + 1;
    return text;
  };
  for (;;) {
    const name = cstr();
    if (!name) break;
    const type = cstr(),
      size = bytes.readInt32LE(at);
    list.push({ name, type, value: bytes.subarray(at + 4, at + 4 + size) });
    at += 4 + size;
  }
  return { list, end: at };
}

const attribute = (name, type, value) =>
  Buffer.concat([Buffer.from(`${name}\0${type}\0`, 'latin1'), int32(value.length), Buffer.from(value)]);
const int32 = (...values) => {
  const b = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => b.writeInt32LE(v, 4 * i));
  return b;
};
const tiledesc = (x, y, mode) => {
  const b = Buffer.alloc(9);
  b.writeUInt32LE(x, 0);
  b.writeUInt32LE(y, 4);
  b[8] = mode;
  return b;
};

/** Assembles a single-part tiled file from header attributes and tiles { tx, ty, lx, ly, data }, in the order given. */
function tiledFile(attrs, tiles, version = 2 | 0x200) {
  const head = Buffer.concat([int32(20000630), int32(version), ...attrs, Buffer.from([0])]);
  const table = Buffer.alloc(8 * tiles.length);
  const chunks = [];
  let offset = head.length + table.length;
  tiles.forEach((t, i) => {
    table.writeBigUInt64LE(BigInt(offset), 8 * i);
    const chunk = Buffer.concat([int32(t.tx, t.ty, t.lx, t.ly, t.data.length), Buffer.from(t.data)]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  return Buffer.concat([head, table, ...chunks]);
}

/** Repackages a scanline file's chunks as W x L tiles (one tile column), optionally in reverse file order. */
function scanlineAsTiles(bytes, reverse = false) {
  const { list, end } = attributes(bytes);
  const compression = list.find((a) => a.name === 'compression').value[0];
  const box = list.find((a) => a.name === 'dataWindow').value;
  const width = box.readInt32LE(8) - box.readInt32LE(0) + 1,
    height = box.readInt32LE(12) - box.readInt32LE(4) + 1,
    yMin = box.readInt32LE(4);
  const lines = LINES[compression],
    blocks = Math.ceil(height / lines);
  const tiles = [];
  for (let i = 0; i < blocks; i++) {
    const offset = Number(bytes.readBigUInt64LE(end + 8 * i));
    const y = bytes.readInt32LE(offset),
      size = bytes.readInt32LE(offset + 4);
    tiles.push({ tx: 0, ty: (y - yMin) / lines, lx: 0, ly: 0, data: bytes.subarray(offset + 8, offset + 8 + size) });
  }
  if (reverse) tiles.reverse();
  // A 'type' attribute (written by some versions) names the part type, which becomes tiledimage.
  const attrs = list.map((a) => attribute(a.name, a.type, a.name === 'type' ? Buffer.from('tiledimage') : a.value));
  attrs.push(attribute('tiles', 'tiledesc', tiledesc(width, lines, 0)));
  return tiledFile(attrs, tiles);
}

const sources = [
  ...readdirSync(fixtures)
    .filter((f) => f.endsWith('.exr'))
    .map((f) => fixtures + f),
  ...readdirSync(fixtures + 'piz')
    .filter((f) => f.endsWith('.exr'))
    .map((f) => fixtures + 'piz/' + f),
];

test('reference-library chunks repackaged as tiles decode bit-exactly as the scanline file, in any tile order', () => {
  assert.ok(sources.length >= 30, `found ${sources.length} fixtures`);
  const seen = new Set();
  for (const path of sources) {
    const bytes = readFileSync(path),
      expected = parseEXR(bytes);
    seen.add(expected.compression);
    for (const reverse of [false, true]) {
      const image = parseTiledEXR(scanlineAsTiles(bytes, reverse));
      assert.equal(image.compression, expected.compression, path);
      assert.deepEqual([image.width, image.height, image.layout], [expected.width, expected.height, expected.layout]);
      assert.deepEqual(image.dataWindow, expected.dataWindow);
      assert.deepEqual(new Uint8Array(image.data.buffer), new Uint8Array(expected.data.buffer), path);
      assert.equal(image.tiling.levelMode, 'ONE_LEVEL');
      assert.equal(image.levels.length, 1);
      assert.equal(image.levels[0].data, image.data);
    }
  }
  assert.deepEqual([...seen].sort(), ['NONE', 'PIZ', 'RLE', 'ZIP', 'ZIPS']);
});

test('a scanline file passes through to parseEXR', () => {
  const bytes = readFileSync(fixtures + 'synthetic-half-rgba-zip.exr');
  const image = parseTiledEXR(bytes);
  assert.deepEqual(image.data, parseEXR(bytes).data);
  assert.equal(image.tiling, undefined);
  assert.equal(image.levels[0].width, image.width);
});

// ------------------------------------------------------------------ files written here

/** Interleave and predict (the inverse of the reconstruction OpenEXR's ZIP and RLE readers apply), then zlib. */
function zip(raw) {
  const n = raw.length,
    half = (n + 1) >> 1,
    t = new Uint8Array(n);
  for (let i = 0; i < half; i++) t[i] = raw[2 * i];
  for (let i = 0; i < n >> 1; i++) t[half + i] = raw[2 * i + 1];
  const p = new Uint8Array(n);
  for (let i = 0; i < n; i++) p[i] = i ? (t[i] - t[i - 1] + 128) & 255 : t[0];
  return deflateSync(p);
}

/** Exactly representable FLOAT value of channel c at pixel (x, y) of level (lx, ly). */
const value = (c, x, y, lx, ly) => c * 1000 + lx * 100 + ly * 10 + x + y / 64;

/**
 * Writes a FLOAT R, G, B tiled file of `w` x `h` with the given tile size, level mode and rounding, every level present.
 * `sizes(lx, ly)` gives the level size the file is laid out with.
 */
function writeTiled({ w, h, tw, th, levelMode, rounding, compression, levels, order = 'forward' }) {
  const attrs = [
    attribute(
      'channels',
      'chlist',
      Buffer.concat(
        ['B', 'G', 'R']
          .map((n) => Buffer.concat([Buffer.from(`${n}\0`), int32(2, 0, 1, 1)]))
          .concat([Buffer.from([0])]),
      ),
    ),
    attribute('compression', 'compression', [compression]),
    attribute('dataWindow', 'box2i', int32(5, -3, 5 + w - 1, -3 + h - 1)),
    attribute('displayWindow', 'box2i', int32(5, -3, 5 + w - 1, -3 + h - 1)),
    attribute('lineOrder', 'lineOrder', [order === 'forward' ? 0 : 2]),
    attribute('tiles', 'tiledesc', tiledesc(tw, th, levelMode + rounding * 16)),
  ];
  const tiles = [];
  for (const [lx, ly, lw, lh] of levels)
    for (let ty = 0; ty * th < lh; ty++)
      for (let tx = 0; tx * tw < lw; tx++) {
        const cw = Math.min(tw, lw - tx * tw),
          ch = Math.min(th, lh - ty * th);
        const raw = Buffer.alloc(cw * ch * 12);
        let at = 0;
        for (let y = 0; y < ch; y++)
          for (const c of [2, 1, 0]) // B, G, R: channels in file (alphabetical) order
            for (let x = 0; x < cw; x++, at += 4) raw.writeFloatLE(value(c, tx * tw + x, ty * th + y, lx, ly), at);
        const packed = compression === 3 ? zip(raw) : raw;
        tiles.push({ tx, ty, lx, ly, data: packed.length < raw.length ? packed : raw });
      }
  if (order === 'shuffle')
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
  return tiledFile(attrs, tiles);
}

function checkLevel(level, [lx, ly, lw, lh]) {
  assert.deepEqual([level.levelX, level.levelY, level.width, level.height], [lx, ly, lw, lh]);
  for (let y = 0; y < lh; y++)
    for (let x = 0; x < lw; x++)
      for (let c = 0; c < 3; c++)
        if (level.data[(y * lw + x) * 4 + c] !== Math.fround(value(c, x, y, lx, ly)))
          assert.fail(`level (${lx}, ${ly}) pixel (${x}, ${y}) channel ${c}: ${level.data[(y * lw + x) * 4 + c]}`);
  for (let i = 3; i < level.data.length; i += 4) assert.equal(level.data[i], 1);
}

// Technical Introduction, "Multiresolution Levels": a 15 x 17 mipmap has these levels.
const MIP_DOWN = [
  [15, 17],
  [7, 8],
  [3, 4],
  [1, 2],
  [1, 1],
];
const MIP_UP = [
  [15, 17],
  [8, 9],
  [4, 5],
  [2, 3],
  [1, 2],
  [1, 1],
];

test('one-level files with edge tiles, NONE and ZIP, in file, random and shuffled tile order', () => {
  for (const compression of [0, 3])
    for (const order of ['forward', 'random', 'shuffle']) {
      const file = writeTiled({
        w: 15,
        h: 17,
        tw: 4,
        th: 3,
        levelMode: 0,
        rounding: 0,
        compression,
        levels: [[0, 0, 15, 17]],
        order,
      });
      const image = parseTiledEXR(file);
      assert.deepEqual(image.dataWindow, [5, -3, 19, 13]);
      assert.equal(image.tiling.tileWidth, 4);
      checkLevel(image.levels[0], [0, 0, 15, 17]);
    }
});

test('mipmap levels follow the Technical Introduction sizes for both rounding modes', () => {
  for (const [rounding, sizes] of [
    [0, MIP_DOWN],
    [1, MIP_UP],
  ]) {
    const levels = sizes.map(([w, h], l) => [l, l, w, h]);
    const file = writeTiled({
      w: 15,
      h: 17,
      tw: 4,
      th: 4,
      levelMode: 1,
      rounding,
      compression: 3,
      levels,
      order: 'shuffle',
    });
    const top = parseTiledEXR(file);
    assert.equal(top.levels.length, 1);
    assert.deepEqual(
      [top.tiling.levelMode, top.tiling.roundingMode, top.tiling.levelsX],
      ['MIPMAP_LEVELS', rounding ? 'ROUND_UP' : 'ROUND_DOWN', sizes.length],
    );
    checkLevel(top.levels[0], levels[0]);
    const all = parseTiledEXR(file, { levels: 'all' });
    assert.equal(all.levels.length, sizes.length);
    all.levels.forEach((level, i) => checkLevel(level, levels[i]));
  }
});

test('ripmap levels cover every x and y reduction, row by row', () => {
  for (const [rounding, xs, ys] of [
    [0, [15, 7, 3, 1], [17, 8, 4, 2, 1]],
    [1, [15, 8, 4, 2, 1], [17, 9, 5, 3, 2, 1]],
  ]) {
    const levels = [];
    ys.forEach((h, ly) => xs.forEach((w, lx) => levels.push([lx, ly, w, h])));
    const file = writeTiled({ w: 15, h: 17, tw: 5, th: 2, levelMode: 2, rounding, compression: 0, levels });
    const all = parseTiledEXR(file, { levels: 'all' });
    assert.deepEqual([all.tiling.levelsX, all.tiling.levelsY], [xs.length, ys.length]);
    assert.equal(all.levels.length, levels.length);
    all.levels.forEach((level, i) => checkLevel(level, levels[i]));
  }
});

// ------------------------------------------------------------------ refusals

const one = (compression = 0) =>
  writeTiled({ w: 6, h: 5, tw: 4, th: 4, levelMode: 0, rounding: 0, compression, levels: [[0, 0, 6, 5]] });
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return [error.name, error.code ?? null, error.message];
  }
  return ['decoded'];
};

test('PXR24, B44, B44A and DWA are refused, naming the missing public description', () => {
  for (const [value, label] of [
    [5, 'PXR24'],
    [6, 'B44'],
    [7, 'B44A'],
    [8, 'DWAA'],
    [9, 'DWAB'],
  ]) {
    const file = one();
    const at = file.indexOf(Buffer.from('compression\0compression\0')) + 'compression\0compression\0'.length + 4;
    file[at] = value;
    const [, errorCode, message] = code(() => parseTiledEXR(file));
    assert.equal(errorCode, 'unsupported', label);
    assert.match(message, new RegExp(`${label}: OpenEXR publishes no byte-level description`));
  }
});

test('parseEXR points tiled files to the exr-tiled entry', () => {
  assert.match(code(() => parseEXR(one()))[2], /parseTiledEXR from @margoengine\/environment\/exr-tiled/);
});

test('damaged tiled files fail before allocating, with located errors', () => {
  const base = one();
  const table = attributes(base).end;
  const tileAt = (i) => Number(base.readBigUInt64LE(table + 8 * i));
  const edit = (fn) => {
    const b = Buffer.from(base);
    fn(b);
    return code(() => parseTiledEXR(b));
  };
  assert.match(edit((b) => b.writeInt32LE(0, tileAt(1)))[2], /repeats an earlier tile/);
  assert.match(edit((b) => b.writeInt32LE(9, tileAt(0) + 4))[2], /bad coordinates/);
  assert.match(edit((b) => b.writeInt32LE(1, tileAt(0) + 8))[2], /bad coordinates/); // level (1, 0) in a one-level file
  assert.match(edit((b) => (b[b.indexOf(Buffer.from('tiledesc\0')) + 13 + 8] = 3))[2], /bad tiles mode 3/);
  assert.equal(edit((b) => b.writeBigUInt64LE(BigInt(b.length), table))[0], 'RangeError');
  assert.equal(code(() => parseTiledEXR(base.subarray(0, base.length - 3)))[0], 'RangeError');
  // A mipmap tile claiming level (1, 0) is not a mipmap level.
  const mip = writeTiled({
    w: 4,
    h: 4,
    tw: 4,
    th: 4,
    levelMode: 1,
    rounding: 0,
    compression: 0,
    levels: [
      [0, 0, 4, 4],
      [1, 1, 2, 2],
      [2, 2, 1, 1],
    ],
  });
  const mipTable = attributes(mip).end;
  const m = Buffer.from(mip);
  m.writeInt32LE(0, Number(m.readBigUInt64LE(mipTable + 8)) + 12);
  assert.match(code(() => parseTiledEXR(m))[2], /bad coordinates/);
  // Missing tiles section: fewer offsets than the tiling needs reads past the table into chunk bytes and is refused.
  assert.notEqual(
    code(() =>
      parseTiledEXR(
        tiledFile(
          attributes(base).list.map((a) => attribute(a.name, a.type, a.value)),
          [],
        ),
      ),
    )[0],
    'decoded',
  );
});
