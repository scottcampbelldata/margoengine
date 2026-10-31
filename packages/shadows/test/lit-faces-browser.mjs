// Real-GPU regression test of the soft (PCSS) filter with default settings (`npm run test:gpu` in packages/shadows,
// part of `npm run check:gpu-packages`). Scene: the animation guide's skinned RobotExpressive on a sun-facing floor plus a
// sphere (lit-faces.html), at the guide's 1280 x 720. Known bug it guards (docs/known-bugs.md, closed 2026-10-27):
// the blocker search reached casterMargin (100 units) past the scene, so its 16 reads spread over about 46 texels,
// missed the blocker right above the receiver (bright dots in the head's shadow on the robot's chest, in the sphere's
// umbra) and read surfaces behind the receiver as blockers (wide false penumbrae): a speckled chest and a dotted
// ground-shadow edge. On that code this test fails checks 1 (shade), 2 and 3.
//  1. Lit stays lit: every pixel the geometric reference leaves lit, with no reference shadow within LIT_MARGIN px,
//     keeps at least LIT_MIN of its sunlight under the default soft filter. Shade stays shade: every pixel deep in a
//     reference shadow (no reference light within LIT_MARGIN px) keeps at most SHADE_MAX of its sunlight. LIT_MARGIN
//     is the default map's filter reach: its first cascade's texels are 0.079 units, the soft filter reads at least
//     one texel out with a 2x2 compare, and two texels span up to 16 px on the nearest floor.
//  2. Umbra stays dark: floor pixels inside the sphere's shadow by more than EDGE_BAND get at most UMBRA_MAX.
//  3. Smooth edge: across the sphere's shadow edge on the floor, the visibility's departure from its own 5x5 mean (dots
//     and speckle; a smooth ramp has none) stays under EDGE_NOISE (RMS).
// Visibility per pixel is (soft - dark) / (open - dark) in linear light from four renders of the same frame.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/lit-faces-browser.mjs
// Writes test-results/<name>.json and test-results/<name>-*.png, <name> being shadows-lit-faces.
// --page=virtual runs the same scene and thresholds on VirtualShadows (virtual-lit-faces.html, name virtual-lit-faces).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const LIT_MARGIN = 16,
  LIT_MIN = 0.85,
  EDGE_BAND = 0.25,
  UMBRA_MAX = 0.15,
  EDGE_NOISE = 0.06,
  SHADE_MAX = 0.5;

// The dev server serves the repository root, whichever folder the script starts in.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const virtualPort = 5273,
  plainPort = 5267,
  virtual = process.argv.includes('--page=virtual'),
  name = virtual ? 'virtual-lit-faces' : 'shadows-lit-faces';
