// CID-keyed CFF outlines (Adobe Technical Notes #5176 and #5177) assembled here, and GPOS pair kerning (OpenType
// GPOS and "Common Table Formats") on hand-assembled tables and on Source Sans 3 against a browser's shaper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LoaderError } from '../dist/index.js';
import { parseOpenType, parseOpenTypeSource } from '../dist/font-opentype.js';

const u16 = (v) => [(v >> 8) & 255, v & 255];
const u32 = (v) => [...u16(Math.floor(v / 65536)), ...u16(v & 0xffff)];
const chars = (s) => [...s].map((c) => c.charCodeAt(0));

function sfnt(tables) {
  const tags = Object.keys(tables).sort(),
    head = [...chars('OTTO'), ...u16(tags.length), 0, 0, 0, 0, 0, 0],
    body = [];
  let offset = 12 + tags.length * 16;
  for (const tag of tags) {
    const data = [...tables[tag]];
    head.push(...chars(tag), ...u32(0), ...u32(offset), ...u32(data.length));
    while (data.length % 4) data.push(0);
    body.push(...data);
    offset += data.length;
  }
  return Uint8Array.from([...head, ...body]);
}

/** A CFF INDEX with two-byte offsets. */
const index = (items) => {
  if (!items.length) return [0, 0];
  let at = 1;
  const offsets = [u16(at)];
  for (const item of items) offsets.push(u16((at += item.length)));
  return [...u16(items.length), 2, ...offsets.flat(), ...items.flat()];
};
/** A DICT integer in the fixed five-byte form, so offsets do not move the layout. */
const int = (v) => [29, ...u32(v >>> 0)];
const num = (v) => [28, ...u16(v & 0xffff)];
/** A real number operand ("0.5" or "2"), nibble coded. */
const real = (text) => {
  const nibbles = [...text].map((c) => (c === '.' ? 10 : Number(c)));
  nibbles.push(15);
  if (nibbles.length % 2) nibbles.push(15);
  return [30, ...nibbles.flatMap((n, i) => (i % 2 ? [] : [(n << 4) | nibbles[i + 1]]))];
};

/**
 * A CID-keyed font of three glyphs: .notdef, and two glyphs that both call local subroutine 0, each of its own Font
 * DICT (a square of side 100, then of side 300). Font DICT 1 doubles x through its FontMatrix.
 */
function cidFont({ select = 3, topMatrix = false, ros = true } = {}) {
  const move = [...num(0), ...num(0), 21],
    square = (s) => [...num(s), ...num(0), ...num(0), ...num(s), ...num(-s), ...num(0), 5, 11],
    glyph = [...move, ...num(-107), 10, 14],
    charStrings = index([[14], glyph, glyph]),
    matrix = (sx, sy) => [...real(sx), ...num(0), ...num(0), ...real(sy), ...num(0), ...num(0), 12, 7];
  const header = [1, 0, 4, 2],
    names = index([chars('CID')]),
    strings = index([chars('Adobe'), chars('Identity')]),
    globals = index([]);
  const top = (at) => [
    ...(ros ? [...num(391), ...num(392), ...num(0), 12, 30] : []),
    ...(topMatrix ? matrix('1', '1') : []),
    ...int(at.charset),
    15,
    ...int(at.charStrings),
    17,
    ...int(at.fdArray),
    12,
    36,
    ...int(at.fdSelect),
    12,
    37,
  ];
  const charset = [2, ...u16(1), ...u16(1)],
    fdSelect = select === 0 ? [0, 0, 0, 1] : [3, ...u16(2), ...u16(0), 0, ...u16(2), 1, ...u16(3)];
  // Each Private DICT holds only its Subrs offset (6 bytes), with the subroutine INDEX right after it.
  const privates = [100, 300].map((side) => [...int(6), 19, ...index([square(side)])]);
  const zero = { charset: 0, charStrings: 0, fdArray: 0, fdSelect: 0 };
  const prefix = (dict) => [...header, ...names, ...index([dict]), ...strings, ...globals];
  const at = { charset: prefix(top(zero)).length };
  at.fdSelect = at.charset + charset.length;
  at.charStrings = at.fdSelect + fdSelect.length;
  at.fdArray = at.charStrings + charStrings.length;
  // The matrices are the font's units, 1/1000 per unit, doubled in x for the second Font DICT.
  const dicts = (offsets) =>
    offsets.map((offset, i) => [...matrix(i ? '0.002' : '0.001', '0.001'), ...int(6), ...int(offset), 18]);
  let offset = at.fdArray + index(dicts([0, 0])).length;
  const offsets = privates.map((p) => {
    const here = offset;
    offset += p.length;
    return here;
  });
  const cff = [
    ...prefix(top(at)),
    ...charset,
    ...fdSelect,
    ...charStrings,
    ...index(dicts(offsets)),
    ...privates.flat(),
  ];
  const head = new Uint8Array(54);
  head.set(u32(0x5f0f3cf5), 12);
  head.set(u16(1000), 18);
  const hhea = new Uint8Array(36);
  hhea.set(u16(1), 34);
  const cmap = [
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
    ...u32(66),
    ...u32(1),
  ];
  return { head, hhea, maxp: [...u32(0x5000), ...u16(3)], hmtx: [...u16(500), 0, 0, 0, 0, 0, 0], cmap, 'CFF ': cff };
}

