// Multi-channel glyph fields (GAP-FILM-MSDF): the median of three channels keeps corners that a one-channel field
// rounds, no false edges appear, alpha is the one-channel field byte for byte, and the bytes are pinned.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { openType } from '@margoengine/loaders/font-opentype';
import { GlyphFieldFont, flattenOutline, outlineMsdf, outlineSdf, windingAt } from '@margoengine/text/outline';

const dir = new URL('./fixtures/fonts/', import.meta.url);
const bytes = (name) => readFileSync(new URL(name, dir));
const params = { size: 32, radius: 8, cutoff: 0.25, buffer: 6 };
const level = 255 * (1 - params.cutoff);
const median = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/** Contours (em) of a string's glyphs, pen offsets applied. */
function contoursOf(font, text) {
  const run = font.shape(text),
    out = [];
  for (let i = 0; i < run.glyphs.length; i++)
    for (const loop of font.outlines.getGlyphSegments(run.glyphs[i]))
      out.push(loop.map((s) => s.map((v, k) => (k % 2 ? v : v + run.x[i]))));
  return out;
}

/** Bilinear sample of texel values `get(k)` at (x, y) in texel space. */
function bilinear(get, width, height, x, y) {
  const i = Math.min(width - 2, Math.floor(x)),
    j = Math.min(height - 2, Math.floor(y)),
    fx = x - i,
    fy = y - j;
  const a = get(j * width + i),
    b = get(j * width + i + 1),
    c = get((j + 1) * width + i),
    d = get((j + 1) * width + i + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Inside/outside of the GPU's reconstruction (bilinear, then the median) against the exact outline on an 8 x 8 grid per
 * texel: how many samples are wrong further than 0.25 and 0.5 texel from the outline, for the MSDF and the SDF.
 */
function misses(contours, p = params, perTexel = 8) {
  const m = outlineMsdf(contours, p),
    s = outlineSdf(contours, p),
    flat = flattenOutline(contours, p.size, 1 / 64),
    segs = new Float64Array(flat.length);
  for (let k = 0; k < flat.length; k += 2) {
    segs[k] = flat[k] - m.left - 0.5;
    segs[k + 1] = m.top - 0.5 - flat[k + 1];
  }
  const distance = (x, y) => {
    let best = Infinity;
    for (let k = 0; k < segs.length; k += 4) {
      const ax = segs[k],
        ay = segs[k + 1],
        dx = segs[k + 2] - ax,
        dy = segs[k + 3] - ay,
        qx = x - ax,
        qy = y - ay,
        t = Math.min(1, Math.max(0, (qx * dx + qy * dy) / (dx * dx + dy * dy))),
        ex = qx - t * dx,
        ey = qy - t * dy;
      best = Math.min(best, ex * ex + ey * ey);
    }
    return Math.sqrt(best);
  };
  const out = { msdf: [0, 0], sdf: [0, 0], m, s };
  for (let y = 0.5; y < m.height - 1.5; y += 1 / perTexel)
    for (let x = 0.5; x < m.width - 1.5; x += 1 / perTexel) {
      const inside = windingAt(segs, x, y) !== 0,
        mm = median(
          bilinear((k) => m.msdf[4 * k], m.width, m.height, x, y),
          bilinear((k) => m.msdf[4 * k + 1], m.width, m.height, x, y),
          bilinear((k) => m.msdf[4 * k + 2], m.width, m.height, x, y),
        ),
        ss = bilinear((k) => s.data[k], m.width, m.height, x, y);
      for (const [name, value] of [
        ['msdf', mm],
        ['sdf', ss],
      ])
        if (value > level !== inside) {
          const d = distance(x, y);
          if (d > 0.25) out[name][0]++;
          if (d > 0.5) out[name][1]++;
        }
    }
  return out;
}

test('the median keeps corners: misses past 0.25 texel fall to under a tenth of the one-channel field, none past 0.5', () => {
  const font = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  let msdf = 0,
    sdf = 0;
  for (const char of 'ABEFHKLMNRTVWXYZ4791&kxzw') {
    const r = misses(contoursOf(font, char));
    assert.equal(r.msdf[1], 0, `${char}: no false edge past 0.5 texel`);
    msdf += r.msdf[0];
    sdf += r.sdf[0];
  }
  assert.ok(sdf > 50, `the one-channel field rounds corners (${sdf} misses past 0.25 texel)`);
  assert.ok(msdf * 10 < sdf, `MSDF ${msdf} against SDF ${sdf} misses past 0.25 texel`);
});

test('no more false edges than the one-channel field on CFF, variable (overlapping contours), CJK and Arabic outlines', () => {
  const fonts = [
    ['SourceSans3-Regular.otf', {}, 'AKMW&@'],
    ['SourceSans3VF-Upright.ttf', { variations: { wght: 650 } }, 'AKMW#&'],
    ['NotoSansSC-subset.ttf', {}, null],
    ['Amiri-Regular.ttf', {}, '$&@'],
  ];
  for (const [name, options, chars] of fonts) {
    const font = new GlyphFieldFont(bytes(name), { openType, ...options }),
      sets = chars
        ? [...chars].map((char) => contoursOf(font, char))
        : Array.from({ length: 6 }, (_, i) => font.outlines.getGlyphSegments(i + 1));
    for (const [n, contours] of sets.entries()) {
      const char = chars ? [...chars][n] : `glyph ${n + 1}`;
      if (!contours.length) continue;
      const r = misses(contours);
      assert.ok(r.msdf[1] <= r.sdf[1], `${name} ${char}: ${r.msdf[1]} MSDF against ${r.sdf[1]} SDF misses past 0.5`);
      assert.ok(r.msdf[0] <= r.sdf[0], `${name} ${char}: ${r.msdf[0]} MSDF against ${r.sdf[0]} SDF misses past 0.25`);
    }
  }
});

test('error correction finds every false edge along a line: thin strokes and cell interiors', () => {
  // Amiri '$' at 32 px: a stroke about one texel thick where the median meets the edge level 0.48 texel from the
  // outline yet draws the stroke's middle, 0.504 texel from either side, outside. SourceSans '8' at 16 px: a false edge
  // inside a cell, between its centre and quarter points. Both must match the one-channel field on a 1/16 texel grid.
  const amiri = new GlyphFieldFont(bytes('Amiri-Regular.ttf'), { openType }),
    sans = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  for (const [font, char, size] of [
    [amiri, '$', 32],
    [sans, '8', 16],
  ]) {
    const r = misses(contoursOf(font, char), { ...params, size }, 16);
    assert.equal(r.msdf[1], 0, `${char} at ${size} px: ${r.msdf[1]} MSDF samples wrong past 0.5 texel`);
  }
});

test('alpha is the one-channel field byte for byte; MSDF alpha is 255', () => {
  const font = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  for (const char of 'Ag&') {
    const contours = contoursOf(font, char),
      m = outlineMsdf(contours, params),
      plain = outlineMsdf(contours, { ...params, trueAlpha: false }),
      s = outlineSdf(contours, params);
    assert.deepEqual(m.data, s.data);
    for (let k = 0; k < s.data.length; k++) {
      assert.equal(m.msdf[4 * k + 3], s.data[k]);
      assert.equal(plain.msdf[4 * k + 3], 255);
    }
  }
});

/** A closed polygon contour (em) through the points. */
const polygon = (...points) =>
  points.map(([x, y], k) => {
    const [nx, ny] = points[(k + 1) % points.length];
    return [x, y, nx, ny];
  });

test('edge colouring: corners split channels so neighbours share exactly one; a round contour stays white', () => {
  // A square: four corners, four runs; each pair of neighbouring edges shares exactly one channel.
  const square = outlineMsdf([polygon([0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9])], params);
  // Texels just inside each edge's middle see that edge's channels at the nearest distance.
  const at = (x, y) => {
    const i = Math.round(x * params.size - square.left - 0.5),
      j = Math.round(square.top - 0.5 - y * params.size),
      k = 4 * (j * square.width + i);
    return [...square.msdf.subarray(k, k + 3)];
  };
  const corner = at(0.12, 0.12);
  assert.ok(median(...corner) > level, 'inside at the corner');
  // A circle from quadratics has no corners: every channel holds the same value.
  const r = 0.4,
    c = 0.5,
    circle = [];
  for (let k = 0; k < 8; k++) {
    const a0 = (k / 8) * 2 * Math.PI,
      a1 = ((k + 1) / 8) * 2 * Math.PI,
      am = (a0 + a1) / 2,
      far = r / Math.cos(Math.PI / 8);
    circle.push([
      c + r * Math.cos(a0),
      c + r * Math.sin(a0),
      c + far * Math.cos(am),
      c + far * Math.sin(am),
      c + r * Math.cos(a1),
      c + r * Math.sin(a1),
    ]);
  }
  const round = outlineMsdf([circle], params);
  for (let k = 0; k < round.data.length; k++)
    assert.ok(
      round.msdf[4 * k] === round.msdf[4 * k + 1] && round.msdf[4 * k + 1] === round.msdf[4 * k + 2],
      'white edges give equal channels',
    );
  // Around the convex corner at (0.1, 0.1), the quadrants follow Chlumsky's median-of-three model (V. Chlumsky, "Shape
  // Decomposition for Multi-channel Distance Fields", MSc thesis, CTU Prague, 2015, section 3.2.2 and figure 3.7a):
  // inside, two channels are inside; in each outer border quadrant exactly one channel is inside while the median is
  // outside (that channel is what keeps the corner sharp); in the outer opposite quadrant every channel is outside.
  const outerBorders = [at(0.05, 0.12), at(0.12, 0.05)];
  for (const values of outerBorders) {
    assert.equal(
      values.filter((v) => v > level).length,
      1,
      `one channel inside in an outer border quadrant: ${values}`,
    );
    assert.ok(median(...values) < level, `the median is outside in an outer border quadrant: ${values}`);
  }
  assert.equal(corner.filter((v) => v > level).length >= 2, true, `two channels inside the corner: ${corner}`);
  // On the corner's diagonal (the texel nearest (0.05, 0.05) em sits on it exactly) the two edges tie by true distance
  // and by orthogonality: the dividing ray "is equally non-perpendicular to both segments" (thesis, section 2.4). Their
  // pseudo-distances (to the edges' extensions, section 2.5) are equal, so every channel holds the same value, nearer
  // the edge level than the true distance to the corner point that alpha holds.
  const i = Math.round(0.05 * params.size - square.left - 0.5),
    j = Math.round(square.top - 0.5 - 0.05 * params.size),
    k = 4 * (j * square.width + i),
    opposite = [...square.msdf.subarray(k, k + 3)];
  // Texel (i, j) has its centre at ((i + left + 0.5) / size, (top - 0.5 - j) / size) em; the diagonal is x = y.
  assert.equal(i + square.left + 0.5, square.top - 0.5 - j, 'the sample is on the diagonal');
  assert.equal(new Set(opposite).size, 1, `every channel equal on the diagonal: ${opposite}`);
  assert.ok(opposite[0] < level, 'outside past the corner');
  assert.ok(
    opposite[0] > square.msdf[k + 3],
    `pseudo-distance ${opposite[0]} nearer than the true distance ${square.msdf[k + 3]}`,
  );
  // Off the diagonal, still in the outer opposite quadrant, the two edges' channels differ but all stay outside.
  const off = at(0.05, 0.07);
  assert.ok(new Set(off).size > 1, `channels differ off the diagonal: ${off}`);
  assert.ok(Math.max(...off) < level, `every channel outside in the outer opposite quadrant: ${off}`);
});

test('GlyphFieldFont builds MTSDF by default, MSDF and SDF on request; the cache carries the channels', () => {
  const one = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  assert.equal(one.field, 'mtsdf');
  const g = one.glyph('A');
  assert.equal(g.mtsdf, true);
  assert.equal(g.msdf.length, 4 * g.width * g.height);
  assert.equal(new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'), { field: 'msdf' }).glyph('A').mtsdf, false);
  const plain = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'), { field: 'sdf' }).glyph('A');
  assert.equal(plain.msdf, undefined);
  assert.deepEqual(plain.data, g.data, 'the one-channel field does not depend on the kind');
  assert.throws(() => new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'), { field: 'psdf' }), TypeError);
  // Round trip; another kind is another key.
  one.prepare('Titles AVATAR');
  const cache = one.exportGlyphs(),
    two = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'));
  assert.equal(two.importGlyphs(cache), true);
  assert.equal(two.prepare('Titles AVATAR'), 0);
  assert.deepEqual(two.glyph('A').msdf, g.msdf);
  assert.equal(two.glyph('A').mtsdf, true);
  assert.equal(new GlyphFieldFont(bytes('SourceSans3-Regular.ttf'), { field: 'sdf' }).importGlyphs(cache), false);
  assert.ok(one.stats.corrected >= 0);
});

test('MTSDF bytes are deterministic: the recorded hash pins the builder (bump OUTLINE_SDF_VERSION to change it)', () => {
  const font = new GlyphFieldFont(bytes('SourceSans3-Regular.ttf')),
    hash = createHash('sha256');
  for (const char of 'Hamburgefonts AVATAR') {
    const g = font.glyph(char);
    if (g) hash.update(`${char}|${g.width}|${g.height}|${g.left}|${g.top}|`).update(g.msdf);
  }
  assert.equal(hash.digest('hex'), MSDF_HASH);
});

const MSDF_HASH = '75fdf2a0f3730e987326a532b2b18d75d8a02b31bef244cb986418e017b9cb29';
