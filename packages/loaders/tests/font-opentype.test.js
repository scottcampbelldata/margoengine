// OpenType outlines beyond plain TrueType: CFF and CFF2 charstrings, variable fonts (fvar, avar, gvar, HVAR, CFF2
// blends), ROUND_XY_TO_GRID composites, the composite work budget and raw table access. The real fonts and their
// independent references (Windows GDI outlines, FontTools instances) are the text package's fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LoaderError } from '../dist/index.js';
import { parseTTF, parseTTFSource } from '../dist/font.js';
import { openType, parseOpenType, parseOpenTypeSource } from '../dist/font-opentype.js';

const fonts = new URL('../../text/tests/fixtures/fonts/', import.meta.url);
const read = (name) => readFileSync(new URL(name, fonts));
const outlineReference = JSON.parse(read('outline-reference.json'));
const variableReference = JSON.parse(read('variable-reference.json'));

/** Polyline of a command list: `samples` uniform steps per curve. Returns one point list per contour. */
function flatten(commands, samples) {
  const loops = [];
  let loop,
    x = 0,
    y = 0;
  for (const c of commands) {
    if (c[0] === 'M') loops.push((loop = [[(x = c[1]), (y = c[2])]]));
    else if (c[0] === 'L') loop.push([(x = c[1]), (y = c[2])]);
    else if (c[0] === 'Q' || c[0] === 'C') {
      const p = [[x, y]];
      for (let i = 1; i < c.length; i += 2) p.push([c[i], c[i + 1]]);
      for (let s = 1; s <= samples; s++) loop.push(bezier(p, s / samples));
      [x, y] = p[p.length - 1];
    }
  }
  return loops;
}
function bezier(points, t) {
  let p = points;
  while (p.length > 1) p = p.slice(1).map((q, i) => [p[i][0] * (1 - t) + q[0] * t, p[i][1] * (1 - t) + q[1] * t]);
  return p[0];
}
function distance([px, py], loops) {
  let best = Infinity;
  for (const loop of loops)
    for (let i = 0; i < loop.length; i++) {
      const [ax, ay] = loop[i],
        [bx, by] = loop[(i + 1) % loop.length],
        dx = bx - ax,
        dy = by - ay,
        l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
      best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
  return best;
}

test('CFF (.otf) glyphs decode to cubic outlines matching the GDI reference', () => {
  const font = parseOpenType(read('SourceSans3-Regular.otf'));
  const expected = outlineReference.fonts.otf.glyphs;
  for (const [char, ref] of Object.entries(expected)) {
    const glyph = font.glyph(char);
    assert.equal(glyph.index, ref.index, char);
    assert.ok(
      glyph.commands.some((c) => c[0] === 'C'),
      `${char} has cubic segments`,
    );
    const mine = flatten(glyph.commands, 64);
    assert.equal(mine.length, ref.contours.length, `${char} contour count`);
    // Every reference point (segment ends and curve samples at 1000 ppem, 1 unit per em-thousandth) lies on our outline.
    for (const contour of ref.contours)
      for (const segment of contour)
        for (let s = 0; s <= 8; s++)
          assert.ok(distance(bezier(segment, s / 8), mine) < 0.05, `${char} off the outline`);
  }
  assert.ok(font.generateShapes('Ag', 100).length > 0);
});

for (const extension of ['ttf', 'otf'])
  test(`variable ${extension} instances (gvar or CFF2 blends, HVAR) match the FontTools reference`, () => {
    const bytes = read(`SourceSans3VF-Upright.${extension}`),
      ref = variableReference.fonts[extension];
    assert.deepEqual(parseOpenType(bytes).variationAxes, ref.axes);
    for (const sample of ref.samples) {
      const source = parseOpenTypeSource(bytes, { variations: { wght: sample.weight } });
      assert.equal(source.glyphIndex(sample.char.codePointAt(0)), sample.index);
      assert.equal(source.variationCoordinates[0], sample.normalized);
      const glyph = source.glyph(sample.index),
        em = source.unitsPerEm;
      assert.ok(
        Math.abs(glyph.advance / em - sample.advance) <= 1e-7,
        `${sample.char}@${sample.weight} advance ${glyph.advance / em}`,
      );
      const points = flatten(glyph.commands, 12).flat();
      const bounds = [
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1])),
      ];
      bounds.forEach((v, i) =>
        assert.ok(Math.abs(v / em - sample.bounds[i]) <= 1e-7, `${sample.char}@${sample.weight} bound ${i}`),
      );
    }
  });