const release = await acquire({ owner: name });
const context = await openBrowser({
    startPath: `/packages/shadows/test/${virtual ? 'virtual-' : ''}lit-faces.html`,
    port: virtual ? virtualPort : plainPort,
  }),
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
const shot = async (state, options) => {
  assert.deepEqual(await page.evaluate(([s, o]) => window.check.show(s, o), [state, options]), [], state);
  return decodePNG(await page.locator('canvas').screenshot({ path: `test-results/${name}-${state}.png` }));
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const scene = await page.evaluate(() => window.check.scene());
  const images = {};
  // --soft={"cascades":1} adds options to the soft frame (for bisecting); the test itself uses the defaults.
  const options = JSON.parse(process.argv.find((a) => a.startsWith('--soft='))?.slice(7) ?? '{}');
  for (const state of ['soft', 'reference', 'open', 'dark']) images[state] = await shot(state, options);
  const { width: W, height: H } = images.soft;
  const L = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, luma(v)]));
  // Visibility where the sun adds a clear amount of light (not on faces turned from the sun or the background).
  const vis = (state) =>
    L[state].map((v, p) => (L.open[p] - L.dark[p] > 0.02 ? (v - L.dark[p]) / (L.open[p] - L.dark[p]) : NaN));
  const V = vis('soft'),
    R = vis('reference');
  // Whether any reference pixel within LIT_MARGIN of (x, y) passes `test` (prefix sums over the mask).
  const near = (test) => {
    const sum = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        sum[(y + 1) * (W + 1) + x + 1] =
          (test(R[y * W + x]) ? 1 : 0) + sum[y * (W + 1) + x + 1] + sum[(y + 1) * (W + 1) + x] - sum[y * (W + 1) + x];
    return (x, y) => {
      const x0 = Math.max(0, x - LIT_MARGIN),
        y0 = Math.max(0, y - LIT_MARGIN),
        x1 = Math.min(W, x + LIT_MARGIN + 1),
        y1 = Math.min(H, y + LIT_MARGIN + 1);
      return sum[y1 * (W + 1) + x1] - sum[y0 * (W + 1) + x1] - sum[y1 * (W + 1) + x0] + sum[y0 * (W + 1) + x0] > 0;
    };
  };
  const nearShade = near((r) => r < 0.98),
    nearLight = near((r) => r > 0.5);
  // A pixel on or beside an outline or facet edge (its unshadowed light differs from a neighbour's by over 15%) mixes
  // two surfaces, often far apart in the world: neither frame can say which part of it should be lit.
  const outline = (x, y) => {
    for (let j = -2; j <= 2; j++)
      for (let i = -2; i <= 2; i++) {
        const a = L.open[Math.min(H - 1, Math.max(0, y + j)) * W + Math.min(W - 1, Math.max(0, x + i))];
        for (const [u, v] of [
          [1, 0],
          [0, 1],
        ]) {
          const b = L.open[Math.min(H - 1, Math.max(0, y + j + v)) * W + Math.min(W - 1, Math.max(0, x + i + u))];
          if (Math.abs(a - b) > 0.15 * Math.max(a, b)) return true;
        }
      }
    return false;
  };
  let litPixels = 0,
    darkened = 0,
    worst = 1,
    shadePixels = 0,
    leaked = 0;
  const marks = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      marks.set([...images.soft.data.subarray(p * 4, p * 4 + 3), 255], p * 4);
      if (Number.isNaN(V[p]) || Number.isNaN(R[p]) || outline(x, y)) continue;
      // 1b. Shade stays shade: deep in a reference shadow (no reference light within LIT_MARGIN) the soft filter keeps
      // at most SHADE_MAX of the sunlight.
      if (R[p] <= 0.05 && !nearLight(x, y)) {
        shadePixels++;
        if (V[p] > SHADE_MAX) {
          leaked++;
          marks.set([0, 255, 0, 255], p * 4);
        }
        continue;
      }
      if (R[p] < 0.98 || nearShade(x, y)) continue;
      litPixels++;
      worst = Math.min(worst, V[p]);
      if (V[p] < LIT_MIN) {
        darkened++;
        marks.set([255, 0, 255, 255], p * 4);
      }
    }
  // 2 and 3. Floor pixels around the sphere's shadow: cast the pixel's ray onto y = 0, then the signed distance (world
  // units, negative inside) from the sphere's geometric shadow edge: (angle to the sphere's centre - its angular radius)
  // times the distance to it, measured from the floor point.
  const { position: e, target: t, fov, sun, sphere } = scene;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    norm = (a) => {
      const l = Math.hypot(...a);
      return [a[0] / l, a[1] / l, a[2] / l];
    },
    cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const forward = norm(sub(t, e)),
    right = norm(cross(forward, [0, 1, 0])),
    up = cross(right, forward),
    tan = Math.tan((fov * Math.PI) / 360),
    aspect = W / H;
  const edge = new Float32Array(W * H).fill(NaN);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = (((x + 0.5) / W) * 2 - 1) * tan * aspect,
        sy = (1 - ((y + 0.5) / H) * 2) * tan,
        ray = [0, 1, 2].map((k) => forward[k] + sx * right[k] + sy * up[k]);
      if (ray[1] >= 0) continue;
      const s = -e[1] / ray[1],
        p = [e[0] + ray[0] * s, 0, e[2] + ray[2] * s];
      if (Math.abs(p[0]) > 3.9 || Math.abs(p[2]) > 3.9) continue;
      const to = sub(sphere.center, p),
        distance = Math.hypot(...to),
        angle = Math.acos(Math.min(1, dot(sun, to) / distance));
      // Only floor pixels the sphere's shadow can reach, and not hidden by the sphere itself.
      const r = angle - Math.asin(sphere.radius / distance);
      if (r * distance > 0.8 || images.open.data[(y * W + x) * 4] - images.open.data[(y * W + x) * 4 + 1] > 25)
        continue;
      edge[y * W + x] = r * distance;
    }
  let umbraPixels = 0,
    umbraLit = 0,
    bandPixels = 0,
    noise = 0;
  for (let y = 2; y < H - 2; y++)
    for (let x = 2; x < W - 2; x++) {
      const p = y * W + x,
        signed = edge[p];
      if (Number.isNaN(signed) || Number.isNaN(V[p])) continue;
      if (signed < -EDGE_BAND) {
        umbraPixels++;
        if (V[p] > UMBRA_MAX) {
          umbraLit++;
          marks.set([0, 255, 255, 255], p * 4);
        }
      } else if (signed < EDGE_BAND) {
        let mean = 0,
          n = 0;
        for (let j = -2; j <= 2; j++)
          for (let i = -2; i <= 2; i++) {
            const q = p + j * W + i;
            if (Number.isNaN(V[q]) || Number.isNaN(edge[q])) continue;
            mean += V[q];
            n++;
          }
        if (n < 20) continue;
        bandPixels++;
        noise += (V[p] - mean / n) ** 2;
      }
    }
  const result = {
    litPixels,
    darkened,
    worstLit: +worst.toFixed(3),
    shadePixels,
    leaked,
    umbraPixels,
    umbraLit,
    bandPixels,
    edgeNoise: +Math.sqrt(noise / Math.max(1, bandPixels)).toFixed(4),
    pageErrors,
  };
  console.log(JSON.stringify(result));
  await writeFile(`test-results/${name}.json`, JSON.stringify(result, null, 2));
  // The soft frame with failing pixels marked: magenta lit pixels that lost light, green shade that kept light, cyan
  // sphere-umbra pixels left lit.
  await sharp(marks, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(`test-results/${name}-marks.png`);
  assert.deepEqual(pageErrors, []);
  assert.ok(
    litPixels > 20000 && shadePixels > 2000 && umbraPixels > 500 && bandPixels > 500,
    `too few measured pixels: ${JSON.stringify(result)}`,
  );
  assert.equal(
    darkened,
    0,
    `${darkened} clearly lit pixels lost sunlight under the soft filter (worst ${result.worstLit})`,
  );
  assert.equal(leaked, 0, `${leaked} pixels deep in a reference shadow kept over ${SHADE_MAX} of their sunlight`);
  assert.equal(umbraLit, 0, `${umbraLit} pixels inside the sphere's umbra were lit`);
  assert.ok(result.edgeNoise < EDGE_NOISE, `the sphere's shadow edge is speckled: RMS ${result.edgeNoise}`);
  console.log(`${name}: ok`);
} finally {
  await context.close?.();
  await release?.();
}
