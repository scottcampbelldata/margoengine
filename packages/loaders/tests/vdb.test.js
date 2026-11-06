// parseVDB: files the test writes byte by byte: every value kind, compression, value type, transform and refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { parseVDB } from '../dist/vdb.js';
import { LoaderError } from '../dist/common.js';

const refuses = (promise, code) =>
  assert.rejects(promise, (error) => error instanceof LoaderError && error.format === 'VDB' && error.code === code);

// Little-endian writers.
const u8 = (v) => Buffer.from([v & 255]);
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const i32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return b;
};
const i64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};
const f32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return b;
};
const f64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  return b;
};
const text = (v) => Buffer.concat([u32(Buffer.byteLength(v)), Buffer.from(v)]);
const coord = ([x, y, z]) => Buffer.concat([i32(x), i32(y), i32(z)]);

/** Binary16 bits of a value that binary16 holds exactly. */
const half = (v) => {
  const b = Buffer.alloc(2);
  if (v === 0) return b;
  const sign = v < 0 ? 0x8000 : 0,
    a = Math.abs(v),
    e = Math.floor(Math.log2(a));
  b.writeUInt16LE(sign | ((e + 15) << 10) | Math.round((a / 2 ** e - 1) * 1024));
  return b;
};

const TYPES = {
  float: { put: f32 },
  double: { put: f64 },
  int32: { put: i32 },
  int64: { put: i64 },
  vec3s: { put: (v) => Buffer.concat(v.map(f32)) },
  vec3d: { put: (v) => Buffer.concat(v.map(f64)) },
  vec3i: { put: (v) => Buffer.concat(v.map(i32)) },
};

/** A minimal LZ4 block encoder: greedy matches of 4 or more bytes against everything before. */
function lz4(input) {
  const out = [];
  const length = (n) => {
    for (; n >= 255; n -= 255) out.push(255);
    out.push(n);
  };
  let start = 0,
    i = 0;
  const emit = (end, offset, match) => {
    const literals = end - start,
      extra = match - 4;
    out.push((Math.min(literals, 15) << 4) | (match ? Math.min(extra, 15) : 0));
    if (literals >= 15) length(literals - 15);
    out.push(...input.subarray(start, end));
    if (!match) return;
    out.push(offset & 255, offset >> 8);
    if (extra >= 15) length(extra - 15);
  };
  while (i + 12 < input.length) {
    let best = 0,
      offset = 0;
    for (let back = 1; back <= Math.min(i, 64); back++) {
      let n = 0;
      while (i + n + 5 < input.length && input[i + n] === input[i + n - back]) n++;
      if (n > best) [best, offset] = [n, back];
    }
    if (best < 4) {
      i++;
      continue;
    }
    emit(i, offset, best);
    i += best;
    start = i;
  }
  emit(input.length, 0, 0);
  return Buffer.from(out);
}

/** One Blosc 1 chunk: shuffled, split into a stream per byte of the type, LZ4 in each. */
function blosc(
  data,
  typeSize,
  { blockSize = data.length, shuffle = true, split = true, flags = 0, store = false } = {},
) {
  const header = Buffer.alloc(16);
  header[0] = 2;
  header[1] = 1;
  header[3] = typeSize;
  header.writeUInt32LE(data.length, 4);
  header.writeUInt32LE(blockSize, 8);
  header[2] = flags | (1 << 5) | (shuffle ? 1 : 0) | (split ? 0 : 16) | (store ? 2 : 0);
  if (store) {
    header.writeUInt32LE(16 + data.length, 12);
    return Buffer.concat([header, data]);
  }
  const blocks = [];
  for (let at = 0; at < data.length; at += blockSize) {
    let block = data.subarray(at, Math.min(at + blockSize, data.length));
    const size = block.length;
    if (shuffle) {
      const count = Math.floor(size / typeSize),
        mixed = Buffer.from(block);
      for (let i = 0; i < count; i++) for (let b = 0; b < typeSize; b++) mixed[b * count + i] = block[i * typeSize + b];
      block = mixed;
    }
    const streams = split && size === blockSize ? typeSize : 1,
      part = size / streams,
      out = [];
    for (let s = 0; s < streams; s++) {
      const slice = block.subarray(s * part, (s + 1) * part),
        packed = lz4(slice),
        chosen = packed.length < part ? packed : slice;
      out.push(u32(chosen.length), chosen);
    }
    blocks.push(Buffer.concat(out));
  }
  const table = [];
  let at = 16 + blocks.length * 4;
  for (const block of blocks) {
    table.push(u32(at));
    at += block.length;
  }
  header.writeUInt32LE(at, 12);
  return Buffer.concat([header, ...table, ...blocks]);
}

