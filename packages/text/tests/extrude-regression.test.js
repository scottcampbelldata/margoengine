import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { closed, volume } from './extrude-assertions.js';
import { parseFontOutlines, extrudeText, triangulatePolygon, classifyLoops, polygonArea } from '../dist/extrude.js';
import { tables, sfnt, ttf, otf, simple, composite, component, program, u16, u32 } from './extrude-fixtures.js';

const square = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
const fontLike = (loops) => ({
  unitsPerEm: 1,
  glyphIndex: () => 1,
  glyphAdvance: () => 1,
  getGlyphContours: () => loops,
});
const coded = (error) => error.code === 'failed' && error.message.includes('Help: https://margoengine.com/docs/text');
const quad = simple(square.map(([x, y]) => [x * 1000, y * 1000, true]));

test('F1 hostile and invalid cmap ranges fail with bounded coded errors', () => {
  for (const [start, end, glyph] of [
    [0, 0xffffffff, 0],
    [20, 19, 1],
    [0, 100, 1],
  ]) {
    const entries = tables(ttf([[], quad]));
    entries.get('cmap').set([...u32(start), ...u32(end), ...u32(glyph)], 28);
    assert.throws(() => parseFontOutlines(sfnt(entries)), coded);
  }
});
test('F2 TrueType composite cycles and depth are bounded', () => {
  assert.throws(() => parseFontOutlines(ttf([[], composite(component(1))])).getGlyphContours(1), coded);
  const glyphs = Array.from({ length: 40 }, (_, i) => composite(component(i + 1)));
  glyphs.push(quad);
  assert.throws(() => parseFontOutlines(ttf(glyphs)).getGlyphContours(0), coded);
});
test('F2 CFF recursive subroutines reject with a coded depth error', () => {
  const font = parseFontOutlines(otf([program(-107, [10], [14])], [program(-107, [10], [11])]));
  assert.throws(() => font.getGlyphContours(0), coded);
});
test('F3 Type 2 alternating curves, masks and shared subroutine stack', () => {
  const direct = program(0, 0, [21], 100, 100, 100, 100, [31], [14]);
  const subr = program([31], [11]);
  const shared = program(0, 0, [21], 100, 100, 100, 100, -107, [10], [14]);
  const masked = program(0, 20, [1], [19, 255], 0, 0, [21], 100, 100, 100, 100, [31], [14]);
  const expected = parseFontOutlines(otf([direct])).getGlyphContours(0, 4);
  assert.equal(expected.length, 1);
  assert.equal(expected[0].length, 5);
  assert.deepEqual(expected[0].at(-1), [0.2, 0.2]);
  assert.deepEqual(parseFontOutlines(otf([shared], [subr])).getGlyphContours(0, 4), expected);
  assert.deepEqual(parseFontOutlines(otf([masked])).getGlyphContours(0, 4), expected);
});
test('F4 consecutive off-curve quadratic controls start at their implied midpoint', () => {
  const font = parseFontOutlines(
    ttf([
      simple([
        [0, 0, true],
        [100, 200, false],
        [300, 200, false],
        [400, 0, true],
      ]),
    ]),
  );
  const loop = font.getGlyphContours(0, 2)[0];
  assert.ok(loop.some(([x, y]) => Math.abs(x - 0.3) < 1e-15 && Math.abs(y - 0.15) < 1e-15));
});
test('F5 holes have complete cap area and only the prescribed boundary edges', () => {
  const outer = [
    [5, 0],
    [4, 4],
    [0, 5],
    [-3, 3],
    [-4, 0],
    [-2, -2],
    [0, -6],
    [4, -4],
  ];
  const hole = [
    [0.1, -0.4],
    [0.1, 0.4],
    [0.8, 0.4],
    [0.8, -0.4],
  ];
  const { vertices, indices } = triangulatePolygon(outer, [hole]);
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) area += polygonArea(indices.slice(i, i + 3).map((j) => vertices[j]));
  assert.ok(Math.abs(area - 64.94) < 1e-12, `${area}`);
  assert.equal(indices.length, 36);
  closed(extrudeText('a', { font: fontLike([outer, hole]) }));
});
test('F6 caps face outward: unit square volume equals area times depth', () => {
  const mesh = extrudeText('a', { font: fontLike([square]), depth: 0.2 });
  assert.ok(Math.abs(volume(mesh) - 0.2) < 1e-8);
  closed(mesh);
  assert.equal(mesh.normals[2], -1);
});
test('F7 bevels close both terminal rims and have finite unit normals', () => {
  for (const bevelSegments of [0, 1, 3]) {
    const mesh = extrudeText('a', { font: fontLike([square]), bevelEnabled: true, bevelSegments });
    closed(mesh);
    assert.ok(volume(mesh) > 0);
    for (let i = 0; i < mesh.normals.length; i += 3)
      assert.ok(Math.abs(Math.hypot(...mesh.normals.slice(i, i + 3)) - 1) < 1e-6);
  }
});
test('F8 composite point matching uses raw point indices and scaled offsets', () => {
  const curved = simple([
    [0, 0, true],
    [100, 200, false],
    [300, 200, false],
    [400, 0, true],
  ]);
  const child = simple([
    [100, 0, true],
    [100, 100, true],
    [200, 0, true],
  ]);
  const font = parseFontOutlines(ttf([composite(component(1, 0x23), component(2, 1, 2, 0)), curved, child]));
  assert.deepEqual(font.getGlyphContours(0)[1][0], [0.3, 0.2]);
  const scaled = parseFontOutlines(ttf([composite(component(1, 0x80b, 200, 100, [8192])), child]));
  assert.deepEqual(scaled.getGlyphContours(0)[0][0], [0.15, 0.05]);
});
test('F9 subdivisions reject nonfinite, fractional and excessive values with codes', () => {
  for (const name of ['steps', 'bevelSegments', 'curveSegments']) {
    for (const value of [Infinity, NaN, -1, 1.5, 1000000]) {
      assert.throws(() => extrudeText('', { font: fontLike([square]), [name]: value }), coded);
    }
  }
  assert.throws(() => parseFontOutlines(ttf([quad])).getGlyphContours(0, Infinity), coded);
});
test('F9 valid subdivision counts also bound total outline and mesh allocation', () => {
  const points = Array.from({ length: 100 }, (_, i) => [
    Math.round(1000 * Math.cos((i * Math.PI) / 50)),
    Math.round(1000 * Math.sin((i * Math.PI) / 50)),
    false,
  ]);
  assert.throws(() => parseFontOutlines(ttf([simple(points)])).getGlyphContours(0, 256), coded);
  const curves = Array.from({ length: 70 }, () => program(1, 2, 3, 4, 5, 6, [8])).flat();
  assert.throws(() => parseFontOutlines(otf([program(0, 0, [21], curves, [14])])).getGlyphContours(0, 256), coded);
  const circle = Array.from({ length: 1000 }, (_, i) => [Math.cos((i * Math.PI) / 500), Math.sin((i * Math.PI) / 500)]);
  assert.throws(() => extrudeText('a', { font: fontLike([circle]), steps: 256 }), coded);
});
test('F10 nonzero fill unions overlapping and same-winding nested contours', () => {
  const shifted = square.map(([x, y]) => [x + 0.5, y + 0.5]);
  for (const loops of [
    [square, shifted],
    [square, square.map(([x, y]) => [x * 0.5 + 0.25, y * 0.5 + 0.25])],
  ]) {
    const shapes = classifyLoops(loops);
    const area = shapes.reduce(
      (sum, s) => sum + polygonArea(s.outer) + s.holes.reduce((a, h) => a + polygonArea(h), 0),
      0,
    );
    assert.equal(area, loops[1] === shifted ? 1.75 : 1);
    const mesh = extrudeText('a', { font: fontLike(loops) });
    closed(mesh);
    assert.ok(Math.abs(volume(mesh) / 0.2 - area) < 1e-6);
  }
});
test('F11 legal small text retains its caps and closed walls', () => {
  const mesh = extrudeText('a', { font: fontLike([square]), size: 0.0001 });
  assert.ok(mesh.indices.length > 0);
  closed(mesh);
  assert.ok(Math.abs(volume(mesh) / 2e-9 - 1) < 1e-6);
});
test('F11 unbeveled acute contours do not require an offset miter', () => {
  const mesh = extrudeText('a', {
    font: fontLike([
      [
        [0, 0],
        [1, 0],
        [0, 0.00000001],
      ],
    ]),
  });
  closed(mesh);
  assert.ok(volume(mesh) > 0);
});
test('F12 every truncated sfnt/table/glyph/CFF span throws a coded error', () => {
  const bytes = ttf([quad]);
  for (let length = 0; length < bytes.length; length++) {
    assert.throws(() => parseFontOutlines(bytes.subarray(0, length)).getGlyphContours(0), coded);
  }
  const entries = tables(bytes);
  entries.set('glyf', entries.get('glyf').slice(0, 12));
  assert.throws(() => parseFontOutlines(sfnt(entries)).getGlyphContours(0), coded);
  const cffEntries = tables(otf([program(0, 0, [21], [14])]));
  cffEntries.get('CFF ').set(u32(0xffffffff), 7);
  assert.throws(() => parseFontOutlines(sfnt(cffEntries, true)), coded);
});
test('F13 bevelOffset changes the cap outline and keeps the solid closed', () => {
  const opts = { font: fontLike([square]), bevelEnabled: true };
  const a = extrudeText('a', opts),
    b = extrudeText('a', { ...opts, bevelOffset: 0.1 });
  assert.notDeepEqual(a.positions, b.positions);
  closed(b);
  assert.ok(b.boundingBox.max[0] > a.boundingBox.max[0]);
});

