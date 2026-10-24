import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OutlineFont, textGeometry } from '../dist/font.js';
import { outlineShapes } from '../dist/outline.js';

// Reference results for outlineShapes / OutlineFont / textGeometry. The outlines and the font source below are
// hand-written; no font file is read.
const vectors = JSON.parse(readFileSync(new URL('./fixtures/outline-font-vectors.json', import.meta.url), 'utf8'));

/** Bounds and signed shoelace area of a path sampled with getPoints(12). */
function measure(path) {
  const points = path.getPoints(12);
  let twice = 0,
    minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i],
      [nx, ny] = points[(i + 1) % points.length];
    twice += x * ny - nx * y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { bounds: [minX, minY, maxX, maxY], area: twice / 2 };
}

function assertPath(actual, expected, label) {
  const { bounds, area } = measure(actual);
  bounds.forEach((v, i) => assert.ok(Math.abs(v - expected.bounds[i]) <= 1e-6, `${label} bounds ${bounds}`));
  const want = Math.abs(expected.signedArea12);
  assert.ok(Math.abs(Math.abs(area) - want) <= 1e-6 * Math.max(1, want), `${label} area ${area} != ${want}`);
}

function assertShapes(shapes, expected, label) {
  assert.equal(shapes.length, expected.length, `${label}: shape count`);
  expected.forEach((e, i) => {
    assertPath(shapes[i], e, `${label} shape ${i}`);
    assert.equal(shapes[i].holes.length, e.holes.length, `${label} shape ${i}: hole count`);
    e.holes.forEach((h, k) => assertPath(shapes[i].holes[k], h, `${label} shape ${i} hole ${k}`));
  });
}

const revive = (commands) => commands.map((c) => c.map((v) => (v === 'NaN' ? Number.NaN : v)));

test('outlineShapes: reference vectors for nesting, fill rules, curves, contour rules and degenerate input', () => {
  let previous;
  for (const v of vectors.outlineVectors) {
    if (v.commands) {
      previous = revive(v.commands);
      assertShapes(outlineShapes(previous, v.fillRule), v.shapes, `${v.name} ${v.fillRule}`);
    } else {
      // The mapped case reuses the previous command list's O through (x, y) -> (2x + 5, -y).
      const o = revive(vectors.outlineVectors.find((c) => c.name === 'O-opposite-winding').commands);
      assertShapes(
        outlineShapes(o, v.fillRule, (x, y) => [x * 2 + 5, -y]),
        v.shapes,
        v.name,
      );
    }
  }
});

test('outlineShapes: invariants (mirror images, curves kept, closing line, no throw on junk)', () => {
  const square = (x0, y0, x1, y1, ccw) =>
    ccw
      ? [['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']]
      : [['M', x0, y0], ['L', x0, y1], ['L', x1, y1], ['L', x1, y0], ['Z']];
  // A glyph and its mirror image give the same holes under both rules.
  for (const fillRule of ['nonzero', 'evenodd'])
    for (const ccw of [false, true]) {
      const shapes = outlineShapes([...square(0, 0, 10, 10, ccw), ...square(3, 3, 7, 7, !ccw)], fillRule);
      assert.equal(shapes.length, 1);
      assert.equal(shapes[0].holes.length, 1);
    }
  // A hole whose corner touches the outline is still a hole (majority vote, not one point).
  const touching = outlineShapes([
    ...square(0, 0, 10, 10, true),
    ['M', 0, 0],
    ['L', 3, 6],
    ['L', 6, 6],
    ['L', 6, 3],
    ['Z'],
  ]);
  assert.equal(touching.length, 1);
  assert.equal(touching[0].holes.length, 1);
  // Curves stay curves; a contour that ends away from its start gets a closing line.
  const [ring] = outlineShapes([
    ['M', 0, 0],
    ['Q', 5, 10, 10, 0],
    ['C', 10, -5, 0, -5, 1, 0],
  ]);
  assert.deepEqual(
    ring.curves.map((c) => (c.v3 ? 'cubic' : c.v0 ? 'quadratic' : 'line')),
    ['quadratic', 'cubic', 'line'],
  );
  for (const junk of [[['Z']], [['X', 1, 2]], [null], [['M', 0, 0], ['Z'], ['Z']], [['C', 1, 2, 3, 4, 5, 6]]])
    assert.deepEqual(outlineShapes(junk), []);
});

/** The font source of the vectors: 0 .notdef box with a hole, 1 I, 2 O, 3 Q (two same-direction cubic rings), 4 space. */
function rect(x0, y0, x1, y1, ccw) {
  return ccw
    ? [['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']]
    : [['M', x0, y0], ['L', x0, y1], ['L', x1, y1], ['L', x1, y0], ['Z']];
}
function circle(cx, cy, r) {
  const k = 0.5523 * r;
  return [
    ['M', cx + r, cy],
    ['C', cx + r, cy + k, cx + k, cy + r, cx, cy + r],
    ['C', cx - k, cy + r, cx - r, cy + k, cx - r, cy],
    ['C', cx - r, cy - k, cx - k, cy - r, cx, cy - r],
    ['C', cx + k, cy - r, cx + r, cy - k, cx + r, cy],
    ['Z'],
  ];
}
function source(options = {}) {
  const { fillRule, kerning = true, calls } = options,
    missingGlyph = 'missingGlyph' in options ? options.missingGlyph : 0;
  const glyphs = [
    { advance: 500, commands: [...rect(50, 0, 450, 700, true), ...rect(100, 50, 400, 650, false)] },
    { advance: 200, commands: rect(0, 0, 100, 700, true) },
    { advance: 600, commands: [...rect(0, 0, 600, 700, true), ...rect(200, 200, 400, 500, false)] },
    { advance: 700, commands: [...circle(350, 350, 300), ...circle(350, 350, 150)] },
    { advance: 250, commands: [] },
  ];
  const map = { I: 1, O: 2, Q: 3, ' ': 4 };
  return {
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    lineHeight: 1100,
    glyphCount: 5,
    familyName: 'Vector Test',
    styleName: 'Regular',
    glyphIndex: (cp) => map[String.fromCodePoint(cp)],
    glyph: (index) => {
      if (calls) calls.count++;
      return { index, ...glyphs[index] };
    },
    ...(kerning ? { kerning: (l, r) => (l === 1 && r === 2 ? -50 : 0) } : {}),
    ...(missingGlyph === undefined ? {} : { missingGlyph }),
    ...(fillRule ? { fillRule } : {}),
  };
}