const ZIP = 1,
  MASK = 2,
  BLOSC = 4;

/** Wraps value bytes as the file's compression does. */
function packed(data, compression, typeSize) {
  if (compression & BLOSC) {
    if (data.length < 48) return Buffer.concat([i64(-data.length), data]);
    const chunk = blosc(data, typeSize);
    return Buffer.concat([i64(chunk.length), chunk]);
  }
  if (compression & ZIP) {
    const zipped = deflateSync(data);
    return Buffer.concat([i64(zipped.length), zipped]);
  }
  return data;
}

const bits = (count, on) => {
  const mask = Buffer.alloc(count >> 3);
  for (const i of on) mask[i >> 3] |= 1 << (i & 7);
  return mask;
};

const metaBlock = (entries = []) =>
  Buffer.concat([
    u32(entries.length),
    ...entries.flatMap(([name, type, body]) => [text(name), text(type), u32(body.length), body]),
  ]);

const uniform = (scale = 1) =>
  Buffer.concat([
    text('UniformScaleMap'),
    ...[scale, scale, scale, scale, scale, scale].map(f64),
    ...Array(9).fill(f64(1)),
  ]);

/**
 * A grid's bytes. `leaves`: [{ origin, values(i) -> value, active: [indexes], kind?, inactive?, selection? }]. The tree
 * is `dims` deep, one child per level on the way to each leaf; `tiles` sit in the root, `inner` in the top node.
 */
function gridBytes(spec, at) {
  const {
    valueType = 'float',
    dims = [5, 4, 3],
    half: asHalf = false,
    compression = 0,
    background = 0,
    leaves = [],
    rootTiles = [],
    inner = [],
    meta = [],
    transform = uniform(),
  } = spec;
  const { put } = TYPES[valueType],
    stored = asHalf ? (v) => half(v) : put,
    typeSize = asHalf ? 2 : put(background).length / (Array.isArray(background) ? 3 : 1),
    leafCount = 2 ** (dims.at(-1) * 3),
    spans = dims.map((_, level) => dims.slice(level).reduce((a, b) => a + b, 0));

  /** A node's values with the kind byte, inactive values and selection mask in front. */
  const values = (all, active, count, kind = 6, inactive = [], selection = []) => {
    const parts = [u8(kind)];
    for (const value of inactive) parts.push(put(value));
    if (kind >= 3 && kind <= 5) parts.push(bits(count, selection));
    const keep = compression & MASK && kind !== 6 ? active : [...Array(count).keys()];
    parts.push(packed(Buffer.concat(keep.map((i) => stored(all(i)))), compression, typeSize));
    return Buffer.concat(parts);
  };

  const inside = (level, origin, list, tiles) => {
    const dim = dims[level],
      total = 2 ** (dim * 3);
    if (level === dims.length - 1) return [bits(total, list[0].active)];
    const size = 2 ** spans[level + 1],
      slot = (o) =>
        (((o[0] - origin[0]) / size) << (2 * dim)) | (((o[1] - origin[1]) / size) << dim) | ((o[2] - origin[2]) / size),
      down = (v) => Math.floor(v / size) * size,
      groups = new Map();
    for (const leaf of list) {
      const key = slot(leaf.origin.map(down));
      groups.set(key, [...(groups.get(key) ?? []), leaf]);
    }
    const here = level === 0 ? tiles : [],
      tileValue = new Map(here.map((tile) => [slot(tile.origin), tile.value])),
      active = here.filter((tile) => tile.active).map((tile) => slot(tile.origin)),
      children = [...groups.keys()].sort((a, b) => a - b),
      parts = [
        bits(total, children),
        bits(total, active),
        values((i) => tileValue.get(i) ?? background, active, total, tileValue.size ? 6 : 0),
      ];
    for (const key of children) {
      const child = groups.get(key),
        origin2 = child[0].origin.map(down);
      parts.push(...inside(level + 1, origin2, child, []));
    }
    return parts;
  };

  const rootSize = 2 ** spans[0],
    rootDown = (v) => Math.floor(v / rootSize) * rootSize,
    roots = new Map();
  for (const leaf of leaves) {
    const origin = leaf.origin.map(rootDown),
      key = origin.join();
    roots.set(key, { origin, list: [...(roots.get(key)?.list ?? []), leaf] });
  }
  const topology = [
    i32(1),
    put(background),
    u32(rootTiles.length),
    u32(roots.size),
    ...rootTiles.flatMap((tile) => [coord(tile.origin), put(tile.value), u8(tile.active ? 1 : 0)]),
    ...[...roots.values()].flatMap(({ origin, list }) => [coord(origin), ...inside(0, origin, list, inner)]),
  ];

  // Depth-first order, the order the topology above walks in.
  const ordered = [];
  const visit = (level, origin, list) => {
    if (level === dims.length - 1) return void ordered.push(list[0]);
    const size = 2 ** spans[level + 1],
      down = (v) => Math.floor(v / size) * size,
      groups = new Map();
    for (const leaf of list) {
      const o = leaf.origin.map(down),
        k = o.join();
      groups.set(k, { o, list: [...(groups.get(k)?.list ?? []), leaf] });
    }
    const index = ({ o }) => o[0] * 2 ** 40 + o[1] * 2 ** 20 + o[2];
    for (const group of [...groups.values()].sort((a, b) => index(a) - index(b))) visit(level + 1, group.o, group.list);
  };
  for (const { origin, list } of roots.values()) visit(0, origin, list);

  const head = Buffer.concat([u32(compression), metaBlock(meta), transform, ...topology]),
    buffers = ordered.map((leaf) =>
      Buffer.concat([
        bits(leafCount, leaf.active),
        values(leaf.values, leaf.active, leafCount, leaf.kind, leaf.inactive, leaf.selection),
      ]),
    );
  return { bytes: Buffer.concat([head, ...buffers]), blockAt: at + head.length };
}