const square = (sx, sy) => [['M', 0, 0], ['L', sx, 0], ['L', sx, sy], ['L', 0, sy], ['Z']];

for (const select of [0, 3])
  test(`CID-keyed CFF: FDSelect format ${select} picks each glyph's subroutines and FontMatrix`, () => {
    const font = parseOpenType(sfnt(cidFont({ select })));
    assert.deepEqual(font.glyph('A').commands, square(100, 100));
    assert.deepEqual(font.glyph('B').commands, square(600, 300));
  });

test('CID-keyed CFF: a Top DICT matrix concatenates with the Font DICT one', () => {
  // Top identity times Font DICT 0.001 gives the same units.
  assert.deepEqual(parseOpenType(sfnt(cidFont({ topMatrix: true }))).glyph('B').commands, square(600, 300));
});

test('damaged CID-keyed CFF fonts throw coded errors', () => {
  assert.throws(() => parseOpenType(sfnt(cidFont({ ros: false }))), LoaderError);
  const tables = cidFont();
  for (let length = 0; length < tables['CFF '].length; length++)
    assert.throws(
      () => {
        const font = parseOpenTypeSource(sfnt({ ...tables, 'CFF ': tables['CFF '].slice(0, length) }));
        font.glyph(1);
        font.glyph(2);
      },
      LoaderError,
      `CFF cut at ${length}`,
    );
});

// GPOS: one script, one `kern` feature, the given lookups.
function gpos(lookups, { script = 'latn', feature = 'kern' } = {}) {
  const scripts = [
      ...u16(1),
      ...chars(script),
      ...u16(8),
      ...u16(4),
      ...u16(0),
      ...u16(0),
      ...u16(0xffff),
      ...u16(1),
      ...u16(0),
    ],
    features = [
      ...u16(1),
      ...chars(feature),
      ...u16(8),
      ...u16(0),
      ...u16(lookups.length),
      ...lookups.flatMap((_, i) => u16(i)),
    ];
  let offset = 2 + lookups.length * 2;
  const offsets = [],
    bodies = [];
  for (const [type, subtables] of lookups) {
    offsets.push(...u16(offset));
    let at = 6 + subtables.length * 2;
    const list = [];
    for (const s of subtables) {
      list.push(...u16(at));
      at += s.length;
    }
    const body = [...u16(type), 0, 0, ...u16(subtables.length), ...list, ...subtables.flat()];
    bodies.push(...body);
    offset += body.length;
  }
  return [
    ...u16(1),
    0,
    0,
    ...u16(10),
    ...u16(10 + scripts.length),
    ...u16(10 + scripts.length + features.length),
    ...scripts,
    ...features,
    ...u16(lookups.length),
    ...offsets,
    ...bodies,
  ];
}
const coverage = (...glyphs) => [...u16(1), ...u16(glyphs.length), ...glyphs.flatMap(u16)];
// Format 1: pair (1, 2), XPlacement then XAdvance in the first record.
const format1 = (advance) => {
  const set = [...u16(1), ...u16(2), ...u16(7), ...u16(advance & 0xffff)];
  return [...u16(1), ...u16(12), ...u16(5), ...u16(0), ...u16(1), ...u16(18), ...coverage(1), ...set];
};
// Format 2: class 1 of glyph 2 against class 1 of glyph 1.
const format2 = (advance) => {
  const classes = (glyph) => [...u16(2), ...u16(1), ...u16(glyph), ...u16(glyph), ...u16(1)],
    records = [...u16(0), ...u16(0), ...u16(0), ...u16(advance & 0xffff)],
    at = 16 + records.length;
  return [
    ...u16(2),
    ...u16(at),
    ...u16(4),
    ...u16(0),
    ...u16(at + 6),
    ...u16(at + 16),
    ...u16(2),
    ...u16(2),
    ...records,
    ...coverage(2),
    ...classes(2),
    ...classes(1),
  ];
};
const kern = (pairs) => [
  0,
  0,
  ...u16(1),
  0,
  0,
  ...u16(14 + pairs.length * 6),
  ...u16(1),
  ...u16(pairs.length),
  0,
  0,
  0,
  0,
  0,
  0,
  ...pairs.flatMap(([l, r, v]) => [...u16(l), ...u16(r), ...u16(v & 0xffff)]),
];
const withTables = (extra) => parseOpenTypeSource(sfnt({ ...cidFont(), ...extra }));

