import test from 'node:test';
import assert from 'node:assert/strict';
import { LoaderError } from '../dist/index.js';
import { OutlineFont, parseTTF, parseTypefaceJSON, textGeometry } from '../dist/font.js';

// A tiny TrueType font assembled from the OpenType specification's table layouts (no font file is read or committed).

class Writer {
  bytes = [];
  u8(v) {
    this.bytes.push(v & 255);
    return this;
  }
  i8(v) {
    return this.u8(v < 0 ? v + 256 : v);
  }
  u16(v) {
    return this.u8(v >> 8).u8(v);
  }
  i16(v) {
    return this.u16(v < 0 ? v + 65536 : v);
  }
  u32(v) {
    return this.u16(Math.floor(v / 65536)).u16(v & 0xffff);
  }
  tag(s) {
    for (const c of s) this.u8(c.charCodeAt(0));
    return this;
  }
  get length() {
    return this.bytes.length;
  }
  result() {
    return Uint8Array.from(this.bytes);
  }
}

/** sfnt wrapper: header, table records sorted by tag, 4-byte aligned table data. */
function sfnt(tables, version = 0x00010000) {
  const tags = Object.keys(tables).sort(),
    w = new Writer().u32(version).u16(tags.length).u16(0).u16(0).u16(0);
  let offset = 12 + tags.length * 16;
  const placed = [];
  for (const tag of tags) {
    const data = tables[tag];
    w.tag(tag).u32(0).u32(offset).u32(data.length);
    placed.push([offset, data]);
    offset += Math.ceil(data.length / 4) * 4;
  }
  const out = new Uint8Array(offset);
  out.set(w.result());
  for (const [at, data] of placed) out.set(data, at);
  return out;
}

/** A simple glyph: contours of [x, y, onCurve] points, encoded with short, same and long deltas and repeat flags. */
function simpleGlyph(contours) {
  const points = contours.flat(),
    xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]),
    w = new Writer().i16(contours.length);
  w.i16(Math.min(...xs))
    .i16(Math.min(...ys))
    .i16(Math.max(...xs))
    .i16(Math.max(...ys));
  let end = -1;
  for (const contour of contours) w.u16((end += contour.length));
  w.u16(0); // no instructions
  const flags = [],
    xData = new Writer(),
    yData = new Writer();
  let px = 0,
    py = 0;
  for (const [x, y, on] of points) {
    let flag = on ? 1 : 0;
    const dx = x - px,
      dy = y - py;
    if (dx === 0) flag |= 16;
    else if (Math.abs(dx) < 256) {
      flag |= 2 | (dx > 0 ? 16 : 0);
      xData.u8(Math.abs(dx));
    } else xData.i16(dx);
    if (dy === 0) flag |= 32;
    else if (Math.abs(dy) < 256) {
      flag |= 4 | (dy > 0 ? 32 : 0);
      yData.u8(Math.abs(dy));
    } else yData.i16(dy);
    flags.push(flag);
    px = x;
    py = y;
  }
  for (let i = 0; i < flags.length; ) {
    let run = 1;
    while (i + run < flags.length && flags[i + run] === flags[i] && run < 255) run++;
    if (run > 1) {
      w.u8(flags[i] | 8).u8(run - 1);
      i += run;
    } else w.u8(flags[i++]);
  }
  w.bytes.push(...xData.bytes, ...yData.bytes);
  return w.result();
}

const rect = (x0, y0, x1, y1) => [
  [x0, y0, 1],
  [x0, y1, 1],
  [x1, y1, 1],
  [x1, y0, 1],
];
const reverse = (contours) => contours.map((c) => c.slice().reverse());

// Outer contour clockwise (TrueType convention) with off-curve corners; the hole is counter-clockwise and all
// off-curve, so every on-curve point of it is implied.
const O_OUTLINE = [
  [
    [300, 0, 1],
    [0, 0, 0],
    [0, 350, 1],
    [0, 700, 0],
    [300, 700, 1],
    [600, 700, 0],
    [600, 350, 1],
    [600, 0, 0],
  ],
  [
    [200, 200, 0],
    [400, 200, 0],
    [400, 500, 0],
    [200, 500, 0],
  ],
];

