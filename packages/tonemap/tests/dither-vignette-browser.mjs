// Real-GPU check, built packages, on WebGPU and the WebGL2 compatibility layer.
// Dither: a gradient spanning two 8-bit codes bands into flat columns without dithering, so each column's mean misses
// the exact encoded value by 0.25 code on average. With `dither: true` the triangular noise makes each column's mean
// (over 220 rows) land on the exact value, and a black strip stays exactly 0.
// Vignette: an opaque red vignette centred at a quarter of the width with roundness 1 must match the CPU formula
// pixel for pixel (within one code), be round (equal at equal pixel distance across and down) and leave its centre
// untouched; a multiply vignette with a colour tints instead of darkening.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

const W = 320,
  H = 240,
  BLACK_ROWS = 20,
  decode = (e) => (e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4),
  encode = (v) => {
    const c = Math.min(Math.max(v, 0), 1);
    return 255 * (c >= 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c);
  },
  // Exact encoded value of column x of the gradient, in codes: 100 to 102.
  ideal = (x) => 100 + (2 * (x + 0.5)) / W,
  smooth = (a, b, x) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
const VIG = { vignette: 1, vignetteRadius: 0.2, vignetteSoftness: 0.5, vignetteCenter: [0.25, 0.5], vignetteRoundness: 1 };
function vignetted(x, y, colour, opaque, grey) {
  const s = [(W * Math.SQRT2) / Math.hypot(W, H), (H * Math.SQRT2) / Math.hypot(W, H)],
    d = [((x + 0.5) / W - 0.25) * 2 * s[0], ((y + 0.5) / H - 0.5) * 2 * s[1]],
    v = smooth(0.2, 0.7, Math.hypot(d[0], d[1]) * Math.SQRT1_2);
  return colour.map((c) => encode(opaque ? grey + (c - grey) * v : grey * (1 + (c - 1) * v)));
}
const gradient = new Float32Array(W * H * 4),
  grey = new Float32Array(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const g = y < BLACK_ROWS ? 0 : decode(ideal(x) / 255);
    gradient.set([g, g, g, 1], 4 * (y * W + x));
    grey.set([0.2, 0.2, 0.2, 1], 4 * (y * W + x));
  }
const cases = [
  { name: 'banded', data: gradient, options: {} },
  { name: 'dithered', data: gradient, options: { dither: true } },
  { name: 'opaque', data: grey, options: { ...VIG, vignetteColor: [1, 0, 0], vignetteBlend: 'opaque' } },
  { name: 'multiply', data: grey, options: { ...VIG, vignetteColor: [0.5, 1, 1] } },
];
for (const compat of [false, true])
  await postBrowser(
    'tonemap-dither-vignette',
    5375,
    () => launchBrowser({ headless: true }),
    async (page, shot) => {
      const backend = compat ? 'webgl2-compat' : 'webgpu',
        images = {};
      for (const c of cases) {
        await page.evaluate(
          async ([W, H, compat, data, options]) => {
            if (!window.t) {
              if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
              const { Engine } = await import('/packages/core/dist/index.js'),
                engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
              engine.stop();
              const source = engine.gpu.createTexture({
                size: [W, H],
                format: 'rgba32float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
              });
              window.t = { engine, source };
            }
            const { Tonemap } = await import('/packages/tonemap/dist/index.js'),
              { engine, source } = window.t,
              device = engine.gpu;
            window.t.tonemap?.dispose();
            device.queue.writeTexture({ texture: source }, new Float32Array(data), { bytesPerRow: W * 16 }, [W, H]);
            window.t.tonemap = Tonemap.attach(engine, { source: () => source, curve: 'linear', ...options });
            engine.render({ delta: 1 / 60 });
            await device.queue.onSubmittedWorkDone();
          },
          [W, H, compat, Array.from(c.data), c.options],
        );
        images[c.name] = await shot();
      }
      await page.evaluate(() => (window.t.source.destroy(), window.t.engine.dispose()));
      for (const image of Object.values(images)) assert.deepEqual([image.width, image.height], [W, H], backend);
      const at = (image, x, y) => [0, 1, 2].map((k) => image.data[4 * (y * W + x) + k]);
      // Dither: mean distance of each column's mean from the exact encoded value.
      const columnError = (image) => {
        let sum = 0;
        for (let x = 0; x < W; x++) {
          let mean = 0;
          for (let y = BLACK_ROWS; y < H; y++) mean += at(image, x, y)[1];
          sum += Math.abs(mean / (H - BLACK_ROWS) - ideal(x));
        }
        return sum / W;
      };
      const banded = columnError(images.banded),
        dithered = columnError(images.dithered);
      let blackMax = 0;
      for (let y = 0; y < BLACK_ROWS; y++)
        for (let x = 0; x < W; x++) blackMax = Math.max(blackMax, ...at(images.dithered, x, y));
      console.log(JSON.stringify({ backend, banded, dithered, blackMax }));
      assert.ok(banded > 0.15, `${backend}: undithered columns band (${banded})`);
      assert.ok(dithered < 0.08, `${backend}: dithered column means land on the exact value (${dithered})`);
      assert.equal(blackMax, 0, `${backend}: black stays exactly black`);
      // Vignette.
      const cx = W / 4,
        cy = H / 2;
      for (const [name, colour, opaque] of [
        ['opaque', [1, 0, 0], true],
        ['multiply', [0.5, 1, 1], false],
      ]) {
        const image = images[name];
        for (const [x, y] of [
          [cx, cy],
          [cx + 50, cy],
          [cx, cy + 50],
          [cx + 120, cy - 60],
          [W - 1, 0],
          [W - 1, H - 1],
        ]) {
          const want = vignetted(x, y, colour, opaque, 0.2),
            got = at(image, x, y);
          for (let k = 0; k < 3; k++)
            assert.ok(Math.abs(got[k] - want[k]) <= 1.01, `${backend} ${name} (${x},${y}): ${got} against ${want}`);
        }
        const across = at(image, cx + 50, cy),
          down = at(image, cx, cy + 50);
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(across[k] - down[k]) <= 1, `${backend} ${name}: round (${across} against ${down})`);
      }
      assert.deepEqual(at(images.opaque, W - 1, H - 1), [255, 0, 0], `${backend}: the far corner is the colour`);
    },
  );
