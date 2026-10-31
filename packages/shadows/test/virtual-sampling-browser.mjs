// Real-GPU test of virtual shadow pages and 'hard' sampling (row 21.6 stage 2). A box on a plane; the expected mask is a CPU
// ray cast against the same geometry. Agreement of the virtual map with it must reach 99.9% (plan floor 99.5%, measured 100%) outside a 2 px band around
// the mask's edges and the surfaces' outlines, and the same frame from cascades ('hard') must agree with the virtual map
// in the same band. Run from the repository root after `npm run build:packages`.
// Writes test-results/virtual-sampling.json and test-results/virtual-sampling-*.png.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const BAND = 2,
  AGREEMENT = 0.999;
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'shadows-virtual-sampling' });
const context = await openBrowser({ startPath: '/packages/shadows/test/virtual-sampling.html', port: 5268 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luma = (img) => {
  const out = new Float32Array(img.width * img.height);
  for (let p = 0; p < out.length; p++)
    out[p] =
      0.2126 * linear(img.data[p * 4]) + 0.7152 * linear(img.data[p * 4 + 1]) + 0.0722 * linear(img.data[p * 4 + 2]);
  return out;
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  norm = (a) => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Ray-box entry and exit distances, or undefined on a miss. */
const slab = (origin, ray, box) => {
  let near = -Infinity,
    far = Infinity,
    axis = 0;
  for (let k = 0; k < 3; k++) {
    const a = (box.min[k] - origin[k]) / ray[k],
      b = (box.max[k] - origin[k]) / ray[k],
      low = Math.min(a, b),
      high = Math.max(a, b);
    if (low > near) {
      near = low;
      axis = k;
    }
    far = Math.min(far, high);
  }
  return near <= far && far > 0 ? { near, far, axis } : undefined;
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const scene = await page.evaluate(() => window.check.scene());
  const images = {},
    states = {};
  for (const state of ['virtual', 'cascades', 'open', 'dark']) {
    states[state] = await page.evaluate((s) => window.check.show(s), state);
    assert.deepEqual(states[state].errors, [], state);
    images[state] = await decodePNG(
      await page.locator('canvas').screenshot({ path: `test-results/virtual-sampling-${state}.png` }),
    );
  }
  const { width: W, height: H } = images.virtual,
    L = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, luma(v)]));
  const visibility = (state, p) => (L[state][p] - L.dark[p]) / (L.open[p] - L.dark[p]);
  // The expected mask: 1 lit, 0 shadowed, -1 sky or a face turned from the sun. `surface` tells surfaces apart.
  const { position: e, target: t, fov, sun, box, floor } = scene,
    forward = norm(sub(t, e)),
    right = norm(cross(forward, [0, 1, 0])),
    up = cross(right, forward),
    tan = Math.tan((fov * Math.PI) / 360),
    mask = new Int8Array(W * H).fill(-1),
    surface = new Int8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = (((x + 0.5) / W) * 2 - 1) * tan * (W / H),
        sy = (1 - ((y + 0.5) / H) * 2) * tan,
        ray = norm([0, 1, 2].map((k) => forward[k] + sx * right[k] + sy * up[k])),
        p = y * W + x,
        hit = slab(e, ray, box);
      let point, normal;
      if (hit) {
        point = e.map((v, k) => v + ray[k] * hit.near);
        normal = [0, 0, 0];
        normal[hit.axis] = -Math.sign(ray[hit.axis]);
        surface[p] = 2 + hit.axis;
      } else {
        const s = -e[1] / ray[1];
        if (s <= 0) continue;
        point = e.map((v, k) => v + ray[k] * s);
        if (Math.abs(point[0]) > floor || Math.abs(point[2]) > floor) continue;
        normal = [0, 1, 0];
        surface[p] = 1;
      }
      if (dot(normal, sun) <= 0.02) continue;
      const from = point.map((v, k) => v + normal[k] * 1e-4),
        shade = slab(from, sun, box);
      mask[p] = shade && shade.far > 1e-3 && shade.near >= -1e-3 ? 0 : 1;
    }
  // Pixels within BAND of a change of mask or surface are not judged.
  const judged = (x, y) => {
    const p = y * W + x;
    if (mask[p] < 0) return false;
    for (let j = -BAND; j <= BAND; j++)
      for (let i = -BAND; i <= BAND; i++) {
        const u = x + i,
          v = y + j;
        if (u < 0 || v < 0 || u >= W || v >= H) continue;
        const q = v * W + u;
        if (mask[q] !== mask[p] || surface[q] !== surface[p]) return false;
      }
    return true;
  };
  let pixels = 0,
    shaded = 0,
    agreeMask = 0,
    agreeCascades = 0,
    cascadesMask = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!judged(x, y)) continue;
      const p = y * W + x,
        v = visibility('virtual', p) > 0.5 ? 1 : 0,
        c = visibility('cascades', p) > 0.5 ? 1 : 0;
      pixels++;
      if (!mask[p]) shaded++;
      if (v === mask[p]) agreeMask++;
      if (v === c) agreeCascades++;
      if (c === mask[p]) cascadesMask++;
    }
  const result = {
    pixels,
    shaded,
    agreementWithMask: +(agreeMask / pixels).toFixed(5),
    agreementWithCascades: +(agreeCascades / pixels).toFixed(5),
    cascadesWithMask: +(cascadesMask / pixels).toFixed(5),
    stats: states.virtual.stats,
    memoryBytes: states.virtual.memory,
    pageErrors,
  };
  console.log(JSON.stringify(result));
  await writeFile('test-results/virtual-sampling.json', JSON.stringify(result, null, 2));
  assert.deepEqual(pageErrors, []);
  assert.ok(pixels > 200000 && shaded > 5000, `too few measured pixels: ${JSON.stringify(result)}`);
  assert.ok(states.virtual.stats.pagesRendered > 0, 'no page rendered');
  assert.ok(result.agreementWithMask >= AGREEMENT, `mask agreement ${result.agreementWithMask}`);
  assert.ok(result.agreementWithCascades >= AGREEMENT, `cascades agreement ${result.agreementWithCascades}`);
  console.log('shadows virtual sampling: ok');
} finally {
  await context.close?.();
  await release?.();
}
