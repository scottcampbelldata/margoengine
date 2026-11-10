// Real-GPU check of Hatching (@margoengine/toon/hatch) on core meshes. Takes a GPU slot itself. From the repository
// root, after building packages:   node packages/toon/test/hatch-check.mjs
// A board facing the camera is lit at a known n.l, so the whole board has one light level and the inked share of a
// 256 x 256 px window must be what the pattern's geometry gives: halftone dots cover 1 - light of each cell; hatching
// draws the layers k (0-based) with light < (layers - k) / (layers + 1), each a stripe family covering width / spacing,
// and stripe families at different angles cover 1 - (1 - width / spacing)^layers together. A pixel counts as ink when
// darker than half the paper. The pattern's edge is a 1 px ramp (ink = clamp(edge distance + 0.5)) mixed in linear light
// before core's display curve (Khronos PBR Neutral, then sRGB), so half the paper's encoded value is an ink level k
// worked out through that curve, and the expected shares use the dot radius or
// stripe half-width grown by 0.5 - k. The strokes are turned 10 degrees off the pixel grid so the window samples
// them evenly (strokes along the grid cover whole pixel columns instead).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const release = await acquire({ owner: 'toon-hatch' });
const context = await openBrowser({ startPath: '/packages/toon/test/hatch-check.html', port: 5401 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const timer = setTimeout(() => {
  console.error('toon hatch-check: over its 2 minute limit');
  process.exit(1);
}, 120_000);
// Core's display curve for a grey linear value (packages/core/src/shaders.ts), encoded 0..1.
const display = (x) => {
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04,
    v = x - offset,
    m = v < 0.76 ? v : 1 - (0.24 * 0.24) / (v + 0.24 - 0.76);
  return m < 0.0031308 ? m * 12.92 : 1.055 * m ** (1 / 2.4) - 0.055;
};
// The x in [lo, hi] with f(x) = target, f increasing.
const solve = (f, target, lo, hi) => {
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};
// How far past the pattern's edge (in px) a pixel still reads as ink at half the paper's encoded value.
const margin = (paper) => {
  const linear = solve(display, paper / 255, 0, 100),
    k = solve((ink) => -display((1 - ink) * linear), -paper / 510, 0, 1);
  return 0.5 - k;
};
const share = async (light, options) => {
  const { errors } = await page.evaluate(([l, o]) => window.check.run(l, o), [light, options]);
  assert.deepEqual(errors, [], `light ${light}`);
  const image = await decodePNG(await page.locator('canvas').screenshot()),
    values = [];
  for (let y = 128; y < 384; y++)
    for (let x = 128; x < 384; x++) {
      const o = (y * image.width + x) * 4;
      values.push((image.data[o] + image.data[o + 1] + image.data[o + 2]) / 3);
    }
  const paper = Math.max(...values);
  assert.ok(paper > 100, `the paper is lit: ${paper}`);
  return { got: values.filter((v) => v < paper / 2).length / values.length, margin: margin(paper) };
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const results = [];
  // A disc of radius r (in cells) centred in its unit cell covers pi r^2 until r = 0.5; past that the four sides cut a
  // circular segment each, until the corners are reached at r = sqrt(0.5).
  const cellShare = (r) =>
    r <= 0.5
      ? Math.PI * r * r
      : r >= Math.SQRT1_2
        ? 1
        : Math.PI * r * r - 4 * (r * r * Math.acos(0.5 / r) - 0.5 * Math.sqrt(r * r - 0.25));
  const dotRadius = (share) => {
    let lo = 0,
      hi = Math.SQRT1_2;
    for (let k = 0; k < 60; k++) if (cellShare((lo + hi) / 2) < share) lo = (lo + hi) / 2;
    else hi = (lo + hi) / 2;
    return (lo + hi) / 2;
  };
  // Dark tones (light below 1 - pi/4) need the clipped disc: a dot sized by pi r^2 alone left the cell corners bare,
  // 91 percent ink at light 0.
  for (const light of [0.05, 0.1, 0.25, 0.5, 0.75]) {
    const { got, margin: m } = await share(light, { style: 'halftone', spacing: 16, angle: 30 }),
      radius = 16 * dotRadius(1 - light);
    results.push({ style: 'halftone', light, got, want: cellShare((radius + m) / 16), area: 1 - light });
  }
  for (const [light, layers] of [
    [0.8, 0],
    [0.6, 1],
    [0.4, 2],
    [0.1, 3],
  ]) {
    const { got, margin: m } = await share(light, { style: 'hatch', spacing: 16, width: 4, layers: 3, angle: 10 }),
      stripe = (4 + 2 * m) / 16;
    results.push({ style: 'hatch', light, got, want: 1 - (1 - stripe) ** layers, area: 1 - (1 - 4 / 16) ** layers });
  }
  for (const r of results) console.log(JSON.stringify(r));
  for (const r of results) {
    assert.ok(Math.abs(r.got - r.want) < 0.03, `${r.style} at light ${r.light}: ${r.got} inked, ${r.want} expected`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('toon hatch-check: ok');
} finally {
  clearTimeout(timer);
  await context.close();
  release();
}