/** Composite H: I, then I scaled by 0.5 at (400, 0), then I with its point 0 matched to the composite's point 6. */
function compositeH() {
  return new Writer()
    .i16(-1)
    .i16(0)
    .i16(0)
    .i16(550)
    .i16(1050)
    .u16(0x0023)
    .u16(3)
    .i16(0)
    .i16(0)
    .u16(0x002b)
    .u16(3)
    .i16(400)
    .i16(0)
    .i16(0x2000)
    .u16(0x0000)
    .u16(3)
    .u8(6)
    .u8(0)
    .result();
}

function cmapFormat4(map, ranged) {
  // Segments: single characters by idDelta, one range through glyphIdArray, then the 0xFFFF terminator.
  const singles = Object.entries(map)
      .map(([c, g]) => [c.codePointAt(0), g])
      .sort((a, b) => a[0] - b[0]),
    segments = [...singles.map(([c, g]) => ({ start: c, end: c, delta: (g - c) & 0xffff, ids: null }))];
  segments.push({ start: ranged.start, end: ranged.start + ranged.ids.length - 1, delta: 0, ids: ranged.ids });
  segments.sort((a, b) => a.start - b.start);
  segments.push({ start: 0xffff, end: 0xffff, delta: 1, ids: null });
  const n = segments.length,
    w = new Writer()
      .u16(4)
      .u16(0)
      .u16(0)
      .u16(n * 2)
      .u16(0)
      .u16(0)
      .u16(0);
  for (const s of segments) w.u16(s.end);
  w.u16(0);
  for (const s of segments) w.u16(s.start);
  for (const s of segments) w.u16(s.delta);
  let arrayOffset = 0;
  const ids = [];
  segments.forEach((s, i) => {
    if (!s.ids) w.u16(0);
    else {
      // Bytes from this idRangeOffset entry to its first glyphIdArray entry.
      w.u16((n - i) * 2 + arrayOffset * 2);
      ids.push(...s.ids);
      arrayOffset += s.ids.length;
    }
  });
  for (const id of ids) w.u16(id);
  const data = w.result();
  data[2] = data.length >> 8;
  data[3] = data.length & 255;
  return data;
}

function cmapFormat12(groups) {
  const w = new Writer()
    .u16(12)
    .u16(0)
    .u32(16 + groups.length * 12)
    .u32(0)
    .u32(groups.length);
  for (const [start, end, glyph] of groups) w.u32(start).u32(end).u32(glyph);
  return w.result();
}

function cmapTable(platform, encoding, subtable) {
  const w = new Writer().u16(0).u16(1).u16(platform).u16(encoding).u32(12);
  w.bytes.push(...subtable);
  return w.result();
}

function nameTable(family, style) {
  const strings = [family, style].map((s) => {
    const w = new Writer();
    for (const c of s) w.u16(c.charCodeAt(0));
    return w.result();
  });
  const w = new Writer()
    .u16(0)
    .u16(2)
    .u16(6 + 2 * 12);
  let offset = 0;
  strings.forEach((data, i) => {
    w.u16(3)
      .u16(1)
      .u16(0x409)
      .u16(i + 1)
      .u16(data.length)
      .u16(offset);
    offset += data.length;
  });
  for (const data of strings) w.bytes.push(...data);
  return w.result();
}

