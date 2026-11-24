// Real-GPU check of the white point, toe and shoulder, built packages, on WebGPU and the WebGL2 compatibility layer: a ramp
// of grey from 0 to 8 (scene-linear) goes through Tonemap's neutral curve.
//   - The options at their defaults draw exactly what no options draw (every channel of every pixel).
//   - The white point lands on sRGB code 255 at the ramp column whose value it is, and stays there above it; the curve
//     below it is the plain curve divided by its value there (within one code).
//   - The toe and the shoulder give the spline of `shapeCurve` over the plain curve (within one code), and the three
//     together do the same in order.
// Run: npm run test:settings:browser (it runs this beside the settings check).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';
import { shapeCurve } from '../dist/index.js';

const W = 320,
  H = 240,
  RAMP = 8,
  column = 159,
  white = ((column + 0.5) / W) * RAMP;
const decode = (code) => {
  const c = code / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const encode = (v) => Math.round(255 * (v < 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
for (const compat of [false, true])
  await postBrowser(
    'tonemap-shape',
    5441,
    () => launchBrowser({ headless: true }),
    async (page, shot) => {
      await page.evaluate(
        async ([W, H, RAMP, compat]) => {
          if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
          const { Engine } = await import('/packages/core/dist/index.js'),
            { Tonemap } = await import('/packages/tonemap/dist/index.js');
          const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' }),
            device = engine.gpu;
          engine.stop();
          const data = new Float32Array(W * H * 4);
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              const v = ((x + 0.5) / W) * RAMP;
              data.set([v, v, v, 1], 4 * (y * W + x));
            }
          const source = device.createTexture({
            size: [W, H],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          device.queue.writeTexture({ texture: source }, data, { bytesPerRow: W * 16 }, [W, H]);
          const tonemap = Tonemap.attach(engine, { source: () => source });
          window.t = { engine, tonemap, device, source };
          window.t.draw = async (options) => {
            for (const key of ['whitePoint', 'toe', 'shoulder', 'curve']) delete tonemap.options[key];
            Object.assign(tonemap.options, options);
            const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
            await waitForPipelines(async () => {
              engine.render({ delta: 1 / 60 });
              await device.queue.onSubmittedWorkDone();
            });
            engine.render({ delta: 1 / 60 });
            await device.queue.onSubmittedWorkDone();
          };
        },
        [W, H, RAMP, compat],
      );
      const frame = async (options) => {
        await page.evaluate((o) => window.t.draw(o), options);
        const image = await shot();
        // The grey code of each column (the rows are alike).
        const row = new Array(W);
        for (let x = 0; x < W; x++) row[x] = image.data[4 * (120 * W + x)];
        return { image, row };
      };
      const plain = await frame({});
      const same = await frame({ whitePoint: 0, toe: 1, shoulder: 1 });
      let differ = 0;
      for (let i = 0; i < plain.image.data.length; i++) if (plain.image.data[i] !== same.image.data[i]) differ++;
      assert.equal(differ, 0, 'options at their defaults draw the frame exact');
      const worst = (got, expected) => Math.max(...got.map((c, x) => Math.abs(c - expected[x])));
      const expected = (toe, shoulder, w) =>
        plain.row.map((c) => {
          const lin = decode(c) / (w ? decode(plain.row[column]) : 1);
          return encode(shapeCurve(Math.min(1, lin), toe, shoulder));
        });
      const results = {};
      for (const [name, options, args] of [
        ['whitePoint', { whitePoint: white }, [1, 1, true]],
        ['toe', { toe: 0.4 }, [0.4, 1, false]],
        ['shoulder', { shoulder: 0.3 }, [1, 0.3, false]],
        ['all', { whitePoint: white, toe: 0.6, shoulder: 0.5 }, [0.6, 0.5, true]],
      ]) {
        const got = await frame(options);
        results[name] = { off: worst(got.row, expected(...args)), changed: got.row.filter((c, x) => c !== plain.row[x]).length };
        assert.ok(results[name].off <= 2, `${name}: the frame is the plain curve through the spline (${results[name].off} codes off)`);
        assert.ok(results[name].changed > 20, `${name} changes the frame`);
        if (name === 'whitePoint' || name === 'all') {
          assert.equal(got.row[column], 255, `${name}: the white point is 255`);
          assert.ok(got.row.slice(column).every((c) => c === 255), `${name}: brighter than the white point stays 255`);
          assert.ok(got.row[column - 80] < 255, `${name}: below the white point is under 255`);
        }
        for (let x = 1; x < W; x++) assert.ok(got.row[x] >= got.row[x - 1], `${name}: monotone at column ${x}`);
      }
      // The Reinhard curve takes the paper's white point, L (1 + L / W^2) / (1 + L) (Reinhard et al. 2002, Eq. 4), which at half
      // the white point is not the plain curve divided by its value there.
      const reinhard = await frame({ curve: 'reinhard', whitePoint: white }),
        eq4 = reinhard.row.map((_, x) => {
          const v = ((x + 0.5) / W) * RAMP;
          return encode(Math.min(1, (v * (1 + v / (white * white))) / (1 + v)));
        });
      results.reinhard = { off: worst(reinhard.row, eq4) };
      assert.ok(results.reinhard.off <= 2, `reinhard white point is Eq. 4 (${results.reinhard.off} codes off)`);
      assert.equal(reinhard.row[column], 255, 'reinhard: the white point is 255');
      console.log(JSON.stringify({ backend: compat ? 'webgl2-compat' : 'webgpu', white, results }));
      await page.evaluate(() => (window.t.source.destroy(), window.t.engine.dispose()));
    },
  );
