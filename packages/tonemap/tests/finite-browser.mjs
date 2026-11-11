// Real-GPU check (Rust engine port R3): Tonemap reads non-finite HDR input as Bloom does, +Inf as 65504 and NaN and
// -Inf as 0, so one bad texel stays one pixel. A 320 x 240 linear source (a grey ramp) with +Inf, -Inf and NaN texels
// is presented with and without LocalExposure (whose quarter-resolution base and bilateral blur would carry a NaN
// across its region), and compared with the same source where the bad texels already hold those values: the two
// frames must be identical in every pixel.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

const W = 320,
  H = 240,
  BAD = [
    [40, 40, Infinity, 65504],
    [160, 120, NaN, 0],
    [161, 120, -Infinity, 0],
    [280, 200, NaN, 0],
  ];

await postBrowser(
  'tonemap-finite',
  5398,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(
      async ([W, H, bad]) => {
        const { Engine } = await import('/packages/core/dist/index.js'),
          { Tonemap } = await import('/packages/tonemap/dist/index.js'),
          { LocalExposure } = await import('/packages/tonemap/dist/local.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, { backend: 'webgpu' }),
          device = engine.gpu;
        engine.stop();
        const texture = (dirty) => {
          const data = new Float32Array(W * H * 4);
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) data.set([(x / W) * 2, (y / H) * 2, 0.18, 1], 4 * (y * W + x));
          // JSON carries NaN and the infinities as null, so they travel as strings.
          for (const [x, y, value, clean] of bad) {
            const v = dirty ? Number(value) : clean;
            data.set([v, v, v], 4 * (y * W + x));
          }
          const t = device.createTexture({
            size: [W, H],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          device.queue.writeTexture({ texture: t }, data, { bytesPerRow: W * 16 }, [W, H]);
          return t;
        };
        const sources = { dirty: texture(true), clean: texture(false) },
          local = new LocalExposure();
        window.t = { engine, local, which: 'dirty' };
        window.t.tonemap = Tonemap.attach(engine, { source: () => sources[window.t.which] });
      },
      [W, H, BAD.map(([x, y, v, c]) => [x, y, String(v), c])],
    );
    const frame = async (which, extensions) => {
      await page.evaluate(
        ([which, extensions]) => {
          window.t.which = which;
          window.t.tonemap.options.extensions = extensions ? [window.t.local] : [];
          window.t.engine.render({ delta: 1 / 60 });
          return window.t.engine.gpu.queue.onSubmittedWorkDone();
        },
        [which, extensions],
      );
      return shot();
    };
    const differ = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
      return n;
    };
    const plain = differ(await frame('dirty', false), await frame('clean', false)),
      local = differ(await frame('dirty', true), await frame('clean', true));
    await page.evaluate(() => (window.t.local.dispose(), window.t.engine.dispose()));
    console.log(JSON.stringify({ plain, local }));
    assert.equal(plain, 0, `Tonemap: non-finite texels present as their clean values (${plain} bytes differ)`);
    assert.equal(local, 0, `LocalExposure: one bad texel does not spread (${local} bytes differ)`);
  },
);