/** Glyphs: 0 .notdef box, 1 space, 2 O, 3 I, 4 composite H. */
function buildFont({ unitsPerEm = 1000, reversed = false, longLoca = false, cmap = 'format4', kern = true } = {}) {
  const outlines = [
    simpleGlyph(reversed ? reverse([rect(50, 0, 450, 700)]) : [rect(50, 0, 450, 700)]),
    new Uint8Array(0),
    simpleGlyph(reversed ? reverse(O_OUTLINE) : O_OUTLINE),
    simpleGlyph(reversed ? reverse([rect(0, 0, 100, 700)]) : [rect(0, 0, 100, 700)]),
    compositeH(),
  ];
  const advances = [500, 250, 600, 200, 600];
  const glyf = new Writer(),
    loca = new Writer();
  for (const outline of outlines) {
    if (longLoca) loca.u32(glyf.length);
    else loca.u16(glyf.length / 2);
    glyf.bytes.push(...outline);
    while (glyf.length % 4) glyf.u8(0);
  }
  if (longLoca) loca.u32(glyf.length);
  else loca.u16(glyf.length / 2);
  const head = new Writer().u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(0).u16(unitsPerEm);
  while (head.length < 36) head.u8(0);
  head
    .i16(0)
    .i16(-200)
    .i16(600)
    .i16(1050)
    .u16(0)
    .u16(8)
    .i16(2)
    .i16(longLoca ? 1 : 0)
    .i16(0);
  const hhea = new Writer().u32(0x00010000).i16(800).i16(-200).i16(100);
  while (hhea.length < 34) hhea.u8(0);
  // Four long metrics: glyph 4 has only a left side bearing and takes glyph 3's advance.
  hhea.u16(4);
  const hmtx = new Writer();
  for (let i = 0; i < 4; i++) hmtx.u16(advances[i]).i16(0);
  hmtx.i16(0);
  const tables = {
    head: head.result(),
    hhea: hhea.result(),
    maxp: new Writer().u32(0x00005000).u16(outlines.length).result(),
    hmtx: hmtx.result(),
    loca: loca.result(),
    glyf: glyf.result(),
    name: nameTable('Test Sans', 'Regular'),
    cmap:
      cmap === 'format4'
        ? cmapTable(3, 1, cmapFormat4({ ' ': 1, O: 2, I: 3, H: 4 }, { start: 65, ids: [3, 2] }))
        : cmapTable(
            3,
            10,
            cmapFormat12([
              [32, 32, 1],
              [72, 72, 4],
              [73, 73, 3],
              [79, 79, 2],
              [0x1f600, 0x1f601, 2],
            ]),
          ),
  };
  if (kern)
    tables.kern = new Writer()
      .u16(0)
      .u16(1)
      .u16(0)
      .u16(14 + 6)
      .u16(0x0001)
      .u16(1)
      .u16(6)
      .u16(0)
      .u16(0)
      .u16(3)
      .u16(2)
      .i16(-50)
      .result();
  return sfnt(tables);
}

/** Bounds of a shape's outline (and of its holes) sampled at its points. */
function bounds(path) {
  const points = path.getPoints(8);
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v * 1000) / 1000);
}

const isLoaderError = (code) => (error) => error instanceof LoaderError && error.code === code;

test('TTF: tables, metrics, names, cmap format 4 (delta and glyphIdArray segments), advances', () => {
  const font = parseTTF(buildFont());
  assert.ok(font instanceof OutlineFont);
  assert.equal(font.unitsPerEm, 1000);
  assert.equal(font.ascender, 800);
  assert.equal(font.descender, -200);
  assert.equal(font.lineHeight, 1100);
  assert.equal(font.glyphCount, 5);
  assert.equal(font.familyName, 'Test Sans');
  assert.equal(font.styleName, 'Regular');
  assert.equal(font.glyphIndex('O'), 2);
  assert.equal(font.glyphIndex(73), 3);
  assert.equal(font.glyphIndex('A'), 3, 'idRangeOffset segment');
  assert.equal(font.glyphIndex('B'), 2, 'idRangeOffset segment');
  assert.equal(font.glyphIndex('Z'), undefined);
  assert.equal(font.glyph(' ').commands.length, 0);
  assert.equal(font.glyph(' ').advance, 250);
  assert.equal(font.glyph('H').advance, 200, 'glyphs past numberOfHMetrics take the last long advance');
  assert.throws(() => font.glyphIndex({}), TypeError);
});

test('TTF: quadratic contours with implied on-curve points, and an all-off-curve contour', () => {
  const { commands } = parseTTF(buildFont()).glyph('O');
  const outer = commands.slice(0, commands.findIndex((c) => c[0] === 'Z') + 1);
  assert.deepEqual(outer, [
    ['M', 300, 0],
    ['Q', 0, 0, 0, 350],
    ['Q', 0, 700, 300, 700],
    ['Q', 600, 700, 600, 350],
    ['Q', 600, 0, 300, 0],
    ['Z'],
  ]);
  const inner = commands.slice(outer.length);
  assert.deepEqual(inner, [
    ['M', 200, 350],
    ['Q', 200, 200, 300, 200],
    ['Q', 400, 200, 400, 350],
    ['Q', 400, 500, 300, 500],
    ['Q', 200, 500, 200, 350],
    ['Z'],
  ]);
});

