import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseFontOutlines } from '../dist/extrude.js';
import { Text } from '../dist/index.js';
import {
  CUBIC_TOLERANCE,
  toQuadratics,
  vectorCoverage,
  VectorFont,
  VectorGlyphStore,
  VectorTextRenderer,
} from '../dist/vector.js';

const fonts = new URL('./fixtures/fonts/', import.meta.url);
const bytes = (name) => readFileSync(new URL(name, fonts));
const ttf = parseFontOutlines(bytes('SourceSans3-Regular.ttf')),
  otf = parseFontOutlines(bytes('SourceSans3-Regular.otf')),
  cjk = parseFontOutlines(bytes('NotoSansSC-subset.ttf'));
const LATIN = 'Hamburgefonts',
  HAN = '永字八法龍鬱文';

// Independent references: plain de Casteljau evaluation and nonzero winding with every root tested against [0, 1).
const evaluate = (s, t) => {
  let p = [];
  for (let i = 0; i < s.length; i += 2) p.push([s[i], s[i + 1]]);
  while (p.length > 1) p = p.slice(1).map((q, i) => [p[i][0] * (1 - t) + q[0] * t, p[i][1] * (1 - t) + q[1] * t]);
  return p[0];
};
function winding(curves, x, y) {
  let w = 0;
  for (const [x1, y1, x2, y2, x3, y3] of curves) {
    const a = y1 - 2 * y2 + y3,
      b = 2 * (y2 - y1),
      c = y1 - y,
      roots = [];
    if (Math.abs(a) < 1e-14) {
      if (b !== 0) roots.push(-c / b);
    } else {
      const d = b * b - 4 * a * c;
      if (d >= 0) roots.push((-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a));
    }
    for (const t of roots) {
      if (!(t >= 0 && t < 1)) continue;
      if ((1 - t) * (1 - t) * x1 + 2 * t * (1 - t) * x2 + t * t * x3 <= x) continue;
      const dy = 2 * a * t + b;
      if (dy) w += dy > 0 ? 1 : -1;
    }
  }
  return w;
}
// Curves as the shader sees them: control points snapped to 16-bit fractions of the glyph box.
const quantized = (curves, box) => {
  const sx = (box[2] - box[0]) / 65535,
    sy = (box[3] - box[1]) / 65535;
  return curves.map((c) => c.map((v, i) => (i % 2 ? box[1] + Math.round((v - box[1]) / sy) * sy : box[0] + Math.round((v - box[0]) / sx) * sx)));
};
const glyphIds = (font, count) => {
  const ids = [];
  for (let id = 1; ids.length < count && id < font.glyphCount; id++) if (font.getGlyphSegments(id).length) ids.push(id);
  return ids;
};
let seed = 12345;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

test('getGlyphSegments returns closed unflattened contours that getGlyphContours flattens', () => {
  for (const font of [ttf, otf, cjk])
    for (const char of font === cjk ? HAN : LATIN) {
      const id = font.glyphIndex(char),
        contours = font.getGlyphSegments(id),
        flat = font.getGlyphContours(id, 16).flat();
      assert.ok(contours.length > 0, char);
      const points = [];
      for (const loop of contours) {
        for (let i = 0; i < loop.length; i++) {
          const s = loop[i],
            next = loop[(i + 1) % loop.length];
          assert.ok([4, 6, 8].includes(s.length));
          assert.deepEqual(s.slice(-2), next.slice(0, 2), `${char} contour is closed and chained`);
          for (let j = 0; j <= 16; j++) points.push(evaluate(s, j / 16));
        }
      }
      for (const p of flat) assert.ok(points.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9), `${char} point ${p}`);
    }
});

test('cubics split into quadratics within 1/4096 em of the cubic (every CFF glyph)', () => {
  let cubics = 0,
    worst = 0,
    pieces = 0;
  for (let id = 0; id < otf.glyphCount; id++)
    for (const loop of otf.getGlyphSegments(id))
      for (const s of loop) {
        if (s.length !== 8) continue;
        cubics++;
        const quads = toQuadratics([[s]]);
        pieces += quads.length;
        quads.forEach((q, k) => {
          for (let j = 0; j <= 16; j++) {
            const u = j / 16,
              a = evaluate(s, (k + u) / quads.length),
              b = evaluate(q, u);
            worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
          }
        });
      }
  assert.ok(cubics > 10000, `cubics ${cubics}`);
  assert.ok(worst <= CUBIC_TOLERANCE, `worst ${worst}`);
  // Lines become quadratics with the control point at the start; CFF lines too.
  assert.deepEqual(toQuadratics([[[0, 0, 1, 2]]]), [[0, 0, 0, 0, 1, 2]]);
  assert.throws(() => toQuadratics([[[0, 0, 1]]]), RangeError);
  console.log(`# ${cubics} cubics -> ${pieces} quadratics, worst distance ${worst.toExponential(2)} em`);
});

