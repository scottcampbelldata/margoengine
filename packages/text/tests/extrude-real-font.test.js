import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseFontOutlines, extrudeText } from '../dist/extrude.js';
import { tables } from './extrude-fixtures.js';
import { closed, volume } from './extrude-assertions.js';

const root = new URL('./fixtures/fonts/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('outline-reference.json', root)));
// Independent de Casteljau evaluator of absolute GDI cubic controls. No parser code is shared with extrude.ts.
function evaluate(points, t) {
  let current = points;
  while (current.length > 1)
    current = current.slice(1).map((p, i) => p.map((v, axis) => current[i][axis] * (1 - t) + v * t));
  return current[0].map((v) => v / 1000);
}
function distance(point, loops) {
  let best = Infinity;
  for (const loop of loops)
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i],
        b = loop[(i + 1) % loop.length],
        dx = b[0] - a[0],
        dy = b[1] - a[1];
      const length = dx * dx + dy * dy,
        t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
      best = Math.min(best, Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy));
    }
  return best;
}
for (const extension of ['ttf', 'otf']) {
  const bytes = readFileSync(new URL(`SourceSans3-Regular.${extension}`, root));
  const expected = reference.fonts[extension];
  test(`F3/F4/F8 real ${extension} outlines match independent native cubic reference`, { timeout: 60000 }, () => {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
    const font = parseFontOutlines(bytes);
    for (const [char, glyph] of Object.entries(expected.glyphs)) {
      assert.equal(font.glyphIndex(char), glyph.index);
      const actual = font.getGlyphContours(glyph.index, 64);
      const oracle = glyph.contours.map((segments) =>
        segments.flatMap((segment) => Array.from({ length: 257 }, (_, i) => evaluate(segment, i / 256))),
      );
      let derivative = 0;
      for (const loop of glyph.contours)
        for (const segment of loop)
          if (segment.length === 4) {
            for (let i = 0; i < 2; i++)
              derivative = Math.max(
                derivative,
                (6 * Math.hypot(...segment[i].map((v, axis) => v - 2 * segment[i + 1][axis] + segment[i + 2][axis]))) /
                  1000,
              );
          }
      // Linear interpolation error <= max|p''|/(8 n^2), plus GDI's 16.16 control quantization.
      const tolerance = derivative / (8 * 64 * 64) + 2 / (65536 * 1000);
      for (const p of actual.flat())
        assert.ok(distance(p, oracle) <= tolerance, `${extension} ${char} decoded point ${p}`);
      for (const p of oracle.flat())
        assert.ok(distance(p, actual) <= tolerance, `${extension} ${char} missing curve point ${p}`);
    }
  });
  test(`F5/F6/F10 real ${extension}: every glyph extrudes with zero unmatched edges`, { timeout: 180000 }, () => {
    const font = parseFontOutlines(bytes),
      maxp = tables(bytes).get('maxp'),
      count = maxp[4] * 256 + maxp[5];
    assert.equal(count, 2478);
    let nonempty = 0;
    for (let glyph = 0; glyph < count; glyph++) {
      const provider = {
        unitsPerEm: font.unitsPerEm,
        glyphIndex: () => glyph,
        glyphAdvance: () => font.glyphAdvance(glyph),
        getGlyphContours: (_, s) => font.getGlyphContours(glyph, s),
      };
      const mesh = extrudeText('a', { font: provider });
      try {
        closed(mesh);
        if (mesh.indices.length) {
          nonempty++;
          assert.ok(volume(mesh) > 0);
        }
      } catch (error) {
        throw new Error(`${extension} glyph ${glyph}: ${error.message}`, { cause: error });
      }
    }
    assert.equal(nonempty, 2469);
  });
}
