// GlyphFieldFont and its CPU field builder (no browser): fields against a brute-force reference, winding, overlapping
// contours, kerning against the browser's shaper, ligatures against HarfBuzz, the glyph cache and Node layout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Font, Text, layoutText } from '@margoengine/text';
import { GlyphFieldFont as GlyphFieldFontLean, outlineSdf, windingAt, flattenOutline } from '@margoengine/text/outline';
import { openType } from '@margoengine/loaders/font-opentype';
// These tests read CFF and variable fonts, so they pass the OpenType readers; tests/opentype-optin.test.js covers the
// lean TrueType path without them.
class GlyphFieldFont extends GlyphFieldFontLean {
  constructor(data, options = {}) {
    super(data, { openType, ...options });
  }
}

const dir = new URL('./fixtures/fonts/', import.meta.url);
const bytes = (name) => readFileSync(new URL(name, dir));
const shaping = JSON.parse(readFileSync(new URL('shaping-reference.json', dir), 'utf8'));
const kerning = JSON.parse(readFileSync(new URL('kerning-reference.json', dir), 'utf8'));
const params = (size) => ({ size, radius: size / 4, cutoff: 0.25, buffer: Math.ceil((size / 4) * 0.75) });

/** Point on a line, quadratic or cubic segment (em) at t. */
function at(s, t) {
  const u = 1 - t;
  if (s.length === 4) return [u * s[0] + t * s[2], u * s[1] + t * s[3]];
  if (s.length === 6)
    return [u * u * s[0] + 2 * u * t * s[2] + t * t * s[4], u * u * s[1] + 2 * u * t * s[3] + t * t * s[5]];
  const a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [a * s[0] + b * s[2] + c * s[4] + d * s[6], a * s[1] + b * s[3] + c * s[5] + d * s[7]];
}

/**
 * Brute-force reference field at sampled texels: 4,096 points per curve, the distance to the nearest point, the sign
 * from the nonzero winding of the dense polyline through those points (crossings counted per row).
 */
function reference(contours, field, p, texels) {
  const pts = [];
  for (const loop of contours) {
    const poly = [];
    for (const s of loop) for (let k = 0; k < 4096; k++) poly.push(at(s, k / 4096));
    pts.push(poly.map(([x, y]) => [x * p.size - field.left - 0.5, field.top - 0.5 - y * p.size]));
  }
  const rows = new Map();
  const windingRow = (j) => {
    if (rows.has(j)) return rows.get(j);
    const crossings = [];
    for (const poly of pts)
      for (let k = 0; k < poly.length; k++) {
        const [ax, ay] = poly[k],
          [bx, by] = poly[(k + 1) % poly.length];
        if (ay <= j ? by > j : by <= j) crossings.push([ax + ((j - ay) * (bx - ax)) / (by - ay), by > ay ? 1 : -1]);
      }
    rows.set(j, crossings);
    return crossings;
  };
  return texels.map(([i, j]) => {
    let w = 0;
    for (const [x, dir] of windingRow(j)) if (x < i) w += dir;
    let best = Infinity;
    for (const poly of pts)
      for (const [x, y] of poly) {
        const d = (x - i) * (x - i) + (y - j) * (y - j);
        if (d < best) best = d;
      }
    const d = w !== 0 ? -Math.sqrt(best) : Math.sqrt(best);
    return Math.min(255, Math.max(0, Math.round(255 - 255 * (d / p.radius + p.cutoff))));
  });
}

/** Seeded texel sample: every texel of rows j % 3 === 0 in columns i % 3 === 0, plus 400 pseudo-random ones. */
function sampleTexels(width, height) {
  const out = [];
  for (let j = 0; j < height; j += 3) for (let i = 0; i < width; i += 3) out.push([i, j]);
  let seed = 12345;
  for (let n = 0; n < 400; n++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out.push([seed % width, (seed >> 8) % height]);
  }
  return out;
}

const cases = [
  ['SourceSans3-Regular.ttf', {}, 'Ag&8@'],
  ['SourceSans3-Regular.otf', {}, 'Ag&8@'],
  ['SourceSans3VF-Upright.ttf', { wght: 650 }, 'Rg&'],
  ['NotoSansSC-subset.ttf', {}, null],
];