test('TTF: composite glyph with offset, scale and point matching; long loca offsets', () => {
  for (const longLoca of [false, true]) {
    const font = parseTTF(buildFont({ longLoca })),
      shapes = font.generateShapes('H', 1000);
    assert.equal(shapes.length, 3);
    assert.deepEqual(bounds(shapes[0]), [0, 0, 100, 700]);
    assert.deepEqual(bounds(shapes[1]), [400, 0, 450, 350]);
    // Point 0 of the third I (its origin) sits on the composite's point 6, (450, 350).
    assert.deepEqual(bounds(shapes[2]), [450, 350, 550, 1050]);
  }
});

test('TTF: cmap format 12 reaches code points past U+FFFF', () => {
  const font = parseTTF(buildFont({ cmap: 'format12' }));
  assert.equal(font.glyphIndex('O'), 2);
  assert.equal(font.glyphIndex('\u{1F600}'), 2);
  assert.equal(font.glyphIndex('\u{1F601}'), 3, 'a group maps consecutive code points to consecutive glyphs');
  assert.equal(font.glyphIndex('A'), undefined);
});

test('generateShapes: holes by containment for both winding conventions, scale, kerning, spacing, lines, align', () => {
  for (const reversed of [false, true]) {
    const font = parseTTF(buildFont({ reversed })),
      [o] = font.generateShapes('O', 100);
    assert.equal(o.holes.length, 1, `reversed=${reversed}`);
    assert.deepEqual(bounds(o), [0, 0, 60, 70]);
    assert.deepEqual(bounds(o.holes[0]), [20, 20, 40, 50]);
  }
  const font = parseTTF(buildFont());
  assert.equal(font.kerning('I', 'O'), -50);
  assert.equal(font.kerning('O', 'I'), 0);
  // I (advance 200) then O kerned by -50.
  let [i, o] = font.generateShapes('IO', 1000);
  assert.equal(bounds(o)[0], 150);
  [i, o] = font.generateShapes('IO', 1000, { kerning: false });
  assert.equal(bounds(o)[0], 200);
  [i, o] = font.generateShapes('II', 1000, { letterSpacing: 0.1 });
  assert.equal(bounds(o)[0], 300);
  [i, o] = font.generateShapes('I\r\nI', 1000, { lineHeight: 1.5 });
  assert.deepEqual(bounds(i), [0, 0, 100, 700]);
  assert.deepEqual(bounds(o), [0, -1650, 100, -950]);
  [i] = font.generateShapes('I', 1000, { align: 'center' });
  assert.deepEqual(bounds(i), [-100, 0, 0, 700]);
  [i] = font.generateShapes('I', 1000, { align: 'right' });
  assert.deepEqual(bounds(i), [-200, 0, -100, 700]);
  // A missing character draws .notdef (glyph 0); a space draws nothing but advances.
  const [box, after] = font.generateShapes('Z I', 1000);
  assert.deepEqual(bounds(box), [50, 0, 450, 700]);
  assert.equal(bounds(after)[0], 750);
  assert.throws(() => font.generateShapes('I', 0), RangeError);
  assert.throws(() => font.generateShapes(42), TypeError);
});

test('textGeometry: extruded text through extrudeGeometry with three.js defaults and groups', () => {
  const font = parseTTF(buildFont()),
    data = textGeometry('IO', { font, size: 100, depth: 5 });
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < data.positions.length; v += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], data.positions[v + k]);
      max[k] = Math.max(max[k], data.positions[v + k]);
    }
  assert.deepEqual(
    [...min, ...max].map((v) => Math.round(v * 1000) / 1000),
    [0, 0, 0, 75, 70, 5],
  );
  assert.equal(data.indices.length, data.positions.length / 3);
  assert.ok(data.groups.length >= 4 && data.groups.every((g) => g.materialIndex === 0 || g.materialIndex === 1));
  const beveled = textGeometry('I', { font, size: 100, depth: 5, bevelEnabled: true, bevelThickness: 1, bevelSize: 1 });
  assert.ok(beveled.positions.length > textGeometry('I', { font, size: 100, depth: 5 }).positions.length);
  assert.throws(() => textGeometry('I', { font: {} }), TypeError);
});