test('variations: an axis the font lacks throws a range LoaderError; a static font has no axes', () => {
  assert.throws(
    () => parseTTF(read('SourceSans3VF-Upright.ttf'), { variations: { wdth: 80 }, openType }),
    (e) => e instanceof LoaderError && e.code === 'range' && /wdth/.test(e.message),
  );
  assert.deepEqual(parseTTF(read('SourceSans3-Regular.ttf')).variationAxes, []);
});

test('without the OpenType readers: TrueType and the default instance read, CFF and instances name the fix', () => {
  const unsupported = (e) =>
    e instanceof LoaderError &&
    e.code === 'unsupported' &&
    e.message.includes("pass { openType } from '@margoengine/loaders/font-opentype' (or call its parseOpenType)") &&
    e.message.includes('GlyphFieldFont.load or VectorFont.load') &&
    e.message.endsWith('see https://margoengine.com/errors#loader-unsupported');
  assert.throws(
    () => parseTTF(read('SourceSans3-Regular.otf')),
    /this font has CFF outlines, which need the OpenType readers/,
  );
  assert.throws(
    () => parseTTF(read('SourceSans3VF-Upright.ttf'), { variations: { wght: 700 } }),
    /variations were requested/,
  );
  assert.throws(() => parseTTF(read('SourceSans3-Regular.otf')), unsupported);
  assert.throws(() => parseTTF(read('SourceSans3VF-Upright.otf')), unsupported);
  assert.throws(() => parseTTF(read('SourceSans3VF-Upright.ttf'), { variations: { wght: 700 } }), unsupported);
  // gvar and HVAR deltas are 0 at the default instance, so the lean path gives the readers' result exactly.
  const bytes = read('SourceSans3VF-Upright.ttf'),
    lean = parseTTFSource(bytes),
    full = parseOpenTypeSource(bytes);
  assert.deepEqual(lean.variationAxes, full.variationAxes);
  for (const char of 'AgjQ&\u00e9') {
    const index = full.glyphIndex(char.codePointAt(0));
    assert.deepEqual(lean.glyph(index), full.glyph(index), char);
  }
});

test('raw tables are readable by tag for shapers (GPOS, GSUB, kern)', () => {
  const source = parseTTFSource(read('SourceSans3-Regular.ttf'));
  const gpos = source.table('GPOS');
  assert.ok(gpos instanceof Uint8Array && gpos.length > 0);
  assert.equal(new DataView(gpos.buffer, gpos.byteOffset).getUint16(0), 1, 'GPOS major version');
  assert.equal(source.table('zzzz'), undefined);
});

