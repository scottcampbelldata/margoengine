// The lid margin anchor of Character Creator's eye occlusion shell (eye-margin.ts): a flat shell with a sheet of skin
// over its top rows, the sheet's edge a sloped lid margin, as a front view sees an eye under its lid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorLidShadow, eyeOcclusionAlpha } from '../dist/character-creator.js';

// The shell: a 9 by 9 grid in z 0, u along x, v 0 at the top (y 1). The lid: skin at z 0.05 covering y above
// 1 - margin(x), margin(u) = 0.15 + 0.08 u of the shell's v, so the opening starts lower toward the inner corner.
const margin = (u) => 0.15 + 0.08 * u;
function shell(n = 9) {
  const positions = [],
    uvs = [],
    indices = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1),
        v = j / (n - 1);
      positions.push(u, 1 - v, 0);
      uvs.push(u, v);
    }
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      indices.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
    }
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}
const lid = {
  positions: new Float32Array([
    -0.5,
    1 - margin(-0.5),
    0.05,
    1.5,
    1 - margin(1.5),
    0.05,
    1.5,
    1.6,
    0.05,
    -0.5,
    1.6,
    0.05,
  ]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
// Character Creator's eye occlusion numbers on Wilbur (CC4 json), as the reader reads them.
const variables = {
  'Shadow Strength': 0.5,
  'Shadow Color': [178, 126, 109],
  'Shadow Top': 0.257,
  'Shadow Top Range': 1,
  'Shadow Top Arc': 1,
  'Shadow2 Strength': 0.412,
  'Shadow2 Color': [60, 41, 36],
  'Shadow2 Top': 0.088,
};
const texture = eyeOcclusionAlpha(variables, 128, 64);
// The texture's alpha at (u, v) as a clamped linear sampler reads it.
const alpha = (u, v) => {
  const x = Math.min(127, Math.max(0, Math.round(u * 128 - 0.5))),
    y = Math.min(63, Math.max(0, v * 64 - 0.5)),
    y0 = Math.floor(y),
    y1 = Math.min(63, y0 + 1),
    f = y - y0,
    a = (r) => texture.data[(r * 128 + x) * 4 + 3] / 255;
  return a(y0) * (1 - f) + a(y1) * f;
};
// Measured on a CC0 photograph of a frontal male eye (Wikimedia Commons, "A human male brown eye.jpg",
// Bobbyphotographer 2025; asset library references/eyes/LABEL.md): the sclera's linear luminance over its middle
// (t 0.4 to 0.6 of the visible run) in bands down from the upper lid margin, the 25th percentile over 41 columns.
// It is the whole darkening: the ball's own shading, the lashes and the lid's shadow together.
const photo = [
  [0.025, 0.132],
  [0.075, 0.24],
  [0.125, 0.376],
  [0.175, 0.517],
  [0.225, 0.629],
  [0.275, 0.744],
];

test('the lid margin is found where the skin stops hiding the shell, to a hundredth of the shell', () => {
  const s = shell(),
    out = anchorLidShadow(s, lid, [0, 0, 1]);
  assert.ok(out, 'the skin hides the top rows');
  assert.equal(out.hidden, 18, 'two rows under the lid');
  for (let i = 0; i < out.margin.length; i++) {
    const u = out.u0 + ((i + 0.5) / out.margin.length) * (out.u1 - out.u0);
    assert.ok(Math.abs(out.margin[i] - margin(u)) < 0.01, `column ${i}: ${out.margin[i]} against ${margin(u)}`);
  }
  // Remapped, v 0 is the margin and v 1 the bottom lid; u stays.
  for (let k = 0; k < s.uvs.length; k += 2) {
    const u = s.uvs[k],
      m = margin(u),
      want = (s.uvs[k + 1] - m) / (1 - m);
    assert.equal(out.uvs[k], u);
    assert.ok(Math.abs(out.uvs[k + 1] - want) < 0.012, `vertex ${k / 2}: ${out.uvs[k + 1]} against ${want}`);
  }
  // Seen from behind the skin hides nothing; with no skin, nothing either: the shell is left as it was.
  assert.equal(anchorLidShadow(s, lid, [0, 0, -1]), undefined);
  assert.equal(anchorLidShadow(s, { positions: new Float32Array(0) }, [0, 0, 1]), undefined);
});

// At the corners the shell tucks under the canthus skin whole: skin over the first and last columns at every height. The
// edges from those columns across u cross the side of the opening, not the top margin, and must not pull the corners
// down to the shell's middle; the corner columns follow the margin the other columns measure.
test('the corners keep the top margin when the skin hides whole corner columns', () => {
  const s = shell(),
    flap = (x0, x1) => [x0, -0.5, 0.05, x1, -0.5, 0.05, x1, 1.6, 0.05, x0, 1.6, 0.05],
    skin = {
      positions: new Float32Array([...lid.positions, ...flap(-0.5, 0.06), ...flap(0.94, 1.5)]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]),
    },
    out = anchorLidShadow(s, skin, [0, 0, 1]);
  assert.ok(out, 'the skin hides the top rows and the corners');
  for (let i = 0; i < out.margin.length; i++) {
    const u = out.u0 + ((i + 0.5) / out.margin.length) * (out.u1 - out.u0);
    assert.ok(Math.abs(out.margin[i] - margin(u)) < 0.02, `column ${i}: ${out.margin[i]} against ${margin(u)}`);
  }
});

test("the top shadow starts at the visible margin, as dark there as Character Creator's numbers make it", () => {
  const s = shell(),
    out = anchorLidShadow(s, lid, [0, 0, 1]),
    lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4),
    dark = (rgb, strength) => strength * (1 - (0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]))),
    top = 1 - (1 - dark(variables['Shadow Color'], 0.5)) * (1 - dark(variables['Shadow2 Color'], 0.412)),
    // The remapped v at a point of the shell: the uv interpolated across the grid, as the rasterizer does.
    at = (uvs, u, v) => {
      const n = 9,
        x = u * (n - 1),
        y = v * (n - 1),
        i = Math.min(n - 2, Math.floor(x)),
        j = Math.min(n - 2, Math.floor(y)),
        fx = x - i,
        fy = y - j,
        q = (a, b) => uvs[2 * ((j + b) * n + i + a) + 1];
      return (q(0, 0) * (1 - fx) + q(1, 0) * fx) * (1 - fy) + (q(0, 1) * (1 - fx) + q(1, 1) * fx) * fy;
    };
  const u = 0.5,
    m = margin(u),
    anchored = alpha(u, at(out.uvs, u, m)),
    before = alpha(u, at(s.uvs, u, m));
  // At the margin: the full top shadow (Shadow Top and Shadow2 Top together), within a texel's step.
  assert.ok(Math.abs(anchored - top) < 0.03, `alpha at the margin ${anchored.toFixed(3)} against ${top.toFixed(3)}`);
  // Bounded by the photograph: from the margin down the shell alone is never darker than the whole real eye (it
  // leaves the ball's shading to the eye material), and at the margin it gives at least half of the measured darkening.
  // Before the anchor the shadow began under the skin: at a margin this low (v 0.15 to 0.23) it had nearly faded.
  const height = 1 - m;
  for (const [t, ratio] of photo) {
    const left = 1 - alpha(u, at(out.uvs, u, m + t * height));
    assert.ok(left >= ratio, `t ${t}: the shell leaves ${left.toFixed(3)} of the sclera, the photo ${ratio}`);
  }
  assert.ok(anchored >= 0.5 * (1 - photo[0][1]), `margin darkening ${anchored.toFixed(3)}`);
  assert.ok(before < 0.1 * (1 - photo[0][1]), `without the anchor the margin got ${before.toFixed(3)}`);
});