test('TTF: collections, unsupported flavours and malformed files throw LoaderErrors', () => {
  const first = buildFont(),
    second = buildFont({ unitsPerEm: 2048 }),
    header = new Writer()
      .tag('ttcf')
      .u32(0x00010000)
      .u32(2)
      .u32(20)
      .u32(20 + first.length)
      .result(),
    collection = new Uint8Array(20 + first.length + second.length);
  // Table offsets in a collection count from the start of the file: shift each font's records.
  const shift = (font, by) => {
    const copy = font.slice(),
      view = new DataView(copy.buffer);
    for (let i = 0; i < view.getUint16(4); i++) view.setUint32(12 + i * 16 + 8, view.getUint32(12 + i * 16 + 8) + by);
    return copy;
  };
  collection.set(header);
  collection.set(shift(first, 20), 20);
  collection.set(shift(second, 20 + first.length), 20 + first.length);
  assert.equal(parseTTF(collection).unitsPerEm, 1000);
  assert.equal(parseTTF(collection, { fontIndex: 1 }).unitsPerEm, 2048);
  assert.throws(() => parseTTF(collection, { fontIndex: 2 }), isLoaderError('range'));
  const cff = sfnt({ 'CFF ': new Uint8Array(8) }, 0x4f54544f);
  assert.throws(
    () => parseTTF(cff),
    (e) => isLoaderError('unsupported')(e) && /CFF/.test(e.message),
  );
  assert.throws(() => parseTTF(new Writer().tag('wOF2').u32(0).u32(0).result()), isLoaderError('unsupported'));
  assert.throws(() => parseTTF(new Uint8Array(4)), isLoaderError('truncated'));
  assert.throws(() => parseTTF(new Writer().tag('abcd').u32(0).u32(0).result()), isLoaderError('header'));
  assert.throws(() => parseTTF(sfnt({ head: new Uint8Array(54) })), isLoaderError('header'));
  // A loca entry past the end of glyf fails when that glyph is decoded, not before.
  const font = buildFont(),
    view = new DataView(font.buffer);
  for (let i = 0; i < view.getUint16(4); i++)
    if (String.fromCharCode(...font.subarray(12 + i * 16, 16 + i * 16)) === 'loca')
      view.setUint16(view.getUint32(12 + i * 16 + 8) + 5 * 2, 0xfff0);
  const broken = parseTTF(font);
  assert.equal(broken.generateShapes('O', 10).length, 1);
  assert.throws(() => broken.generateShapes('H', 10), isLoaderError('range'));
});

test('typeface JSON: m l q b z outlines (end point first), holes either way round, line height, missing glyph', () => {
  const font = parseTypefaceJSON(
    JSON.stringify({
      resolution: 1000,
      familyName: 'Typeface Test',
      boundingBox: { xMin: 0, xMax: 600, yMin: -200, yMax: 800 },
      underlineThickness: 50,
      glyphs: {
        // Outer counter-clockwise, hole clockwise: the opposite of TrueType.
        o: { ha: 600, o: 'm 0 0 l 600 0 l 600 700 l 0 700 z m 100 100 l 100 600 l 500 600 l 500 100 z' },
        q: { ha: 500, o: 'm 0 0 q 400 0 200 300 z' },
        b: { ha: 500, o: 'm 0 0 b 300 0 0 300 300 300 z' },
        '?': { ha: 300, o: 'm 0 0 l 100 0 l 100 100 z' },
        ' ': { ha: 250 },
      },
    }),
  );
  assert.equal(font.familyName, 'Typeface Test');
  assert.equal(font.lineHeight, 1050);
  const [o] = font.generateShapes('o', 1000);
  assert.equal(o.holes.length, 1);
  assert.deepEqual(bounds(o.holes[0]), [100, 100, 500, 600]);
  assert.deepEqual(font.glyph('q').commands, [['M', 0, 0], ['Q', 200, 300, 400, 0], ['Z']]);
  assert.deepEqual(font.glyph('b').commands, [['M', 0, 0], ['C', 0, 300, 300, 300, 300, 0], ['Z']]);
  // Unknown characters draw '?'; the second line sits one line height lower.
  const shapes = font.generateShapes('x\no', 1000);
  assert.deepEqual(bounds(shapes[0]), [0, 0, 100, 100]);
  assert.deepEqual(bounds(shapes[1]), [0, -1050, 600, -350]);
  assert.throws(() => parseTypefaceJSON('{'), isLoaderError('syntax'));
  assert.throws(() => parseTypefaceJSON({ resolution: 1000 }), TypeError);
  assert.throws(
    () => parseTypefaceJSON({ resolution: 1000, glyphs: { a: { ha: 1, o: 'm 0 x' } } }).glyph('a'),
    isLoaderError('syntax'),
  );
});