test('OutlineFont: reference metrics, lookups, layouts and decode caching', () => {
  const f = vectors.fontVectors,
    font = new OutlineFont(source());
  for (const [key, value] of Object.entries(f.metrics)) assert.equal(font[key], value, key);
  const l = f.lookups;
  assert.equal(font.glyphIndex('I'), l.glyphIndexI);
  assert.equal(font.glyphIndex(0x4f), l.glyphIndexCodePointO);
  assert.equal(font.glyphIndex('Z') ?? null, l.glyphIndexMissing);
  assert.equal(font.glyph('O').advance, l.glyphOAdvance);
  assert.equal(font.glyph('Z') ?? null, l.glyphMissing);
  assert.equal(font.kerning('I', 'O'), l.kerningIO);
  assert.equal(font.kerning('O', 'I'), l.kerningOI);
  assert.equal(font.kerning('Z', 'O'), l.kerningMissing);
  assert.equal(font.glyphIndex('IO'), l.firstCodePointOfString);
  for (const layout of f.layouts) {
    const label = `${JSON.stringify(layout.text)} ${layout.size} ${JSON.stringify(layout.options)}`;
    if (layout.throws) {
      const text = layout.text === '42' ? 42 : layout.text;
      assert.throws(
        () => font.generateShapes(text, Number(layout.size), layout.options),
        globalThis[layout.throws],
        label,
      );
    } else assertShapes(font.generateShapes(layout.text, layout.size, layout.options), layout.shapes, label);
  }
  const run = (src, v) => assertShapes(new OutlineFont(src).generateShapes(v.text, v.size), v.shapes, v.text);
  run(source({ missingGlyph: undefined }), f.noMissingGlyph);
  run(source({ fillRule: 'evenodd' }), f.evenoddSource);
  run(source(), f.nonzeroQ);
  run(source({ kerning: false }), f.noKerningFunction);
  assertShapes(new OutlineFont(source()).generateShapes(f.defaultSize.text), f.defaultSize.shapes, 'default size');
  const calls = { count: 0 },
    counted = new OutlineFont(source({ calls }));
  counted.generateShapes('IIOO');
  counted.glyph('I');
  assert.equal(calls.count, f.glyphDecodeCalls);
  // Surrogate pairs are one character; a missing one draws .notdef once.
  assert.equal(new OutlineFont(source()).generateShapes('\u{1F600}', 1000).length, 1);
});

test('OutlineFont: reference errors', () => {
  const good = source();
  const cases = {
    'null source': () => new OutlineFont(null),
    'no glyph()': () => new OutlineFont({ ...good, glyph: undefined }),
    'unitsPerEm 0': () => new OutlineFont({ ...good, unitsPerEm: 0 }),
    'ascender NaN': () => new OutlineFont({ ...good, ascender: Number.NaN }),
    'glyphIndex({})': () => new OutlineFont(good).glyphIndex({}),
    'glyphIndex(-1)': () => new OutlineFont(good).glyphIndex(-1),
    'glyphIndex(0x110000)': () => new OutlineFont(good).glyphIndex(0x110000),
    'glyphIndex(1.5)': () => new OutlineFont(good).glyphIndex(1.5),
    'glyphIndex("")': () => new OutlineFont(good).glyphIndex(''),
    'textGeometry no font': () => textGeometry('I', {}),
  };
  for (const e of vectors.errors) assert.throws(cases[e.label], globalThis[e.throws], e.label);
  assert.throws(() => new OutlineFont(good).kerning('I', 2.5), TypeError);
  assert.throws(() => new OutlineFont(good).glyph(Symbol.iterator), TypeError);
});

test('textGeometry: reference bounds for the vector font', () => {
  const font = new OutlineFont(source()),
    cases = {
      IO_depth5: textGeometry('IO', { font, size: 100, depth: 5 }),
      I_defaults: textGeometry('I', { font }),
      I_bevel: textGeometry('I', { font, size: 100, depth: 5, bevelEnabled: true, bevelThickness: 1, bevelSize: 1 }),
    };
  for (const [name, data] of Object.entries(cases)) {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < data.positions.length; v += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], data.positions[v + k]);
        max[k] = Math.max(max[k], data.positions[v + k]);
      }
    [...min, ...max].forEach((v, i) =>
      assert.ok(Math.abs(v - vectors.textGeometry[name].bounds[i]) <= 1e-6, `${name} bounds ${[...min, ...max]}`),
    );
  }
});