test('glyph fields are within one level of a 4,096-sample brute-force reference (TTF, CFF, variable, CJK at 32, 64, 128 px)', () => {
  let checked = 0;
  for (const [name, variations, chars] of cases) {
    const font = new GlyphFieldFont(bytes(name), { variations });
    const ids = chars
      ? [...chars].map((c) => font.outlines.glyphIndex(c))
      : Array.from({ length: font.outlines.glyphCount - 1 }, (_, i) => i + 1).slice(0, 3);
    for (const size of [32, 64, 128])
      for (const id of ids) {
        const contours = font.outlines.getGlyphSegments(id),
          p = params(size),
          field = outlineSdf(contours, p);
        if (!field) continue;
        if (field.overlapped) continue; // overlapping contours: next test
        const texels = sampleTexels(field.width, field.height),
          want = reference(contours, field, p, texels);
        let worst = 0;
        texels.forEach(([i, j], k) => {
          worst = Math.max(worst, Math.abs(field.data[j * field.width + i] - want[k]));
        });
        assert.ok(worst <= 1, `${name} glyph ${id} at ${size} px: worst ${worst} levels`);
        checked++;
      }
  }
  assert.ok(checked >= 30, `${checked} glyph fields checked`);
});

// Two unit squares overlapping by half, both counter-clockwise: one shape whose inside edges must leave no seam.
const square = (x, y, s) => [[x, y, x + s, y], [x + s, y, x + s, y + s], [x + s, y + s, x, y + s], [x, y + s, x, y]];

test('overlapping contours leave no seam: the field equals that of the union outline', () => {
  const p = params(64),
    overlapped = outlineSdf([square(0, 0, 0.5), square(0.25, 0.25, 0.5)], p),
    // The union of the two squares as one outline (an octagon-like L pair), drawn once.
    union = outlineSdf([[
      [0, 0, 0.5, 0], [0.5, 0, 0.5, 0.25], [0.5, 0.25, 0.75, 0.25], [0.75, 0.25, 0.75, 0.75],
      [0.75, 0.75, 0.25, 0.75], [0.25, 0.75, 0.25, 0.5], [0.25, 0.5, 0, 0.5], [0, 0.5, 0, 0],
    ]], p);
  assert.equal(overlapped.overlapped, true);
  assert.equal(union.overlapped, false);
  assert.deepEqual([overlapped.width, overlapped.height, overlapped.left, overlapped.top], [union.width, union.height, union.left, union.top]);
  let worst = 0;
  for (let k = 0; k < union.data.length; k++) worst = Math.max(worst, Math.abs(overlapped.data[k] - union.data[k]));
  assert.ok(worst <= 1, `worst ${worst} levels from the union`);
  // The same with a variable font: overlapped glyphs exist and still draw a solid inside.
  const vf = new GlyphFieldFont(bytes('SourceSans3VF-Upright.ttf'), { variations: { wght: 900 } });
  let seen = 0;
  for (const char of 'ABEHKMNRWXYkx') {
    const field = outlineSdf(vf.outlines.getGlyphSegments(vf.outlines.glyphIndex(char)), p);
    if (field.overlapped) seen++;
  }
  assert.ok(seen > 0, 'Source Sans 3 VF at weight 900 has overlapping contours');
});

test('winding: a counter-wound hole is outside, a same-wound inner square is filled, touching squares share no seam', () => {
  const p = params(64);
  const reversed = (loop) => loop.map(([a, b, c, d]) => [c, d, a, b]).reverse();
  const holed = outlineSdf([square(0, 0, 1), reversed(square(0.25, 0.25, 0.5))], p);
  const centre = (f) => f.data[Math.floor(f.height / 2) * f.width + Math.floor(f.width / 2)];
  assert.ok(centre(holed) < 191 - 100, `hole centre is outside (${centre(holed)})`);
  const nested = outlineSdf([square(0, 0, 1), square(0.25, 0.25, 0.5)], p);
  assert.equal(centre(nested), 255, 'same-wound inner square is filled (nonzero rule)');
  const touching = outlineSdf([square(0, 0, 0.5), square(0.5, 0, 0.5)], p),
    whole = outlineSdf([[[0, 0, 1, 0], [1, 0, 1, 0.5], [1, 0.5, 0, 0.5], [0, 0.5, 0, 0]]], p);
  let worst = 0;
  for (let k = 0; k < whole.data.length; k++) worst = Math.max(worst, Math.abs(touching.data[k] - whole.data[k]));
  assert.ok(worst <= 1, `touching squares match one rectangle within ${worst} levels`);
  assert.equal(windingAt(flattenOutline([square(0, 0, 1)], 1, 1 / 64), 0.5, 0.5), 1);
});

test('fields are deterministic bytes: the recorded hash pins the field builder (bump OUTLINE_SDF_VERSION to change it)', () => {
  const font = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf')),
    hash = createHash('sha256');
  for (const char of 'Hamburgefonts AVATAR') {
    const g = font.glyph(char);
    if (g) hash.update(`${char}|${g.width}|${g.height}|${g.left}|${g.top}|`).update(g.data);
  }
  assert.equal(hash.digest('hex'), FIELD_HASH);
});