/** A whole file holding `grids`. */
function file(grids, { version = 224, fileMeta = metaBlock(), offsets = 1 } = {}) {
  const typeName = (grid) => {
    const dims = (grid.dims ?? [5, 4, 3]).join('_');
    return grid.type ?? `Tree_${grid.valueType ?? 'float'}_${dims}${grid.half ? '_HalfFloat' : ''}`;
  };
  const head = Buffer.concat([
    Buffer.from(' BDV\0\0\0\0', 'latin1'),
    u32(version),
    u32(11),
    u32(0),
    u8(offsets),
    Buffer.from('0123456789abcdef0123456789abcdef0123'),
    fileMeta,
    u32(grids.length),
  ]);
  const descriptorSize = (grid) =>
    4 +
    Buffer.byteLength(grid.name) +
    4 +
    Buffer.byteLength(typeName(grid)) +
    4 +
    Buffer.byteLength(grid.parent ?? '') +
    24;
  let at = head.length + grids.reduce((sum, grid) => sum + descriptorSize(grid), 0);
  const descriptors = [],
    bodies = [];
  for (const grid of grids) {
    const body = grid.raw ? { bytes: grid.raw, blockAt: at } : gridBytes(grid, at);
    descriptors.push(
      text(grid.name),
      text(typeName(grid)),
      text(grid.parent ?? ''),
      i64(at),
      i64(body.blockAt),
      i64(at + body.bytes.length),
    );
    bodies.push(body.bytes);
    at += body.bytes.length;
  }
  return Buffer.concat([head, ...descriptors, ...bodies]);
}

const leaf = (origin, active, values = (i) => i / 4, extra = {}) => ({ origin, active, values, ...extra });
const voxel = (x, y, z) => x * 64 + y * 8 + z;

test('a plain float grid reads with its metadata, activity, box and values', async () => {
  const body = file(
    [
      {
        name: 'density',
        background: 0.5,
        meta: [['class', 'string', Buffer.from('fog volume')]],
        transform: uniform(0.25),
        leaves: [leaf([8, 0, 16], [voxel(1, 2, 3), voxel(7, 7, 7)]), leaf([-8, -8, -8], [voxel(0, 0, 0)])],
      },
    ],
    { fileMeta: metaBlock([['creator', 'string', Buffer.from('test')]]) },
  );
  const { version, library, uuid, meta, grids, skipped } = await parseVDB(body);
  assert.equal(version, 224);
  assert.deepEqual(library, [11, 0]);
  assert.equal(uuid.length, 36);
  assert.equal(meta.creator, 'test');
  assert.deepEqual(skipped, []);
  const [grid] = grids;
  assert.equal(grid.name, 'density');
  assert.equal(grid.valueType, 'float');
  assert.equal(grid.gridClass, 'fog volume');
  assert.equal(grid.background, 0.5);
  assert.deepEqual(grid.voxelSize, [0.25, 0.25, 0.25]);
  assert.equal(grid.leaves.length, 2);
  assert.equal(grid.activeVoxels, 3);
  assert.deepEqual(grid.box, [-8, -8, -8, 15, 7, 23]);
  assert.equal(grid.at(9, 2, 19), voxel(1, 2, 3) / 4);
  assert.equal(grid.at(-8, -8, -8), 0);
  assert.equal(grid.at(1000, 0, 0), 0.5);
  assert.equal(grid.isActive(9, 2, 19), true);
  assert.equal(grid.isActive(9, 2, 20), false);
  assert.equal(grid.isActive(1000, 0, 0), false);
});