test('GPOS kern: pair formats 1 and 2, extension lookups, lookup sums and the kern table fallback', () => {
  const legacy = kern([
    [1, 2, -9],
    [2, 1, -8],
  ]);
  const font = withTables({
    GPOS: gpos([
      [2, [format1(-50)]],
      [9, [[...u16(1), ...u16(2), ...u32(8), ...format2(-30)]]],
    ]),
    kern: legacy,
  });
  assert.equal(font.kerning(1, 2), -50);
  assert.equal(font.kerning(2, 1), -30);
  assert.equal(font.kerning(1, 1), 0);
  assert.equal(font.kerning(1, 2, 'grek'), -50, 'a script the table lacks falls back to latn');
  // A GPOS table without a kern feature leaves kerning to the kern table.
  assert.equal(withTables({ GPOS: gpos([[2, [format1(-50)]]], { feature: 'mark' }), kern: legacy }).kerning(1, 2), -9);
  assert.equal(withTables({ kern: legacy }).kerning(2, 1), -8);
  assert.equal(withTables({}).kerning(1, 2), 0);
  // Layout applies it between characters.
  const outline = parseOpenType(sfnt({ ...cidFont(), GPOS: gpos([[2, [format1(-50)]]]) }));
  assert.equal(outline.kerning('A', 'B'), -50);
  const [plain, kerned] = [false, true].map(
    (on) => outline.generateShapes('AB', 1000, { kerning: on })[1].getPoints(1)[0][0],
  );
  assert.equal(kerned - plain, -50);
});

test('damaged GPOS tables throw coded errors at the first pair asked for', () => {
  const table = gpos([[2, [format1(-50)]]]);
  for (let length = 0; length < table.length; length++) {
    const font = withTables({ GPOS: table.slice(0, length) });
    assert.throws(() => font.kerning(1, 2), LoaderError, `GPOS cut at ${length}`);
  }
  // One lookup offset repeated past the subtable budget is refused instead of held.
  const many = gpos([[2, new Array(1).fill(format1(-50))]]);
  const at = many.length - format1(-50).length - 4;
  many.splice(at, 2, ...u16(20000));
  assert.throws(
    () => withTables({ GPOS: many }).kerning(1, 2),
    (e) => e instanceof LoaderError && e.code === 'limit',
  );
});

test('Source Sans 3 GPOS kerning equals the browser shaper (TrueType and CFF), and varies with the instance', () => {
  const dir = new URL('../../text/tests/fixtures/fonts/', import.meta.url),
    read = (name) => readFileSync(new URL(name, dir)),
    reference = JSON.parse(read('kerning-reference.json'));
  for (const [name, pairs] of Object.entries(reference.fonts)) {
    const font = parseOpenType(read(name));
    for (const [pair, value] of Object.entries(pairs))
      assert.equal(font.kerning(pair[0], pair[1]), value, `${name} ${pair}`);
  }
  const bytes = read('SourceSans3VF-Upright.ttf'),
    light = parseOpenType(bytes),
    bold = parseOpenType(bytes, { variations: { wght: 900 } });
  assert.notEqual(bold.kerning('T', 'o'), light.kerning('T', 'o'));
});