test('kerning from GPOS equals what the browser shaper measures, TTF and CFF', () => {
  for (const [name, pairs] of Object.entries(kerning.fonts)) {
    const font = new GlyphFieldFont(bytes(name));
    for (const [pair, value] of Object.entries(pairs))
      assert.equal(Math.round(font.kerning(pair[0], pair[1]) * font.unitsPerEm), value, `${name} ${pair}`);
  }
  // The pen positions of a kerned word follow: AV is narrower than A plus V.
  const font = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  assert.ok(font.advance('AV') < font.advance('A') + font.advance('V'));
  // A varied instance reads no kerning (variable kerning deltas are not applied, docs/limits.md).
  assert.equal(new GlyphFieldFont(bytes('SourceSans3VF-Upright.ttf'), { variations: { wght: 650 } }).kerning('A', 'V'), 0);
});

test('ligatures and advances match HarfBuzz for "office AV" (Source Sans 3 VF at weight 650)', () => {
  const [entry] = shaping.cases.filter((c) => c.text === 'office AV');
  const font = new GlyphFieldFont(bytes(entry.font), { variations: entry.variations });
  const glyphs = entry.shapedRuns[0].glyphs;
  const word = font.shape('office');
  assert.deepEqual(word.glyphs, glyphs.filter((g) => g.cluster < 6).map((g) => g.glyphIndex));
  // HarfBuzz applies GPOS kerning with its variation deltas, which GlyphFieldFont does not read on a varied instance
  // (docs/limits.md), so the glyphs it kerned (o before the ligature, e before the space, A before V) are left out; the
  // rest agree within the half unit HarfBuzz rounds to.
  for (const k of [1, 2, 4, 5, 7])
    assert.ok(Math.abs(font.outlines.glyphAdvance(glyphs[k].glyphIndex) - glyphs[k].xAdvance) <= 0.0005 + 1e-12, `advance of glyph ${k}`);
  // A Text laid out with ligatures draws the word as one run, one field holding the ffi ligature.
  const layout = layoutText('office', { ligatures: true }, font);
  assert.equal(layout.glyphs.length, 1);
  assert.ok(font.glyph(layout.glyphs[0].cluster).width > font.glyph('o').width * 2);
  assert.equal(layoutText('office', {}, font).glyphs.length, 6);
});

test('the glyph cache round trip rebuilds nothing; a stale or broken cache is refused', () => {
  const one = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  assert.ok(one.prepare('Titles and captions, AVATAR') > 10);
  const cache = one.exportGlyphs(),
    two = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  assert.equal(two.importGlyphs(cache), true);
  assert.equal(two.prepare('Titles and captions, AVATAR'), 0);
  for (const char of 'Titlesandcptios,AVR') assert.deepEqual(two.glyph(char).data, one.glyph(char).data);
  assert.equal(two.stats.rasterized, 0, 'raster work count 0 after the import');
  assert.ok(two.stats.imported > 10);
  // Another size, another font file or another variation is another key.
  assert.equal(new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'), { size: 32 }).importGlyphs(cache), false);
  assert.equal(new GlyphFieldFont(bytes('SourceSans3-Regular.otf')).importGlyphs(cache), false);
  assert.equal(new GlyphFieldFont(bytes('SourceSans3VF-Upright.ttf'), { variations: { wght: 500 } }).importGlyphs(cache), false);
  assert.equal(two.importGlyphs(new Uint8Array(4)), false);
  assert.throws(() => new GlyphFieldFont(bytes('SourceSans3-Regular.ttf')).importGlyphs(cache.subarray(0, cache.length - 3)), { code: 'failed' });
});

test('work count: distance evaluations per 64 px glyph stay bounded (piece boxes grown by the field reach)', () => {
  const font = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (const char of text) font.glyph(char);
  const mean = font.stats.evaluations / font.stats.rasterized;
  assert.equal(font.stats.rasterized, text.length);
  assert.ok(mean < 100_000, `mean ${Math.round(mean)} evaluations per glyph`);
});

test('in Node: Font refuses with a message naming GlyphFieldFont; GlyphFieldFont lays out, measures and builds glyphs', () => {
  assert.throws(() => layoutText('Hi', {}, new Font()), (error) => error.code === 'unsupported' && /GlyphFieldFont/.test(error.message));
  const font = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  assert.equal(font.loaded, true);
  const text = new Text({ text: 'When It Forms', font, fontSize: 0.5 });
  assert.ok(text.layout.bounds.right - text.layout.bounds.left > 2);
  assert.equal(font.glyph(' '), null);
  assert.ok(font.metrics().ascent > 0.9 && font.metrics().descent > 0.2);
  assert.throws(() => new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'), { size: 7 }), RangeError);
  assert.throws(() => new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'), { size: 64, radius: 40 }), RangeError);
  assert.throws(() => new GlyphFieldFont(new Uint8Array(64)), { name: 'LoaderError', code: 'header' });
});

const FIELD_HASH = '8efe07deb66c5771d4f256cf2c02337317a505b1ca6eee7c2b56fd34544ff67d';
