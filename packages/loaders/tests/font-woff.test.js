// WOFF and WOFF2 decoding (W3C WOFF 1.0 and 2.0): containers built here with Node's own zlib and Brotli encoders from
// the repository's Source Sans 3 fonts, hand-assembled WOFF2 transforms with expected values written out from the
// specification's tables, and the site's Source Sans 3 .woff2, made by an independent WOFF2 encoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { LoaderError } from '../dist/index.js';
import { parseTTF } from '../dist/font.js';
import { parseOpenTypeSource } from '../dist/font-opentype.js';
import { decodeWOFF, parseWOFF } from '../dist/font-woff.js';

const fonts = new URL('../../text/tests/fixtures/fonts/', import.meta.url);
const read = (name) => new Uint8Array(readFileSync(new URL(name, fonts)));
const site = new Uint8Array(readFileSync(new URL('../../../site/fonts/SourceSans3-latin.woff2', import.meta.url)));
const failsWith = (code) => (error) => error instanceof LoaderError && error.code === code && error.format === 'WOFF';

const u16 = (v) => [(v >> 8) & 255, v & 255];
const u32 = (v) => [...u16(Math.floor(v / 65536)), ...u16(v & 0xffff)];
const chars = (s) => [...s].map((c) => c.charCodeAt(0));
const concat = (parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(Uint8Array.from(p)))));
const base128 = (v) => {
  const out = [v & 127];
  while ((v = Math.floor(v / 128))) out.unshift((v & 127) | 128);
  return out;
};
const u255 = (v) => (v < 253 ? [v] : v < 506 ? [255, v - 253] : v < 762 ? [254, v - 506] : [253, ...u16(v)]);

/** The tables of an sfnt, or of one font of a collection. */
function tablesOf(bytes, base = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    tables = {};
  for (let i = 0; i < view.getUint16(base + 4); i++) {
    const at = base + 12 + i * 16,
      tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    tables[tag] = bytes.subarray(view.getUint32(at + 8), view.getUint32(at + 8) + view.getUint32(at + 12));
  }
  return { flavor: view.getUint32(base), tables };
}

function woff1(sfnt) {
  const { flavor, tables } = tablesOf(sfnt),
    entries = Object.entries(tables),
    directory = [],
    data = [];
  let offset = 44 + entries.length * 20,
    total = 12 + entries.length * 16;
  for (const [tag, table] of entries) {
    const packed = deflateSync(table),
      stored = packed.length < table.length ? packed : table;
    directory.push(...chars(tag), ...u32(offset), ...u32(stored.length), ...u32(table.length), ...u32(0));
    data.push(stored, new Uint8Array((4 - (stored.length % 4)) % 4));
    offset += (stored.length + 3) & ~3;
    total += (table.length + 3) & ~3;
  }
  const header = [...chars('wOFF'), ...u32(flavor), ...u32(offset), ...u16(entries.length), 0, 0, ...u32(total)];
  while (header.length < 44) header.push(0);
  return concat([header, directory, ...data]);
}

/** A WOFF2 file of `entries` ({tag, data, version?, original?}); `faces` makes it a collection. */
function woff2(entries, { flavor = 0x10000, faces } = {}) {
  const directory = [];
  for (const { tag, data, version, original } of entries) {
    const outline = tag === 'glyf' || tag === 'loca',
      v = version ?? (outline ? 3 : 0),
      transformed = v !== (outline ? 3 : 0);
    directory.push(63 | (v << 6), ...chars(tag), ...base128(original ?? data.length));
    if (transformed) directory.push(...base128(data.length));
  }
  if (faces) {
    directory.push(...u32(0x00010000), ...u255(faces.length));
    for (const face of faces)
      directory.push(...u255(face.indices.length), ...u32(face.flavor), ...face.indices.flatMap(u255));
  }
  const packed = brotliCompressSync(concat(entries.map((e) => e.data))),
    length = 48 + directory.length + packed.length;
  const header = [...chars('wOF2'), ...u32(faces ? 0x74746366 : flavor), ...u32(length), ...u16(entries.length), 0, 0];
  header.push(...u32(0), ...u32(packed.length));
  while (header.length < 48) header.push(0);
  return concat([header, directory, packed]);
}
const untransformed = (sfnt) => {
  const { flavor, tables } = tablesOf(sfnt);
  return woff2(
    Object.entries(tables).map(([tag, data]) => ({ tag, data })),
    { flavor },
  );
};

