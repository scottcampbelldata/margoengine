// Real-GPU check that create3MFMesh draws a 3MF multiproperties stack: the 3MF Consortium's multiprop-opaque.3mf, a
// #0090FF colour group under Star.png and Smiley.png, both mixed by their alpha (3MF Materials and Properties Extension
// 1.2.1, chapter 5: rgb = new.rgb * new.a + below.rgb * (1 - new.a), in linear light). The front face fills the canvas,
// unlit. Where both images are flat over the area one pixel samples, so filtering cannot move the value, the pixel must
// be the layers blended on the CPU from the images' own texels, within 3 of 255. Every kind of overlap must be met:
// the colour alone, the star over it and the smiley over the star (the smiley lies inside the star). WebGPU must report no
// validation error. Run from the repository root after building packages, natively and with MARGO_COMPAT=1:
//   node packages/loaders/tests/threemf-layers-gpu-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const compat = compatRun(),
  size = 128;
const context = await openBrowser({ startPath: '/packages/loaders/tests/threemf-layers-gpu.html', port: 5294 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
  encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const { layers, materials, textures, images } = await page.evaluate(() => window.check.draw());
  assert.deepEqual(
    layers.map((l) => [l.kind, l.blend, l.texture]),
    [
      ['color', 'mix', undefined],
      ['texture', 'mix', 0],
      ['texture', 'mix', 1],
    ],
  );
  assert.equal(materials, 2);
  assert.equal(textures, 2);
  const png = await page.locator('#a').screenshot();
  if (process.env.MARGO_SHOT) (await import('node:fs')).writeFileSync(process.env.MARGO_SHOT, png);
  const shot = await decodePNG(png);
  assert.equal(shot.width, size);
  const base = [0, 0x90 / 255, 1].map(decode),
    met = { color: 0, star: 0, smiley: 0, both: 0 };
  let checked = 0;
  for (let py = 2; py < size - 2; py += 3)
    for (let px = 2; px < size - 2; px += 3) {
      // The texel under the pixel's centre in each image, if the image is flat over the pixel's whole footprint.
      const texel = ({ width, height, data }) => {
        const x = Math.floor(((px + 0.5) / size) * width),
          y = Math.floor(((py + 0.5) / size) * height),
          r = Math.ceil((2 * width) / size) + 1,
          at = (i, j) => data.slice((j * width + i) * 4, (j * width + i) * 4 + 4).join();
        for (let j = y - r; j <= y + r; j++)
          for (let i = x - r; i <= x + r; i++)
            if (i < 0 || j < 0 || i >= width || j >= height || at(i, j) !== at(x, y)) return undefined;
        return data.slice((y * width + x) * 4, (y * width + x) * 4 + 4);
      };
      const star = texel(images[0]),
        smiley = texel(images[1]);
      if (!star || !smiley) continue;
      let out = base;
      for (const t of [star, smiley]) {
        const a = t[3] / 255;
        out = out.map((below, c) => decode(t[c] / 255) * a + below * (1 - a));
      }
      const want = out.map((v) => Math.round(encode(v) * 255)),
        got = [...shot.data.slice((py * size + px) * 4, (py * size + px) * 4 + 3)];
      assert.ok(
        got.every((v, c) => Math.abs(v - want[c]) <= 3),
        `pixel ${px},${py}${compat ? ' (compat)' : ''}: ${got} should be ${want} (star ${star}, smiley ${smiley})`,
      );
      checked++;
      const s = star[3] > 0,
        m = smiley[3] > 0;
      met[s && m ? 'both' : m ? 'smiley' : s ? 'star' : 'color']++;
    }
  console.log(`3MF layered textures${compat ? ' (compat)' : ''}: ${checked} pixels`, JSON.stringify(met));
  for (const kind of ['color', 'star', 'both']) assert.ok(met[kind] >= 3, `too few ${kind} pixels: ${met[kind]}`);
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
console.log('3MF layered textures draw check passed');