test('dense fills x fastest, with the background where nothing is stored, and world bounds', async () => {
  const { grids } = await parseVDB(
    file([
      {
        name: 'd',
        background: 9,
        transform: uniform(2),
        leaves: [leaf([0, 0, 0], [voxel(0, 0, 0), voxel(1, 0, 0), voxel(0, 1, 1)])],
      },
    ]),
  );
  const { data, dims, bounds, box, components } = grids[0].dense();
  assert.deepEqual(dims, [2, 2, 2]);
  assert.deepEqual(box, [0, 0, 0, 1, 1, 1]);
  assert.equal(components, 1);
  assert.deepEqual(bounds, [0, 2, 0, 2, 0, 2]);
  assert.equal(data[0], grids[0].at(0, 0, 0));
  assert.equal(data[1], grids[0].at(1, 0, 0));
  assert.equal(data[2 + 4], grids[0].at(0, 1, 1));
  const outside = grids[0].dense({ box: [100, 100, 100, 101, 100, 100] });
  assert.deepEqual([...outside.data], [9, 9]);
  assert.throws(
    () => grids[0].dense({ box: [0, 0, 0, 7, 7, 7], maxValues: 10 }),
    (e) => e.code === 'limit',
  );
  assert.throws(
    () => grids[0].dense({ box: [1, 0, 0, 0, 0, 0] }),
    (e) => e.code === 'range',
  );
  assert.throws(
    () => grids[0].dense({ box: [0.5, 0, 0, 1, 1, 1] }),
    (e) => e.code === 'range',
  );
});

test('a grid with no active voxel has no box, and dense then needs one', async () => {
  const { grids } = await parseVDB(file([{ name: 'empty', background: 1 }]));
  assert.equal(grids[0].box, null);
  assert.equal(grids[0].activeVoxels, 0);
  assert.throws(
    () => grids[0].dense(),
    (e) => e.code === 'range',
  );
  assert.deepEqual([...grids[0].dense({ box: [0, 0, 0, 0, 0, 0] }).data], [1]);
});

test('every value kind restores the inactive values the file left out', async () => {
  const active = [voxel(0, 0, 0), voxel(0, 0, 2)],
    second = voxel(0, 0, 1),
    third = voxel(0, 0, 3);
  const cases = [
    { kind: 0, want: [4, 4] },
    { kind: 1, want: [-4, -4] },
    { kind: 2, inactive: [7], want: [7, 7] },
    { kind: 3, selection: [second], want: [4, -4] },
    { kind: 4, inactive: [7], selection: [second], want: [4, 7] },
    { kind: 5, inactive: [7, 8], selection: [third], want: [7, 8] },
  ];
  for (const { kind, inactive, selection, want } of cases) {
    const { grids } = await parseVDB(
      file([
        {
          name: 'k',
          background: 4,
          compression: MASK,
          leaves: [leaf([0, 0, 0], active, (i) => i + 1, { kind, inactive, selection })],
        },
      ]),
    );
    const [grid] = grids;
    assert.deepEqual([grid.at(0, 0, 1), grid.at(0, 0, 3)], want, `kind ${kind}`);
    assert.equal(grid.at(0, 0, 0), active[0] + 1, `kind ${kind}`);
    assert.equal(grid.at(0, 0, 2), active[1] + 1, `kind ${kind}`);
  }
});

test('all values stay in place when the kind says so or the mask flag is off', async () => {
  for (const { compression, kind } of [
    { compression: MASK, kind: 6 },
    { compression: 0, kind: 0 },
  ]) {
    const { grids } = await parseVDB(
      file([{ name: 'a', compression, leaves: [leaf([0, 0, 0], [0], (i) => i * 2, { kind })] }]),
    );
    assert.equal(grids[0].at(1, 2, 3), voxel(1, 2, 3) * 2);
  }
});

test('zlib and Blosc grids read the same values as an uncompressed one', async () => {
  const leaves = [leaf([0, 0, 0], [1, 2, 3, 200], (i) => (i % 7) / 2), leaf([64, 8, 0], [5], (i) => (i % 3) * 1.5)];
  const plain = (await parseVDB(file([{ name: 'p', leaves }]))).grids[0];
  for (const compression of [ZIP, BLOSC, ZIP | MASK, BLOSC | MASK]) {
    const kind = compression & MASK ? 0 : undefined;
    const list = leaves.map((item) => ({ ...item, kind }));
    const { grids } = await parseVDB(file([{ name: 'c', compression, leaves: list }]));
    assert.equal(grids[0].at(2, 0, 0), compression & MASK ? 0 : plain.at(2, 0, 0));
    assert.equal(grids[0].at(0, 0, 3), plain.at(0, 0, 3), `compression ${compression}`);
    assert.equal(grids[0].at(64, 8, 5), plain.at(64, 8, 5), `compression ${compression}`);
  }
});

