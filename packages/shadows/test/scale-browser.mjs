// Real-GPU regression test: default Shadows give every model scale its shadow (`npm run test:gpu` in packages/shadows,
// also with MARGO_COMPAT=1 for the WebGL2 layer). Known bug it guards (docs/known-bugs.md, fixed 2026-11-11): a model a
// few centimetres across, the Khronos BoomBox among them, cast no visible shadow at the default settings. Three defaults
// were fixed world lengths: a model (loadGLTF, materials' createMesh) never fitted the cascades, so they spanned 0.1 to
// 500 m with 6 cm texels; the depth bias was 0.0005 of a depth range of 200 m or more (0.1 m) and the normal offset
// 0.02 m, both larger than the model; and the 500 m distance left a model framed from kilometres unshadowed. On that
// code check 1 fails at 1 mm, 2 cm and 2 cm with the default camera (no pixel of the umbra dark), check 2 at 1 m (56
// lit pixels darkened) and check 3 finds no BoomBox shadow pixel; test/scale.test.js covers the 1 km distance.
// Scene (scale.html): a sphere resting on a floor 20 diameters across, the whole scene built at 1 mm, 2 cm, 1 m, 100 m
// and 1 km, the camera's near and far in proportion; the sphere at 2 cm with core's default camera (near 0.1 m); and the
// BoomBox at its own size framed as the loading-gltf guide frames it.
//  1. Umbra stays dark: floor pixels inside the sphere's geometric shadow by more than EDGE_BAND diameters keep at most
//     UMBRA_MAX of their sunlight, and there are at least MIN_UMBRA of them.
//  2. Lit stays lit: floor pixels outside it by more than EDGE_BAND diameters keep at least LIT_MIN (no acne).
//  3. BoomBox: at least MIN_BOOMBOX floor pixels keep under half their sunlight (its shadow shows).
// Visibility per pixel is (soft - dark) / (open - dark) in linear light from three renders of the same frame.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/scale-browser.mjs
// (--soft={"distance":40} adds options to the soft frame, for bisecting). Writes test-results/shadows-scale.json and
// test-results/shadows-scale-<case>.png (the soft frame).
// --virtual runs the same cases with default VirtualShadows (writes shadows-virtual-scale*). Known bug it guards
// (docs/known-bugs.md, fixed 2026-11-11): its 0.002 m depth bias, 0.02 m normal offset and 500 m reach were fixed world
// lengths, with level 0 texels of 4.4 mm.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const EDGE_BAND = 0.15,
  UMBRA_MAX = 0.15,
  LIT_MIN = 0.85,
  MIN_UMBRA = 400,
  MIN_LIT = 20000,
  MIN_BOOMBOX = 150;
const CASES = [
  { name: '1mm', scale: 0.001, camera: 'scaled' },
  { name: '2cm', scale: 0.02, camera: 'scaled' },
  { name: '1m', scale: 1, camera: 'scaled' },
  { name: '100m', scale: 100, camera: 'scaled' },
  { name: '1km', scale: 1000, camera: 'scaled' },
  { name: '2cm-default-camera', scale: 0.02, camera: 'default' },
  { name: 'boombox', camera: 'default', model: 'boombox' },
];

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const virtual = process.argv.includes('--virtual'),
  name = virtual ? 'shadows-virtual-scale' : 'shadows-scale';
await mkdir('test-results', { recursive: true });
const release = await acquire({ owner: name });
const context = await openBrowser({ startPath: `/packages/shadows/test/scale.html${virtual ? '?virtual' : ''}`, port: virtual ? 5403 : 5402 }),
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
const results = {};
const options = JSON.parse(process.argv.find((a) => a.startsWith('--soft='))?.slice(7) ?? '{}');
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const c of CASES) {
    const scene = await page.evaluate((o) => window.check.setup(o), c);
    const L = {};
    let W = 0,
      H = 0;
    for (const state of ['soft', 'open', 'dark']) {
      assert.deepEqual(await page.evaluate(([s, o]) => window.check.show(s, o), [state, options]), [], `${c.name} ${state}`);
      const png = await page
        .locator('canvas')
        .screenshot(state === 'soft' ? { path: `test-results/${name}-${c.name}.png` } : {});
      const image = await decodePNG(png);
      L[state] = luma(image);
      W = image.width;
      H = image.height;
    }
    const { position: e, target: t, fov, sun, sphere, size, floor } = scene;
    const V = L.soft.map((v, p) => (L.open[p] - L.dark[p] > 0.02 ? (v - L.dark[p]) / (L.open[p] - L.dark[p]) : NaN));
    const forward = norm(sub(t, e)),
      right = norm(cross(forward, [0, 1, 0])),
      up = cross(right, forward),
      tan = Math.tan((fov * Math.PI) / 360),
      aspect = W / H;
    let umbra = 0,
      umbraLit = 0,
      lit = 0,
      darkened = 0,
      shaded = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (Number.isNaN(V[p])) continue;
        const sx = (((x + 0.5) / W) * 2 - 1) * tan * aspect,
          sy = (1 - ((y + 0.5) / H) * 2) * tan,
          ray = norm([0, 1, 2].map((k) => forward[k] + sx * right[k] + sy * up[k]));
        if (ray[1] >= 0) continue;
        const s = -e[1] / ray[1],
          q = [e[0] + ray[0] * s, 0, e[2] + ray[2] * s];
        // Floor pixels only, away from the floor's edge.
        if (Math.abs(q[0]) > floor * 0.95 || Math.abs(q[2]) > floor * 0.95) continue;
        if (!sphere) {
          if (V[p] < 0.5) shaded++;
          continue;
        }
        // Not hidden by the sphere from the camera.
        const oc = sub(e, sphere.center),
          b = dot(oc, ray),
          disc = b * b - (dot(oc, oc) - sphere.radius ** 2);
        if (disc > 0 && -b - Math.sqrt(disc) < s) continue;
        // Signed distance from the sphere's geometric shadow edge, in diameters, negative inside.
        const to = sub(sphere.center, q),
          distance = Math.hypot(...to),
          angle = Math.acos(Math.min(1, dot(sun, to) / distance)),
          signed = ((angle - Math.asin(Math.min(1, sphere.radius / distance))) * distance) / size;
        if (signed < -EDGE_BAND) {
          umbra++;
          if (V[p] > UMBRA_MAX) umbraLit++;
        } else if (signed > EDGE_BAND) {
          lit++;
          if (V[p] < LIT_MIN) darkened++;
        }
      }
    results[c.name] = sphere ? { umbra, umbraLit, lit, darkened } : { shaded };
    console.log(c.name, JSON.stringify(results[c.name]));
  }
  await writeFile(`test-results/${name}.json`, JSON.stringify({ results, pageErrors }, null, 2));
  assert.deepEqual(pageErrors, []);
  for (const c of CASES) {
    const r = results[c.name];
    if (c.model === 'boombox') {
      assert.ok(r.shaded >= MIN_BOOMBOX, `${c.name}: only ${r.shaded} floor pixels in shadow, the model casts none`);
      continue;
    }
    assert.ok(r.umbra >= MIN_UMBRA && r.lit >= MIN_LIT, `${c.name}: too few measured pixels: ${JSON.stringify(r)}`);
    assert.equal(r.umbraLit, 0, `${c.name}: ${r.umbraLit} of ${r.umbra} pixels inside the sphere's shadow were lit`);
    assert.equal(r.darkened, 0, `${c.name}: ${r.darkened} of ${r.lit} clearly lit floor pixels lost sunlight`);
  }
  console.log(`${name}: ok`);
} finally {
  await context.close?.();
  await release?.();
}