test('F3 every Type 2 curve family agrees with explicit relative cubic curves', () => {
  const outline = (tokens) => parseFontOutlines(otf([program(0, 0, [21], ...tokens, [14])])).getGlyphContours(0, 4);
  const check = (tokens, explicit) => assert.deepEqual(outline(tokens), outline(explicit));
  check([10, 20, 30, 40, [31]], [10, 0, 20, 30, 0, 40, [8]]);
  check([10, 20, 30, 40, 50, [31]], [10, 0, 20, 30, 50, 40, [8]]);
  check([10, 20, 30, 40, 50, 60, 70, 80, 90, [31]], [10, 0, 20, 30, 0, 40, 0, 50, 60, 70, 80, 90, [8]]);
  check([10, 20, 30, 40, [30]], [0, 10, 20, 30, 40, 0, [8]]);
  check([10, 20, 30, 40, 50, [30]], [0, 10, 20, 30, 40, 50, [8]]);
  check([10, 20, 30, 40, [27]], [10, 0, 20, 30, 40, 0, [8]]);
  check([5, 10, 20, 30, 40, [27]], [10, 5, 20, 30, 40, 0, [8]]);
  check([10, 20, 30, 40, [26]], [0, 10, 20, 30, 0, 40, [8]]);
  check([5, 10, 20, 30, 40, [26]], [5, 10, 20, 30, 0, 40, [8]]);
  check([10, 20, 30, 40, 50, 60, 70, 80, [24]], [10, 20, 30, 40, 50, 60, [8], 70, 80, [5]]);
  check([10, 20, 30, 40, 50, 60, 70, 80, [25]], [10, 20, [5], 30, 40, 50, 60, 70, 80, [8]]);
  check([10, 20, 30, 40, 50, 60, 70, [12, 34]], [10, 0, 20, 30, 40, 0, 50, 0, 60, -30, 70, 0, [8]]);
  check([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 50, [12, 35]], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, [8]]);
  check([1, 2, 3, 4, 5, 6, 7, 8, 9, [12, 36]], [1, 2, 3, 4, 5, 0, 6, 0, 7, 8, 9, -14, [8]]);
  check([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, [12, 37]], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -25, 11, [8]]);
});
test('F3 Type 2 fixed numbers, arithmetic, transient storage, width and multi-byte hint masks', () => {
  const p = program(
    500,
    0,
    20,
    [1],
    ...Array(8).fill([0, 20]).flat(),
    [3],
    [19, 255, 28],
    0,
    0,
    [21],
    40,
    60,
    [12, 10],
    20,
    [12, 24],
    2,
    [12, 12],
    0,
    [5],
    0,
    100,
    [5],
    -1000,
    0,
    [5],
    [14],
  );
  const font = parseFontOutlines(otf([p]));
  assert.deepEqual(font.getGlyphContours(0), [
    [
      [0, 0],
      [1, 0],
      [1, 0.1],
      [0, 0.1],
    ],
  ]);
  const subr = program(100, [11]),
    caller = program(0, 0, [21], 100, -107, [29], [5], 0, 100, [5], -100, -200, [5], [14]);
  assert.deepEqual(parseFontOutlines(otf([caller], [], [subr])).getGlyphContours(0)[0][1], [0.1, 0.1]);
  const fixed = program(0, 0, [21], [255, ...u32(0x18000)], 100, [5], 0, 100, [5], [14]);
  assert.deepEqual(parseFontOutlines(otf([fixed])).getGlyphContours(0)[0][1], [0.0015, 0.1]);
});
test('F5 multiple hole bridges preserve their local interior cone', () => {
  const outer = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];
  const a = [
      [2, 0.5],
      [1, 0.5],
      [1, 1.5],
      [2, 1.5],
    ],
    b = [
      [2, 2],
      [1, 2],
      [1, 3],
      [2, 3],
    ];
  const mesh = extrudeText('a', { font: fontLike([outer, a, b]) });
  closed(mesh);
  assert.ok(Math.abs(volume(mesh) - 14 * 0.2) < 1e-6);
});
test('F7 impossible bevels reject instead of returning intersecting meshes', () => {
  const hole = square.map(([x, y]) => [0.4 + x * 0.2, 0.4 + y * 0.2]).reverse();
  assert.throws(() => extrudeText('a', { font: fontLike([square, hole]), bevelEnabled: true, bevelSize: 0.2 }), coded);
  assert.throws(() => extrudeText('a', { font: fontLike([square]), bevelEnabled: true, bevelThickness: 0.2 }), coded);
});
test('F10 opposite overlaps, nested islands and duplicate contours use nonzero winding', () => {
  const nested = square.map(([x, y]) => [0.25 + x * 0.5, 0.25 + y * 0.5]),
    island = square.map(([x, y]) => [0.4 + x * 0.2, 0.4 + y * 0.2]);
  for (const [loops, area] of [
    [[square, square], 1],
    [[square, [...square].reverse()], 0],
    [[square, nested.reverse(), island], 0.79],
  ]) {
    const mesh = extrudeText('a', { font: fontLike(loops) });
    closed(mesh);
    assert.ok(Math.abs(volume(mesh) - area * 0.2) < 1e-7);
  }
});
test('F12 malformed table offsets, format 4 pointers, glyph spans and CFF tokens stay coded', () => {
  const bytes = ttf([quad]);
  for (let i = 0; i < new DataView(bytes.buffer).getUint16(4); i++) {
    for (const field of [8, 12]) {
      const copy = bytes.slice();
      copy.set(u32(0xffffffff), 12 + i * 16 + field);
      assert.throws(() => parseFontOutlines(copy), coded);
    }
  }
  const entries = tables(bytes);
  entries.set('cmap', [
    ...u16(0),
    ...u16(1),
    ...u16(3),
    ...u16(1),
    ...u32(12),
    ...u16(4),
    ...u16(32),
    ...u16(0),
    ...u16(4),
    ...Array(6).fill(0),
    ...u16(65),
    ...u16(65535),
    ...u16(0),
    ...u16(65),
    ...u16(65535),
    ...u16(0),
    ...u16(1),
    ...u16(65534),
    ...u16(0),
  ]);
  assert.throws(() => parseFontOutlines(sfnt(entries)), coded);
  const brokenPrograms = [[28], [255, 0, 0], [139, 139, 21, 139, 5, 14], [139, 139, 21, 19, 255], [139, 139, 21, 12]];
  for (const p of brokenPrograms) assert.throws(() => parseFontOutlines(otf([p])).getGlyphContours(0), coded);
});
test('F3 Type 2 arithmetic, boolean, storage and stack operators preserve operands', () => {
  const cases = [
    [[-2, [12, 9]], 2],
    [[2, [12, 14]], -2],
    [[9, [12, 26]], 3],
    [[0, [12, 5]], 1],
    [[2, 3, [12, 10]], 5],
    [[2, 3, [12, 11]], -1],
    [[6, 3, [12, 12]], 2],
    [[2, 3, [12, 24]], 6],
    [[2, 2, [12, 15]], 1],
    [[2, 0, [12, 3]], 0],
    [[2, 0, [12, 4]], 1],
    [[3, [12, 18], 4], 4],
    [[3, [12, 27], [12, 10]], 6],
    [[3, 5, [12, 28], [12, 11]], 2],
    [[3, 5, 0, [12, 29], [12, 10], [12, 10]], 13],
    [[1, 2, 3, 3, 1, [12, 30], [12, 11], [12, 10]], 2],
    [[12, 20, 1, 2, [12, 22]], 12],
    [[42, 0, [12, 20], 0, [12, 21]], 42],
  ];
  for (const [expression, value] of cases) {
    const bytes = otf(
      [program(0, 0, [21], ...expression, 1, [5], 0, 1, [5], [14])],
      [],
      [],
      program(1, 0, 0, 1, 0, 0, [12, 7]),
    );
    assert.deepEqual(parseFontOutlines(bytes).getGlyphContours(0)[0][1], [value, 1]);
  }
  const random = otf([program(0, 0, [21], [12, 23], 1, [5], 0, 1, [5], [14])]);
  const point = parseFontOutlines(random).getGlyphContours(0)[0][1];
  assert.ok(point[0] > 0 && point[0] <= 0.001);
  assert.deepEqual(parseFontOutlines(random).getGlyphContours(0)[0][1], point);
});
test('F3 Type 2 deprecated endchar composites resolve StandardEncoding through charset', () => {
  const strings = Array.from({ length: 126 }, () => [14]);
  strings[0] = program(10, 20, 65, 194, [14]);
  strings[34] = program(0, 0, [21], 100, 0, 0, 100, -100, 0, [5], [14]);
  strings[125] = program(0, 0, [21], 20, 30, 20, -30, [5], [14]);
  const font = parseFontOutlines(otf(strings)),
    contours = font.getGlyphContours(0);
  assert.deepEqual(contours[0], font.getGlyphContours(34)[0]);
  assert.deepEqual(
    contours[1],
    font.getGlyphContours(125)[0].map(([x, y]) => [x + 0.01, y + 0.02]),
  );
  strings[34] = program(0, 0, 65, 194, [14]);
  assert.throws(() => parseFontOutlines(otf(strings)).getGlyphContours(0), coded);
});
test('F14 README procedural glyph example runs with em coordinates', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Extruded 3D text'));
  const example = /```ts\s+([\s\S]*?)```/.exec(section)[1];
  const run = new Function('extrudeText', example.replace(/^import .*;$/gm, '') + '\nreturn geometry;');
  const mesh = run(extrudeText);
  const width = mesh.boundingBox.max[0] - mesh.boundingBox.min[0];
  assert.ok(width > 0.9 && width < 1.5, `size 2 A should be about one world unit wide: ${width}`);
  closed(mesh);
});
test('F3 CFF Top DICT CharstringType and FontMatrix use their specified operator codes', () => {
  const p = program(0, 0, [21], 100, 0, 0, 100, [5], [14]);
  assert.ok(parseFontOutlines(otf([p], [], [], program(2, [12, 6]))).getGlyphContours(0).length);
  assert.throws(() => parseFontOutlines(otf([p], [], [], program(1, [12, 6]))), coded);
  const matrix = program(1, 0, 0, 1, 2, 3, [12, 7]);
  assert.deepEqual(parseFontOutlines(otf([p], [], [], matrix)).getGlyphContours(0)[0][1], [102, 3]);
});