/** A file with one leaf whose value block is exactly `block`, after the kind byte. */
function withBlock(block, compression = BLOSC) {
  const good = file([{ name: 'b', compression, leaves: [leaf([0, 0, 0], [0], () => 1)] }]),
    { blockAt } = gridBytes({ compression, leaves: [leaf([0, 0, 0], [0], () => 1)] }, 0),
    // Offset of this one grid in the file: the file minus the grid's own length.
    gridLength = gridBytes({ compression, leaves: [leaf([0, 0, 0], [0], () => 1)] }, 0).bytes.length,
    at = good.length - gridLength + blockAt + 64 + 1;
  return Buffer.concat([good.subarray(0, at), block]);
}

const ramp = () => Buffer.concat([...Array(512).keys()].map((i) => f32(i % 16)));

test('Blosc chunks read in every layout: several blocks, a short last block, no shuffle, no split, stored', async () => {
  const data = ramp(),
    want = [...Array(512).keys()].map((i) => i % 16);
  for (const options of [
    { blockSize: 512 },
    { blockSize: 600 },
    { shuffle: false },
    { split: false },
    { shuffle: false, split: false, blockSize: 1000 },
    { store: true },
  ]) {
    const chunk = blosc(data, 4, options),
      { grids } = await parseVDB(withBlock(Buffer.concat([i64(chunk.length), chunk])));
    assert.deepEqual([...grids[0].leaves[0].values], want, JSON.stringify(options));
  }
});

test('a Blosc chunk with a stored stream reads, and a stored block reads through a negative size', async () => {
  const data = Buffer.concat([...Array(512).keys()].map((i) => f32(Math.sin(i * 12.9898) * 43758.5453)));
  const chunk = blosc(data, 4),
    { grids } = await parseVDB(withBlock(Buffer.concat([i64(chunk.length), chunk])));
  assert.equal(grids[0].leaves[0].values[7], data.readFloatLE(28));
  const stored = await parseVDB(withBlock(Buffer.concat([i64(-data.length), data])));
  assert.equal(stored.grids[0].leaves[0].values[7], data.readFloatLE(28));
});

test('bad compressed data is refused', async () => {
  const data = ramp(),
    chunk = blosc(data, 4),
    wrap = (bytes) => withBlock(Buffer.concat([i64(bytes.length), bytes]));
  const cut = chunk.subarray(0, chunk.length - 4);
  await refuses(parseVDB(wrap(cut)), 'zip');
  const size = Buffer.from(chunk);
  size.writeUInt32LE(99, 4);
  await refuses(parseVDB(wrap(size)), 'zip');
  const offset = Buffer.from(chunk);
  offset.writeUInt32LE(chunk.length + 10, 16);
  await refuses(parseVDB(wrap(offset)), 'zip');
  const other = Buffer.from(chunk);
  other[2] = (other[2] & 31) | (3 << 5);
  await refuses(parseVDB(wrap(other)), 'unsupported');
  const bitShuffle = Buffer.from(chunk);
  bitShuffle[2] |= 4;
  await refuses(parseVDB(wrap(bitShuffle)), 'unsupported');
  await refuses(parseVDB(wrap(Buffer.alloc(8))), 'zip');
  await refuses(parseVDB(withBlock(Buffer.concat([i64(-7), data]))), 'range');
  await refuses(parseVDB(withBlock(Buffer.concat([i64(1 << 30)]))), 'truncated');
  const bad = deflateSync(data);
  bad[bad.length >> 1] ^= 255;
  await refuses(parseVDB(withBlock(Buffer.concat([i64(bad.length), bad]), ZIP)), 'zip');
});

test('LZ4 data with an offset before the start of the block is refused', async () => {
  // Token: no literals, a match of 4 at offset 9, with nothing written yet.
  const stream = Buffer.from([0x00, 9, 0]),
    head = Buffer.alloc(16),
    part = 2048;
  head[0] = 2;
  head[1] = 1;
  head[2] = (1 << 5) | 16;
  head[3] = 4;
  head.writeUInt32LE(part, 4);
  head.writeUInt32LE(part, 8);
  const body = Buffer.concat([head, u32(20), u32(stream.length), stream]);
  await refuses(parseVDB(withBlock(Buffer.concat([i64(body.length), body]))), 'zip');
});

test('half grids widen to float and keep their flag', async () => {
  const { grids } = await parseVDB(
    file([{ name: 'h', half: true, background: 2, leaves: [leaf([0, 0, 0], [0, 1], (i) => (i ? -1.5 : 0.25))] }]),
  );
  const [grid] = grids;
  assert.equal(grid.half, true);
  assert.equal(grid.valueType, 'float');
  assert.equal(grid.background, 2);
  assert.equal(grid.at(0, 0, 0), 0.25);
  assert.equal(grid.at(0, 0, 1), -1.5);
  assert.ok(grid.leaves[0].values instanceof Float32Array);
});

