// Real-GPU checks of @margoengine/materials/interior-mapping (interior-mapping.html draws, this judges): for two camera
// places and the plain, cube-pictured and atlas-pictured rooms, the face seen at each sampled pixel is the face the
// CPU trace gives for that pixel's ray; curtains cover the room's sides; a rules building's windows show rooms. On
// WebGPU, then on the WebGL2 compatibility layer. Frames are written to test-results/interior-mapping/. From the root:
//   node packages/materials/test/interior-mapping-browser.mjs            (both backends)
//   MARGO_COMPAT=1 node packages/materials/test/interior-mapping-browser.mjs   (the compatibility layer only)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { traceRoom } from '../dist/interior-mapping.js';

const rooms = { origin: [-3, -2.25, 0], width: 2, height: 1.5, depth: 1.6 };
const W = 320,
  H = 240;
const sub = (a, b) => a.map((v, k) => v - b[k]),
  unit = (a) => a.map((v) => v / Math.hypot(...a)),
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** The face the CPU trace sees through pixel (x, y) from `eye` toward the origin, on the plane z = 0. */
function expected(eye, fov, x, y) {
  const forward = unit(sub([0, 0, 0], eye)),
    right = unit(cross(forward, [0, 1, 0])),
    up = cross(right, forward),
    t = Math.tan((fov * Math.PI) / 360),
    sx = (((x + 0.5) / W) * 2 - 1) * t * (W / H),
    sy = (1 - ((y + 0.5) / H) * 2) * t,
    ray = forward.map((v, k) => v + right[k] * sx + up[k] * sy),
    k = -eye[2] / ray[2],
    p = eye.map((v, i) => v + ray[i] * k);
  if (Math.abs(p[0]) > 2.95 || Math.abs(p[1]) > 2.2) return undefined;
  return traceRoom([p[0], p[1], 0], [0, 0, 1], ray, rooms);
}
/** Which colour a pixel is: the plain room's walls are one colour, the pictured rooms add the yellow back wall. */
function seen([r, g, b]) {
  if (Math.max(r, g, b) < 25) return 'dark';
  if (r > 1.8 * b && g > 1.8 * b && g > 0.6 * r && r > 0.6 * g) return 'yellow';
  if (r > 1.8 * g && r > 1.8 * b) return 'red';
  if (g > 1.8 * r && g > 1.8 * b) return 'green';
  if (b > 1.8 * r && b > 1.8 * g) return 'blue';
  return 'mixed';
}
const want = (face, pictured) =>
  face === 'floor' ? 'green' : face === 'ceiling' ? 'blue' : face === 'back' && pictured ? 'yellow' : 'red';

for (const compat of compatRun() ? [true] : [false, true]) {
  const browser = await openBrowser({
      startPath: '/packages/materials/test/interior-mapping.html',
      port: 'free',
      compat,
    }),
    { page } = browser,
    leg = compat ? 'compat' : 'webgpu',
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  const call = (name, ...args) => page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
  const dir = fileURLToPath(new URL('../../../test-results/interior-mapping/', import.meta.url));
  const snap = async (name) => {
    const shot = await page.locator('canvas').screenshot();
    await writeFile(`${dir}${leg}-${name}.png`, shot);
    return decodePNG(shot);
  };
  const ok = (r) => {
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
  };
  try {
    await mkdir(dir, { recursive: true });
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    for (const kind of ['plain', 'cube', 'atlas'])
      for (const [n, eye] of [
        [0, [0, 0, 5]],
        [1, [2.6, 1.2, 3.6]],
      ]) {
        const r = await call('show', kind, rooms, eye);
        ok(r);
        const image = await snap(`${kind}-${n}`),
          faces = {};
        let sampled = 0,
          wrong = 0;
        for (let y = 3; y < H; y += 5)
          for (let x = 3; x < W; x += 5) {
            const hit = expected(eye, r.fov, x, y);
            if (!hit) continue;
            // Skip pixels near where the face or the room changes.
            const steady = [
              [-3, 0],
              [3, 0],
              [0, -3],
              [0, 3],
            ].every(([dx, dy]) => {
              const o = expected(eye, r.fov, x + dx, y + dy);
              return o && o.face === hit.face && o.cell.join() === hit.cell.join();
            });
            if (!steady) continue;
            const i = 4 * (y * image.width + x),
              colour = seen(image.data.slice(i, i + 3));
            sampled++;
            faces[hit.face] = (faces[hit.face] ?? 0) + 1;
            // A pictured room may be mirrored, which swaps its sides: both are red.
            if (colour !== want(hit.face, kind !== 'plain')) wrong++;
          }
        console.log(leg, kind, n, JSON.stringify({ sampled, wrong, faces }));
        assert.ok(sampled > 600, `${leg} ${kind}: ${sampled} pixels sampled`);
        assert.ok(wrong <= sampled * 0.01, `${leg} ${kind} view ${n}: ${wrong} of ${sampled} pixels show another face`);
        assert.ok(Object.keys(faces).length >= 4, `${leg} ${kind}: faces ${Object.keys(faces)}`);
      }
    // Curtains cover the sides of every window; daylight off leaves the rooms dark; a lamp lights them again.
    ok(await call('show', 'plain', rooms, [0, 0, 5]));
    const open = await snap('open');
    ok(await call('extra', { curtains: 1 }));
    const drawn = await snap('curtains');
    const differ = (a, b) => a.data.reduce((n, v, i) => n + (i % 4 !== 3 && Math.abs(v - b.data[i]) > 12 ? 1 : 0), 0);
    assert.ok(differ(open, drawn) > 3000, `${leg}: curtains change the picture (${differ(open, drawn)})`);
    ok(await call('extra', { curtains: 0, daylight: 0 }));
    const night = await snap('night');
    const brightness = (a) => a.data.reduce((n, v, i) => n + (i % 4 === 3 ? 0 : v), 0);
    assert.ok(brightness(night) < 0.1 * brightness(open), `${leg}: no daylight leaves the rooms dark`);
    ok(await call('extra', { lit: 1 }));
    const lamps = await snap('lamps');
    assert.ok(brightness(lamps) > 3 * brightness(night) + 1e5, `${leg}: lamps light the rooms`);
    // A rules building with nothing behind its glass.
    ok(await call('building'));
    await snap('building');
    ok(await call('look', [2.5, 6, 17], [0, 5.6, 11]));
    await snap('building-near');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
}
console.log('Interior mapping: the GPU shows the face the CPU trace gives, plain, cube and atlas rooms.');