// Minimal TrueType fonts: glyph 0 is a unit square, glyph 1 (mapped from 'A') is the composite under test.
const be16 = (v) => [(v >> 8) & 255, v & 255];
const be32 = (v) => [...be16(v >>> 16), ...be16(v)];
function sfnt(tables) {
  const tags = Object.keys(tables).sort(),
    out = [...be32(0x10000), ...be16(tags.length), 0, 0, 0, 0, 0, 0];
  let offset = 12 + 16 * tags.length;
  const body = [];
  for (const tag of tags) {
    const data = tables[tag];
    out.push(...[...tag].map((c) => c.charCodeAt(0)), ...be32(0), ...be32(offset), ...be32(data.length));
    body.push(...data);
    while (body.length % 4) body.push(0);
    offset = 12 + 16 * tags.length + body.length;
  }
  return Uint8Array.from([...out, ...body]);
}
function font(glyphs, cmapTable) {
  const glyf = [],
    loca = [];
  for (const g of glyphs) {
    loca.push(...be32(glyf.length));
    glyf.push(...g);
    while (glyf.length % 4) glyf.push(0);
  }
  loca.push(...be32(glyf.length));
  const head = Array(54).fill(0);
  head.splice(12, 4, ...be32(0x5f0f3cf5));
  head.splice(18, 2, ...be16(1000));
  head.splice(50, 2, ...be16(1));
  const hhea = Array(36).fill(0);
  hhea.splice(4, 2, ...be16(800));
  hhea.splice(34, 2, ...be16(glyphs.length));
  const cmap = cmapTable ?? [
    ...be16(0),
    ...be16(1),
    ...be16(3),
    ...be16(10),
    ...be32(12),
    ...be16(12),
    0,
    0,
    ...be32(28),
    ...be32(0),
    ...be32(1),
    ...be32(65),
    ...be32(65),
    ...be32(1),
  ];
  return sfnt({
    head,
    hhea,
    cmap,
    glyf,
    loca,
    maxp: [...be32(0x5000), ...be16(glyphs.length)],
    hmtx: glyphs.flatMap(() => [...be16(500), 0, 0]),
  });
}
const square = [
  ...be16(1),
  ...Array(8).fill(0),
  ...be16(3),
  ...be16(0),
  1,
  1,
  1,
  1,
  ...[0, 100, 0, -100].flatMap(be16),
  ...[0, 0, 100, 0].flatMap(be16),
];
// A component: ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES plus `flags`, an offset and a 2x2 transform (F2DOT14).
const component = (glyph, flags, dx, dy, transform = []) => [
  ...be16(3 | flags),
  ...be16(glyph),
  ...be16(dx),
  ...be16(dy),
  ...transform.flatMap(be16),
];
const composite = (...parts) => [...be16(-1 & 0xffff), ...Array(8).fill(0), ...parts.flat()];

test('ROUND_XY_TO_GRID rounds a scaled component offset to whole font units', () => {
  // WE_HAVE_A_SCALE 0.5 (8192) with SCALED_COMPONENT_OFFSET: the offset 15 scales to 7.5, rounded to 8.
  const scaled = 0x8 | 0x800;
  const rounded = parseTTF(font([square, composite(component(0, scaled | 0x4, 15, 15, [8192]))])).glyph('A');
  assert.deepEqual(rounded.commands[0], ['M', 8, 8]);
  const exact = parseTTF(font([square, composite(component(0, scaled, 15, 15, [8192]))])).glyph('A');
  assert.deepEqual(exact.commands[0], ['M', 7.5, 7.5]);
});

test('a cmap format 4 glyph pointer past its subtable maps to no glyph, not to the next table bytes', () => {
  // Segments 'A'..'A' with idRangeOffset 4 (pointing just past the 32-byte subtable, at the 'glyf' table, whose first
  // u16 is the square's contour count 1) and the 0xFFFF end segment.
  const format4 = [
    ...be16(4),
    ...be16(32),
    ...be16(0),
    ...be16(4),
    0,
    0,
    0,
    0,
    0,
    0,
    ...be16(65),
    ...be16(0xffff),
    0,
    0,
    ...be16(65),
    ...be16(0xffff),
    ...be16(0),
    ...be16(1),
    ...be16(4),
    ...be16(0),
  ];
  const bytes = font([square, square], [...be16(0), ...be16(1), ...be16(3), ...be16(1), ...be32(12), ...format4]);
  assert.equal(parseTTF(bytes).glyphIndex('A'), undefined);
});

test('composite components are budgeted over the whole tree, so nested fan-out cannot run away', () => {
  // Glyph k (k >= 1) places glyph k - 1 twice: glyph 14 visits 2^14 components.
  const glyphs = [square];
  for (let k = 1; k <= 14; k++) glyphs.push(composite(component(k - 1, 0x20, 0, 0), component(k - 1, 0, 0, 0)));
  const source = parseTTFSource(font(glyphs));
  assert.equal(source.glyph(3).commands.filter((c) => c[0] === 'M').length, 8);
  assert.throws(
    () => source.glyph(14),
    (e) => e instanceof LoaderError && e.code === 'limit' && /4096 composite components/.test(e.message),
  );
});