test('double, integer and vector grids keep their type', async () => {
  const read = async (valueType, background, values) =>
    (await parseVDB(file([{ name: 'v', valueType, background, leaves: [leaf([0, 0, 0], [3], values)] }]))).grids[0];
  const double = await read('double', 0, () => 1 / 3);
  assert.equal(double.at(0, 0, 3), 1 / 3);
  assert.ok(double.leaves[0].values instanceof Float64Array);
  const int = await read('int32', -1, (i) => -i);
  assert.equal(int.at(0, 0, 3), -3);
  assert.equal(int.background, -1);
  assert.ok(int.leaves[0].values instanceof Int32Array);
  const long = await read('int64', 0, () => 2 ** 40);
  assert.equal(long.at(0, 0, 3), 2 ** 40);
  const vector = await read('vec3s', [0, 0, 1], (i) => [i, 2, 3]);
  assert.equal(vector.components, 3);
  assert.deepEqual(vector.at(0, 0, 3), [3, 2, 3]);
  assert.deepEqual(vector.at(500, 0, 0), [0, 0, 1]);
  const box = vector.dense({ box: [0, 0, 3, 0, 0, 3] });
  assert.equal(box.components, 3);
  assert.deepEqual([...box.data], [3, 2, 3]);
  const wide = await read('vec3d', [0, 0, 0], () => [0.1, 0.2, 0.3]);
  assert.deepEqual(wide.at(0, 0, 3), [0.1, 0.2, 0.3]);
  const whole = await read('vec3i', [0, 0, 0], () => [1, -2, 3]);
  assert.deepEqual(whole.at(0, 0, 3), [1, -2, 3]);
});

test('every linear transform maps index to world', async () => {
  const vectors = (...values) => values.map(f64);
  const ones = Array(9).fill(f64(1));
  const affine = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1];
  const cases = [
    [Buffer.concat([text('AffineMap'), ...vectors(...affine)]), [7, 9, 11]],
    [Buffer.concat([text('TranslationMap'), ...vectors(5, 6, 7)]), [6, 7, 8]],
    [Buffer.concat([text('ScaleMap'), ...vectors(2, 3, 4), ...vectors(2, 3, 4), ...ones]), [2, 3, 4]],
    [Buffer.concat([text('UniformScaleMap'), ...vectors(2, 2, 2), ...vectors(2, 2, 2), ...ones]), [2, 2, 2]],
    [
      Buffer.concat([
        text('ScaleTranslateMap'),
        ...vectors(5, 6, 7),
        ...vectors(2, 3, 4),
        ...vectors(2, 3, 4),
        ...ones,
      ]),
      [7, 9, 11],
    ],
    [
      Buffer.concat([
        text('UniformScaleTranslateMap'),
        ...vectors(5, 6, 7),
        ...vectors(2, 2, 2),
        ...vectors(2, 2, 2),
        ...ones,
      ]),
      [7, 8, 9],
    ],
  ];
  for (const [transform, [x, y, z]] of cases) {
    const { grids } = await parseVDB(file([{ name: 't', transform, leaves: [leaf([0, 0, 0], [voxel(1, 1, 1)])] }]));
    const { matrix } = grids[0];
    assert.deepEqual(
      [
        matrix[0] + matrix[4] + matrix[8] + matrix[12],
        matrix[1] + matrix[5] + matrix[9] + matrix[13],
        matrix[2] + matrix[6] + matrix[10] + matrix[14],
      ],
      [x, y, z],
    );
    assert.equal(grids[0].at(1, 1, 1), voxel(1, 1, 1) / 4);
  }
});

test('root and inner tiles fill their cubes; an inactive tile equal to the background is dropped', async () => {
  const { grids } = await parseVDB(
    file([
      {
        name: 't',
        background: 1,
        rootTiles: [
          { origin: [4096, 0, 0], value: 5, active: true },
          { origin: [8192, 0, 0], value: -5, active: false },
          { origin: [12288, 0, 0], value: 1, active: false },
        ],
        inner: [{ origin: [128, 0, 0], value: 3, active: true }],
        leaves: [leaf([0, 0, 0], [0])],
      },
    ]),
  );
  const [grid] = grids;
  assert.equal(grid.tiles.length, 3);
  assert.equal(grid.at(4096 + 4095, 9, 9), 5);
  assert.equal(grid.isActive(4096, 0, 0), true);
  assert.equal(grid.at(8200, 0, 0), -5);
  assert.equal(grid.isActive(8200, 0, 0), false);
  assert.equal(grid.at(12288, 0, 0), 1);
  assert.equal(grid.at(255, 127, 127), 3);
  assert.equal(grid.isActive(255, 127, 127), true);
  assert.equal(grid.activeVoxels, 4096 ** 3 + 128 ** 3 + 1);
  assert.deepEqual(grid.box, [0, 0, 0, 8191, 4095, 4095]);
  const { data } = grid.dense({ box: [126, 0, 0, 129, 0, 0] });
  assert.deepEqual([...data], [1, 1, 3, 3]);
});