test('every curve sits in exactly the bands its extent crosses, sorted for the early exit', () => {
  for (const font of [ttf, otf, cjk]) {
    const store = new VectorGlyphStore();
    for (const id of glyphIds(font, font === cjk ? 9 : 200)) {
      const curves = toQuadratics(font.getGlyphSegments(id)),
        glyph = store.add(id, curves),
        n = glyph.bands,
        q = quantized(curves, glyph.box);
      assert.ok(n >= 1 && n <= 32 && glyph.curves === curves.length);
      const key = (c) => c.map((v) => v.toFixed(9)).join();
      const index = new Map(q.map((c, i) => [key(c), i]));
      for (let axis = 0; axis < 2; axis++) {
        const lo = glyph.box[1 - axis],
          span = glyph.box[3 - axis] - lo;
        const seen = q.map(() => new Set());
        for (let b = 0; b < n; b++) {
          const row = (glyph.base + b) * 4,
            start = store.data[row + 2 * axis],
            count = store.data[row + 2 * axis + 1];
          let previous = Infinity;
          for (let r = start; r < start + count; r++) {
            const c = [];
            for (let k = 0; k < 3; k++) {
              const w = store.data[r * 4 + k];
              c.push(glyph.box[0] + (w & 0xffff) * ((glyph.box[2] - glyph.box[0]) / 65535), glyph.box[1] + (w >>> 16) * ((glyph.box[3] - glyph.box[1]) / 65535));
            }
            const i = index.get(key(c));
            assert.ok(i !== undefined, 'a band row decodes to one of the glyph curves');
            seen[i].add(b);
            const top = Math.max(c[axis], c[axis + 2], c[axis + 4]);
            assert.ok(top <= previous + 1e-12, 'sorted by largest coordinate along the ray');
            previous = top;
          }
        }
        q.forEach((c, i) => {
          // Exact extent across the bands, from a dense evaluation.
          let min = Infinity,
            max = -Infinity;
          for (let j = 0; j <= 512; j++) {
            const v = evaluate(c, j / 512)[1 - axis];
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
          const flat = c[1 - axis] === c[3 - axis] && c[3 - axis] === c[5 - axis];
          for (let b = 0; b < n; b++) {
            const b0 = lo + (b / n) * span,
              b1 = lo + ((b + 1) / n) * span,
              crosses = max >= b0 && min <= b1,
              near = max >= b0 - 2e-4 * (span / n) && min <= b1 + 2e-4 * (span / n);
            if (flat) assert.ok(!seen[i].has(b), 'a curve flat across the bands is never listed');
            else if (crosses) assert.ok(seen[i].has(b), `curve ${i} crosses band ${b} on axis ${axis}`);
            else assert.ok(!seen[i].has(b) || near, `curve ${i} listed in band ${b} it does not reach`);
          }
        });
      }
    }
  }
});

test('the shader mirror agrees with an independent nonzero winding on 500 points of 200 glyphs', () => {
  let points = 0,
    skipped = 0;
  const glyphs = [...glyphIds(ttf, 120).map((id) => [ttf, id]), ...glyphIds(otf, 73).map((id) => [otf, id]), ...[...HAN].map((c) => [cjk, cjk.glyphIndex(c)])];
  assert.equal(glyphs.length, 200);
  for (const [font, id] of glyphs) {
    const store = new VectorGlyphStore(),
      curves = toQuadratics(font.getGlyphSegments(id)),
      glyph = store.add(id, curves),
      q = quantized(curves, glyph.box),
      [x0, y0, x1, y1] = glyph.box;
    for (let k = 0; k < 500; k++) {
      const x = x0 - 0.05 + random() * (x1 - x0 + 0.1),
        y = y0 - 0.05 + random() * (y1 - y0 + 0.1);
      // Off the outline by more than 1e-6 em along both rays.
      const offOutline = [-1e-6, 1e-6].every((e) => winding(q, x + e, y) === winding(q, x, y)) &&
        [-1e-6, 1e-6].every((e) => winding(q.map((c) => [c[1], c[0], c[3], c[2], c[5], c[4]]), y + e, x) === winding(q.map((c) => [c[1], c[0], c[3], c[2], c[5], c[4]]), y, x));
      if (!offOutline) {
        skipped++;
        continue;
      }
      const expected = winding(q, x, y) !== 0 ? 1 : 0;
      assert.equal(vectorCoverage(store, glyph, x, y, 1e8, 1e8, { rays: 1 }), expected, `glyph ${id} at ${x}, ${y}`);
      points++;
    }
  }
  assert.ok(points > 0.99 * 500 * glyphs.length, `points ${points}, skipped ${skipped}`);
});

/** CPU mirror coverage against 16x16 supersampling over the glyph's pixel box, the grid offset from the em origin. */
function accuracy(font, string, ppem, options = {}) {
  let sum = 0,
    n = 0,
    max = 0;
  const work = { curves: 0 };
  for (const char of string) {
    const store = new VectorGlyphStore(),
      curves = toQuadratics(font.getGlyphSegments(font.glyphIndex(char))),
      glyph = store.add(0, curves),
      q = quantized(curves, glyph.box),
      [x0, y0, x1, y1] = glyph.box;
    const hulls = q.map((c) => [Math.min(c[0], c[2], c[4]), Math.min(c[1], c[3], c[5]), Math.max(c[0], c[2], c[4]), Math.max(c[1], c[3], c[5])]);
    const ox = Math.floor(x0 * ppem) - 1 + 0.37,
      oy = Math.floor(y0 * ppem) - 1 + 0.61;
    for (let j = 0; j < (y1 - y0) * ppem + 3; j++)
      for (let i = 0; i < (x1 - x0) * ppem + 3; i++) {
        const l = (ox + i) / ppem,
          b = (oy + j) / ppem,
          r = (ox + i + 1) / ppem,
          t = (oy + j + 1) / ppem;
        const cov = vectorCoverage(store, glyph, (l + r) / 2, (b + t) / 2, ppem, ppem, { ...options, work });
        let ref;
        if (!hulls.some((h) => h[2] >= l && h[0] <= r && h[3] >= b && h[1] <= t)) ref = winding(q, (l + r) / 2, (b + t) / 2) ? 1 : 0;
        else {
          ref = 0;
          for (let v = 0; v < 16; v++) for (let u = 0; u < 16; u++) if (winding(q, l + ((u + 0.5) / 16) * (r - l), b + ((v + 0.5) / 16) * (t - b))) ref++;
          ref /= 256;
        }
        // Mean over the glyph's pixel box (one pixel of margin), as the GPU check measures it.
        const e = Math.abs(cov - ref);
        sum += e;
        n++;
        max = Math.max(max, e);
      }
  }
  return { mean: sum / n, max, curvesPerPixel: work.curves / n };
}

test('CPU mirror coverage stays within the GPU bars against 16x16 supersampling (4 to 48 px)', { timeout: 600000 }, () => {
  // Curve rows read per pixel, measured 2026-11-10 (deterministic); a regression past 5% over these fails.
  const budget = { ttf: [29.2, 29.1, 20.3, 18.2], cff: [28.8, 28.9, 20.2, 18.1], cjk: [40.7, 41.9, 27.3, 27.8] };
  const rows = [];
  for (const [label, font, string] of [
    ['ttf', ttf, LATIN],
    ['cff', otf, LATIN],
    ['cjk', cjk, HAN],
  ])
    for (const [k, ppem] of [4, 6, 12, 48].entries()) {
      const r = accuracy(font, string, ppem);
      rows.push(`${label} ${ppem}px mean ${r.mean.toFixed(4)} max ${r.max.toFixed(3)} rows/px ${r.curvesPerPixel.toFixed(1)}`);
      assert.ok(r.mean < 1 / 64, `${label} ${ppem}px mean ${r.mean}`);
      assert.ok(r.max < 0.25, `${label} ${ppem}px max ${r.max}`);
      // Work count bar: curve rows read per drawn pixel (deterministic; regressions show up here).
      assert.ok(r.curvesPerPixel < budget[label][k] * 1.05, `${label} ${ppem}px reads ${r.curvesPerPixel} rows per pixel`);
    }
  // One ray per axis is cheaper and coarser; still bounded.
  const one = accuracy(ttf, LATIN, 12, { rays: 1 });
  rows.push(`ttf 12px rays 1 mean ${one.mean.toFixed(4)} max ${one.max.toFixed(3)} rows/px ${one.curvesPerPixel.toFixed(1)}`);
  assert.ok(one.mean < 1 / 32 && one.curvesPerPixel < 12);
  console.log(rows.map((r) => `# ${r}`).join('\n'));
});

test('dilation grows the ink on clockwise (TrueType) and counter-clockwise (CFF) outlines, along both axes', () => {
  for (const font of [ttf, otf]) {
    const store = new VectorGlyphStore(),
      glyph = store.add(0, toQuadratics(font.getGlyphSegments(font.glyphIndex('o'))));
    assert.equal(glyph.orientation, font === ttf ? -1 : 1);
    let plain = 0,
      bold = 0;
    for (let j = 0; j < 12; j++)
      for (let i = 0; i < 12; i++) {
        const x = glyph.box[0] + (i + 0.5) / 12 * (glyph.box[2] - glyph.box[0]),
          y = glyph.box[1] + (j + 0.5) / 12 * (glyph.box[3] - glyph.box[1]);
        const a = vectorCoverage(store, glyph, x, y, 12),
          b = vectorCoverage(store, glyph, x, y, 12, 12, { dilation: 0.25 });
        assert.ok(b >= a - 1e-9, `dilation never removes ink (${a} -> ${b})`);
        plain += a;
        bold += b;
      }
    assert.ok(bold > plain * 1.05, `${plain} -> ${bold}`);
  }
});

test('VectorFont measures from the file and builds each glyph once', () => {
  const font = new VectorFont(bytes('SourceSans3-Regular.ttf'));
  assert.equal(font.loaded, true);
  assert.equal(font.advance('H'), ttf.glyphAdvance(ttf.glyphIndex('H')));
  assert.equal(font.advance('H‍️'), font.advance('H'), 'joiners and variation selectors draw and measure nothing');
  assert.equal(font.kerning('A', 'V'), 0, 'no FontFace in Node: no kerning source');
  assert.deepEqual(font.metrics(), { ascent: ttf.ascender / ttf.unitsPerEm, descent: -ttf.descender / ttf.unitsPerEm });
  const first = font.clusterGlyphs('é');
  assert.equal(first.length, 2);
  assert.equal(first[1].x, ttf.glyphAdvance(ttf.glyphIndex('e')));
  const revision = font.store.revision;
  assert.equal(font.vectorGlyph(first[0].glyph.id), first[0].glyph);
  assert.equal(font.store.revision, revision, 'a built glyph is not packed again');
  assert.equal(font.clusterGlyphs(' ')[0].glyph.bands, 0, 'a space has no bands');
  const text = new Text({ text: 'Hamburgefonts', font, fontSize: 2 });
  assert.equal(text.layout.glyphs.length, 13, 'Text lays out with a VectorFont without a browser');
  const variable = new VectorFont(bytes('SourceSans3VF-Upright.ttf'), { variations: { wght: 900 } });
  assert.ok(variable.advance('H') > new VectorFont(bytes('SourceSans3VF-Upright.ttf')).advance('H'), 'variations reach the advances');
});

test('VectorTextRenderer checks its options and refuses text without a VectorFont', () => {
  assert.throws(() => new VectorTextRenderer({ name: '' }), TypeError);
  assert.throws(() => new VectorTextRenderer({ dilation: -0.1 }), RangeError);
  assert.throws(() => new VectorTextRenderer({ rays: 4 }), RangeError);
  const renderer = new VectorTextRenderer();
  assert.equal(renderer.name, 'text:vector');
  assert.equal(renderer.rays, 'auto');
  assert.equal(renderer.dilation, 0);
  assert.throws(() => renderer.add(new Text({ text: 'x' })), TypeError);
  const font = new VectorFont(bytes('SourceSans3-Regular.ttf')),
    text = renderer.add(new Text({ text: 'x', font }));
  assert.equal(renderer.texts.size, 1);
  text.dispose();
  assert.equal(renderer.texts.size, 0);
});