for (const name of ['SourceSans3-Regular.ttf', 'SourceSans3-Regular.otf'])
  for (const [kind, wrap] of [
    ['WOFF', woff1],
    ['WOFF2', untransformed],
  ])
    test(`${kind} of ${name} decodes to the original tables, glyphs and kerning`, () => {
      const original = read(name),
        decoded = decodeWOFF(wrap(original)),
        mine = tablesOf(decoded),
        theirs = tablesOf(original);
      assert.equal(mine.flavor, theirs.flavor);
      assert.deepEqual(Object.keys(mine.tables).sort(), Object.keys(theirs.tables).sort());
      for (const tag of Object.keys(theirs.tables)) {
        const a = mine.tables[tag].slice(),
          b = theirs.tables[tag].slice();
        // checkSumAdjustment is recomputed for the rebuilt file.
        if (tag === 'head') a.fill(0, 8, 12), b.fill(0, 8, 12);
        assert.ok(Buffer.from(a).equals(Buffer.from(b)), tag);
      }
      // The whole file sums to the OpenType magic once checkSumAdjustment is in.
      const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      let sum = 0;
      for (let i = 0; i < decoded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
      assert.equal(sum, 0xb1b0afba);
      const font = parseWOFF(wrap(original));
      assert.ok(font.glyph('A').commands.length > 0);
      assert.equal(
        font.kerning('A', 'T'),
        parseOpenTypeSource(original).kerning(...[...'AT'].map((c) => font.glyphIndex(c))),
      );
      assert.ok(font.kerning('A', 'T') < 0);
    });

test('parseTTF refuses web fonts and names the decoder entry', () => {
  for (const bytes of [woff1(read('SourceSans3-Regular.ttf')), site])
    assert.throws(
      () => parseTTF(bytes),
      (e) => e.code === 'unsupported' && /loaders\/font-woff/.test(e.message),
    );
});

test("an independent encoder's WOFF2 (transformed glyf and loca, variable font) rebuilds the original outlines", () => {
  const decoded = decodeWOFF(site),
    mine = parseOpenTypeSource(decoded),
    original = parseOpenTypeSource(read('SourceSans3VF-Upright.ttf'));
  assert.equal(mine.unitsPerEm, original.unitsPerEm);
  assert.ok(mine.variationAxes.some((a) => a.tag === 'wght'));
  // Every glyph decodes, and every simple glyph's stored bounding box is the box of its decoded points.
  const { tables } = tablesOf(decoded),
    glyf = new DataView(tables.glyf.buffer, tables.glyf.byteOffset, tables.glyf.byteLength),
    loca = new DataView(tables.loca.buffer, tables.loca.byteOffset, tables.loca.byteLength),
    long = tables.head[51] === 1;
  let boxes = 0;
  for (let i = 0; i < mine.glyphCount; i++) {
    const { commands } = mine.glyph(i);
    const at = long ? loca.getUint32(i * 4) : loca.getUint16(i * 2) * 2,
      end = long ? loca.getUint32(i * 4 + 4) : loca.getUint16(i * 2 + 2) * 2;
    if (end === at || glyf.getInt16(at) < 0) continue;
    // TrueType extremes are on the points: on-curve and control points of the commands (implied midpoints lie inside).
    const xs = commands.flatMap((c) => c.slice(1).filter((_, k) => k % 2 === 0)),
      ys = commands.flatMap((c) => c.slice(1).filter((_, k) => k % 2 === 1));
    assert.deepEqual(
      [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      [2, 4, 6, 8].map((o) => glyf.getInt16(at + o)),
      `glyph ${i}`,
    );
    boxes++;
  }
  assert.ok(boxes > 100);
  // Google serves a later release of the family, so only letters whose design did not change are compared exactly.
  let same = 0;
  for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') {
    const a = mine.glyph(mine.glyphIndex(char.codePointAt(0))),
      b = original.glyph(original.glyphIndex(char.codePointAt(0)));
    if (a.advance === b.advance && JSON.stringify(a.commands) === JSON.stringify(b.commands)) same++;
  }
  assert.ok(same >= 40, `${same} of 52 letters match the TrueType original`);
});

// A transformed glyf table written from the specification: a triangle with one triplet of every band, an empty
// glyph, and a composite with instructions.
function transformedFont({ points, indexFormat = 0, hmtxFlags = 3 }) {
  const streams = {
    contours: [...u16(1), ...u16(0), ...u16(0xffff)],
    counts: u255(points.length),
    flags: points.map((p) => p.flag | (p.off ? 128 : 0)),
    glyphs: [...points.flatMap((p) => p.bytes), ...u255(1), ...u255(2)],
    // Composite: words and xy offsets, instructions follow; component glyph 0 at (100, -50).
    composite: [...u16(0x103), ...u16(0), ...u16(100), ...u16(0xffce)],
    boxes: [0x20, 0, 0, 0, ...u16(100), ...u16(0xffce), ...u16(2000), ...u16(1000)],
    instructions: [0xb0, 0xb1, 0xb2],
  };
  const glyf = concat([
    [0, 0, ...u16(1), ...u16(3), ...u16(indexFormat)],
    ...Object.values(streams).map((s) => u32(s.length)),
    ...Object.values(streams),
    [0x80], // overlap bitmap: glyph 0
  ]);
  const head = new Uint8Array(54);
  head.set(u32(0x5f0f3cf5), 12);
  head.set(u16(1000), 18);
  const hhea = new Uint8Array(36);
  hhea.set(u16(2), 34);
  const cmap = Uint8Array.from([
    0,
    0,
    ...u16(1),
    ...u16(3),
    ...u16(10),
    ...u32(12),
    ...u16(12),
    0,
    0,
    ...u32(28),
    ...u32(0),
    ...u32(1),
    ...u32(65),
    ...u32(67),
    ...u32(0),
  ]);
  // Advances 500 and 600; every side bearing is left to the glyph boxes.
  const hmtx = Uint8Array.from([hmtxFlags, ...u16(500), ...u16(600)]);
  return [
    { tag: 'cmap', data: cmap },
    { tag: 'head', data: head },
    { tag: 'hhea', data: hhea },
    { tag: 'maxp', data: Uint8Array.from([...u32(0x5000), ...u16(3)]) },
    { tag: 'hmtx', data: hmtx, version: 1, original: 10 },
    { tag: 'glyf', data: glyf, version: 0, original: 100 },
    { tag: 'loca', data: new Uint8Array(0), version: 0, original: 8 },
  ];
}

// [flag, triplet bytes, dx, dy], worked by hand from the specification's "Triplet Encoding" table.
const TRIPLETS = [
  [3, [10], 0, 266], // 0-9: dy = 256 * 1 + 10, sign bit set
  [10, [20], -20, 0], // 10-19: dx = -(0 + 20)
  [13, [5], 261, 0],
  [20, [0x12], -2, -3], // 20-83: one byte, dx = 1 + 1, dy = 1 + 2
  [83, [0xff], 64, 64], // base 49 + 15, both positive
  [84, [7, 9], -8, -10], // 84-119: two bytes
  [119, [255, 1], 768, 514], // dx = 1 + 512 + 255, dy = 1 + 512 + 1
  [123, [0x12, 0x34, 0x56], 0x123, 0x456], // 120-123: 12 + 12 bits
  [124, [0x01, 0x02, 0x03, 0x04], -0x102, -0x304], // 124-127: 16 + 16 bits
  [127, [0x00, 0x64, 0x00, 0x32], 100, 50],
];
const points = TRIPLETS.map(([flag, bytes], i) => ({ flag, bytes, off: i === 4 }));

test('transformed glyf: every triplet band, composite instructions, overlap bit, loca and hmtx', () => {
  const decoded = decodeWOFF(woff2(transformedFont({ points }))),
    { tables } = tablesOf(decoded),
    view = new DataView(tables.glyf.buffer, tables.glyf.byteOffset, tables.glyf.byteLength);
  let x = 0,
    y = 0;
  const expected = TRIPLETS.map(([, , dx, dy]) => [(x += dx), (y += dy)]);
  assert.equal(view.getInt16(0), 1);
  assert.deepEqual(
    [2, 4, 6, 8].map((o) => view.getInt16(o)),
    [
      Math.min(...expected.map((p) => p[0])),
      Math.min(...expected.map((p) => p[1])),
      Math.max(...expected.map((p) => p[0])),
      Math.max(...expected.map((p) => p[1])),
    ],
  );
  assert.equal(view.getUint16(10), TRIPLETS.length - 1);
  assert.deepEqual([view.getUint16(12), tables.glyf[14]], [1, 0xb0], 'one instruction byte');
  assert.equal(tables.glyf[15] & 0x41, 0x41, 'first point on curve with the overlap bit');
  const source = parseOpenTypeSource(decoded),
    commands = source.glyph(0).commands,
    drawn = commands.flatMap((c) => (c.length > 1 ? [c.slice(c.length - 2)] : []));
  assert.ok(
    commands.some((c) => c[0] === 'Q'),
    'point 4 is off curve',
  );
  for (const p of expected.filter((_, i) => i !== 4))
    assert.ok(
      drawn.some((q) => q[0] === p[0] && q[1] === p[1]),
      `${p}`,
    );
  assert.equal(source.glyph(1).commands.length, 0);
  assert.deepEqual(
    source.glyph(2).commands[0].slice(1),
    commands[0].slice(1).map((v, i) => v + [100, -50][i % 2]),
  );
  assert.deepEqual(Array.from(tables.glyf.subarray(-4)), [0, 2, 0xb1, 0xb2]);
  // Side bearings are the glyphs' xMin (0 for the empty glyph).
  const metrics = new DataView(tables.hmtx.buffer, tables.hmtx.byteOffset, tables.hmtx.byteLength);
  assert.deepEqual(
    [0, 2, 4, 6, 8].map((o) => metrics.getInt16(o)),
    [500, view.getInt16(2), 600, 0, 100],
  );
  assert.equal(source.glyph(2).advance, 600);
  assert.equal(tables.head[51], 0, 'short loca kept');
});

test('a rebuilt glyf past the short loca range switches head and loca to long offsets', () => {
  const many = Array.from({ length: 40000 }, (_, i) => ({ flag: 127, bytes: [1, 44, 1, 44], off: false, i })).map(
    // Alternate +300 and -300 so the coordinates stay in range and every delta needs two bytes.
    (p) => ({ ...p, flag: p.i & 1 ? 124 : 127 }),
  );
  const decoded = decodeWOFF(woff2(transformedFont({ points: many }))),
    { tables } = tablesOf(decoded);
  assert.equal(tables.head[51], 1);
  assert.equal(tables.loca.length, 16);
  assert.ok(parseOpenTypeSource(decoded).glyph(2).commands.length > 40000);
});

test('a WOFF2 collection shares tables and reads by fontIndex', () => {
  const entries = transformedFont({ points }),
    second = Uint8Array.from(entries[2].data);
  second.set(u16(700), 4);
  entries.push({ tag: 'hhea', data: second });
  const decoded = decodeWOFF(
    woff2(entries, {
      faces: [
        { flavor: 0x10000, indices: [0, 1, 2, 3, 4, 5, 6] },
        { flavor: 0x10000, indices: [0, 1, 7, 3, 4, 5, 6] },
      ],
    }),
  );
  assert.equal(String.fromCharCode(...decoded.subarray(0, 4)), 'ttcf');
  const first = parseOpenTypeSource(decoded),
    other = parseOpenTypeSource(decoded, { fontIndex: 1 });
  assert.equal(first.ascender, 0);
  assert.equal(other.ascender, 700);
  assert.deepEqual(first.glyph(2), other.glyph(2));
  assert.equal(first.table('glyf').byteOffset, other.table('glyf').byteOffset, 'stored once');
});

test('damaged, oversized and unknown web fonts throw coded errors', () => {
  const ttf = read('SourceSans3-Regular.ttf'),
    one = woff1(ttf),
    two = untransformed(ttf),
    patch = (bytes, at, values) => {
      const copy = bytes.slice();
      copy.set(values, at);
      return copy;
    };
  assert.throws(() => decodeWOFF(ttf), failsWith('header'));
  assert.throws(() => decodeWOFF(new Uint8Array(8)), failsWith('header'));
  for (const bytes of [one, two, site]) {
    assert.throws(() => decodeWOFF(bytes.subarray(0, bytes.length - 1)), failsWith('truncated'));
    assert.throws(() => decodeWOFF(bytes, { maxBytes: 1000 }), failsWith('limit'));
    assert.throws(() => decodeWOFF(bytes, { maxBytes: NaN }), failsWith('range'));
    assert.throws(() => decodeWOFF(patch(bytes, 12, u16(0))), failsWith('limit'));
  }
  assert.throws(() => decodeWOFF(patch(one, 16, u32(12))), failsWith('header'), 'totalSfntSize');
  assert.throws(() => decodeWOFF(patch(one, 44 + 12, u32(0x7fffffff))), failsWith('limit'), 'a table past maxBytes');
  assert.throws(() => decodeWOFF(patch(one, one.length - 40, new Array(36).fill(0xff))), LoaderError, 'bad zlib data');
  assert.throws(
    () => decodeWOFF(patch(site, site.length - 4000, new Array(64).fill(0xff))),
    LoaderError,
    'bad Brotli data',
  );
  const entries = transformedFont({ points });
  const broken = (change) => {
    const list = transformedFont({ points });
    change(list);
    return woff2(list);
  };
  assert.throws(() => decodeWOFF(broken((l) => (l[0].version = 2))), failsWith('unsupported'));
  assert.throws(() => decodeWOFF(broken((l) => l.pop())), failsWith('header'), 'glyf without loca');
  assert.throws(
    () => decodeWOFF(broken((l) => (l[4].data = Uint8Array.of(0, 0, 0, 0, 0)))),
    failsWith('header'),
    'hmtx flags',
  );
  assert.throws(
    () =>
      decodeWOFF(
        woff2(
          transformedFont({
            points: [
              { flag: 125, bytes: [0x7f, 0xff, 0, 0] },
              { flag: 125, bytes: [0x7f, 0xff, 0, 0] },
            ],
          }),
        ),
      ),
    failsWith('range'),
  );
  // Many transformed 'hmtx' tables, each rebuilt larger, stop at maxBytes as they are made.
  const fonts = transformedFont({ points });
  fonts.push({ tag: 'hmtx', data: fonts[4].data, version: 1, original: 10 });
  const faces = [4, 7].map((hmtx) => ({ flavor: 0x10000, indices: [0, 1, 2, 3, hmtx, 5, 6] }));
  assert.ok(decodeWOFF(woff2(fonts, { faces })).length > 0);
  assert.throws(() => decodeWOFF(woff2(fonts, { faces }), { maxBytes: 200 }), failsWith('limit'));
  // Every truncation of the transformed streams fails with a coded error, never a TypeError or a hang.
  const glyf = entries[5].data;
  for (let length = 0; length < glyf.length - 1; length++)
    assert.throws(
      () => decodeWOFF(broken((l) => (l[5].data = glyf.subarray(0, length)))),
      LoaderError,
      `glyf cut at ${length}`,
    );
});