test('a tree of another shape reads, with its own node sizes', async () => {
  const { grids } = await parseVDB(
    file([{ name: 's', dims: [3, 2, 2, 2], leaves: [leaf([20, 4, 0], [1], (i) => i + 10)] }]),
  );
  const [grid] = grids;
  assert.equal(grid.type, 'Tree_float_3_2_2_2');
  assert.equal(grid.leaves[0].values.length, 64);
  assert.deepEqual(grid.leaves[0].origin, [20, 4, 0]);
  assert.equal(grid.at(20, 4, 1), 11);
  assert.deepEqual(grid.box, [20, 4, 1, 20, 4, 1]);
});

test('leaves under several parents keep their origins', async () => {
  const origins = [
    [0, 0, 0],
    [0, 0, 8],
    [8, 0, 0],
    [128, 0, 0],
    [4096, 0, 0],
    [-4096, -8, 8],
  ];
  const { grids } = await parseVDB(
    file([{ name: 'm', leaves: origins.map((origin, n) => leaf(origin, [n], () => n + 1)) }]),
  );
  assert.equal(grids[0].leaves.length, 6);
  origins.forEach(([x, y, z], n) => {
    assert.equal(grids[0].at(x + (n >> 6), y + ((n >> 3) & 7), z + (n & 7)), n + 1);
    assert.equal(grids[0].isActive(x + (n >> 6), y + ((n >> 3) & 7), z + (n & 7)), true);
  });
});

test('an instance shares its parent tree under its own transform', async () => {
  const instance = Buffer.concat([u32(0), metaBlock(), uniform(4)]);
  const { grids } = await parseVDB(
    file([
      { name: 'a', background: 2, leaves: [leaf([0, 0, 0], [1], () => 6)] },
      { name: 'b', parent: 'a', raw: instance },
    ]),
  );
  assert.equal(grids[1].name, 'b');
  assert.equal(grids[1].at(0, 0, 1), 6);
  assert.equal(grids[1].background, 2);
  assert.equal(grids[1].leaves, grids[0].leaves);
  assert.deepEqual(grids[1].voxelSize, [4, 4, 4]);
});

test('an instance with no parent read is skipped; a grid name keeps only what precedes its separator', async () => {
  const instance = Buffer.concat([u32(0), metaBlock(), uniform(4)]);
  const { grids, skipped } = await parseVDB(
    file([
      { name: 'a\x1e1', leaves: [leaf([0, 0, 0], [1])] },
      { name: 'b', parent: 'zzz', raw: instance },
    ]),
  );
  assert.deepEqual(
    grids.map((g) => g.name),
    ['a'],
  );
  assert.match(skipped[0].reason, /zzz/);
});

test('options.grids and unknown types go to skipped, and the rest still read', async () => {
  const frustum = Buffer.concat([u32(0), metaBlock(), text('NonlinearFrustumMap')]);
  const { grids, skipped } = await parseVDB(
    file([
      { name: 'mask', type: 'Tree_bool_5_4_3', raw: Buffer.alloc(0) },
      { name: 'points', type: 'Tree_ptdataidx32_5_4_3', raw: Buffer.alloc(0) },
      { name: 'odd', type: 'Grid_of_things', raw: Buffer.alloc(0) },
      { name: 'wedge', raw: frustum },
      { name: 'velocity', valueType: 'vec3s', background: [0, 0, 0] },
      { name: 'density', leaves: [leaf([0, 0, 0], [0])] },
    ]),
  );
  assert.deepEqual(
    grids.map((g) => g.name),
    ['velocity', 'density'],
  );
  assert.deepEqual(
    skipped.map((s) => s.name),
    ['mask', 'points', 'odd', 'wedge'],
  );
  const one = await parseVDB(
    file([
      { name: 'velocity', valueType: 'vec3s', background: [0, 0, 0] },
      { name: 'density', leaves: [leaf([0, 0, 0], [0])] },
    ]),
    { grids: ['density'] },
  );
  assert.deepEqual(
    one.grids.map((g) => g.name),
    ['density'],
  );
  assert.deepEqual(one.skipped, [{ name: 'velocity', type: 'Tree_vec3s_5_4_3', reason: 'not in options.grids' }]);
});

test('metadata of every type reads; an unknown type stays as bytes, and __proto__ is an ordinary key', async () => {
  const entries = [
    ['flag', 'bool', u8(1)],
    ['count', 'int32', i32(-3)],
    ['big', 'int64', i64(2 ** 40)],
    ['f', 'float', f32(0.5)],
    ['d', 'double', f64(0.25)],
    ['file_bbox_min', 'vec3i', coord([1, 2, 3])],
    ['s', 'vec3s', Buffer.concat([f32(1), f32(2), f32(3)])],
    ['w', 'vec3d', Buffer.concat([f64(1), f64(2), f64(3)])],
    ['__proto__', 'string', Buffer.from('x')],
    ['other', '__delayedload', Buffer.from([1, 2])],
    ['short', 'int32', Buffer.from([1])],
  ];
  const { grids } = await parseVDB(file([{ name: 'm', meta: entries }]));
  const { meta } = grids[0];
  assert.equal(Object.getPrototypeOf(meta), null);
  assert.equal(meta.flag, true);
  assert.equal(meta.count, -3);
  assert.equal(meta.big, 2 ** 40);
  assert.equal(meta.f, 0.5);
  assert.equal(meta.d, 0.25);
  assert.deepEqual(meta.file_bbox_min, [1, 2, 3]);
  assert.deepEqual(meta.s, [1, 2, 3]);
  assert.deepEqual(meta.w, [1, 2, 3]);
  assert.equal(meta.__proto__, 'x');
  assert.deepEqual([...meta.other], [1, 2]);
  assert.deepEqual([...meta.short], [1]);
  assert.equal(grids[0].gridClass, 'unknown');
});

test('a view into a larger buffer reads from its own start', async () => {
  const body = file([{ name: 'o', leaves: [leaf([0, 0, 0], [1], () => 3)] }]),
    shifted = new Uint8Array(body.length + 3);
  shifted.set(body, 3);
  const { grids } = await parseVDB(shifted.subarray(3));
  assert.equal(grids[0].at(0, 0, 1), 3);
});

test('what is not a usable file is refused with its code', async () => {
  const good = file([{ name: 'g', leaves: [leaf([0, 0, 0], [1])] }]);
  await refuses(parseVDB(Buffer.from('not a vdb file at all')), 'header');
  await refuses(parseVDB(Buffer.alloc(3)), 'header');
  await refuses(parseVDB(file([], { version: 221 })), 'unsupported');
  await refuses(parseVDB(file([], { offsets: 0 })), 'unsupported');
  await refuses(parseVDB(good.subarray(0, 40)), 'truncated');
  await refuses(parseVDB(good.subarray(0, good.length - 1)), 'truncated');
  await refuses(parseVDB(good, { maxValues: 100 }), 'limit');
  const controller = new AbortController();
  controller.abort();
  await refuses(parseVDB(good, { signal: controller.signal }), 'aborted');
});

test('counts and offsets that claim more than the file holds are refused before any allocation', async () => {
  const good = file([{ name: 'g', leaves: [leaf([0, 0, 0], [1])] }]),
    head = 8 + 12 + 1 + 36;
  const count = Buffer.from(good);
  count.writeUInt32LE(0xffffffff, head);
  await refuses(parseVDB(count), 'truncated');
  const grids = Buffer.from(good);
  grids.writeUInt32LE(0xffffffff, head + 4);
  await refuses(parseVDB(grids), 'truncated');
  const offset = Buffer.from(good),
    gridAt = head + 8 + 4 + 1 + 4 + 'Tree_float_5_4_3'.length + 4;
  offset.writeBigInt64LE(BigInt(good.length + 1), gridAt);
  await refuses(parseVDB(offset), 'truncated');
  const huge = Buffer.from(good);
  huge.writeBigInt64LE(2n ** 62n, gridAt);
  await refuses(parseVDB(huge), 'range');
  const buffers = Buffer.concat([u32(0), metaBlock(), uniform(), i32(2)]);
  await refuses(parseVDB(file([{ name: 'n', raw: buffers }])), 'unsupported');
  const kind = file([{ name: 'k', leaves: [leaf([0, 0, 0], [0], () => 1, { kind: 6 })] }]);
  const broken = Buffer.from(kind);
  broken[broken.length - 512 * 4 - 1] = 9;
  await refuses(parseVDB(broken), 'syntax');
  const roots = Buffer.concat([u32(0), metaBlock(), uniform(), i32(1), f32(0), u32(0xffffff), u32(0xffffff)]);
  await refuses(parseVDB(file([{ name: 'r', raw: roots }])), 'truncated');
});
