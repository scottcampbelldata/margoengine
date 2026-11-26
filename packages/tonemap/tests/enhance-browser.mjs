// Real-GPU check of ColorEnhance, built packages, on WebGPU and the WebGL2 compatibility layer. Tonemap presents an
// HDR source of 16 colour bars (black to 40, saturated and dull) at exposure -1 with the linear curve, so every canvas
// pixel is the sRGB encoding of the clamped enhanced colour: default options leave the frame of a Tonemap without it
// bit for bit; each control, all together and two in one list land within 1 level of a CPU oracle of the README's
// formulas; options change with no new pipeline; a device restore redraws the same frame; and it compiles and draws
// with local exposure, white balance and grain, and in the HDR ColorOutput shader, without a GPU error.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';
import { enhanceOracle } from './support/enhance-oracle.mjs';

const BARS = [
  [0, 0, 0],
  [0.004, 0.004, 0.004],
  [0.04, 0.03, 0.05],
  [0.36, 0.36, 0.36],
  [0.8, 0.9, 1],
  [2, 2, 2],
  [6, 6, 6],
  [40, 40, 40],
  [1.4, 0.1, 0.05],
  [0.05, 0.9, 0.1],
  [0.1, 0.2, 1.8],
  [0.7, 0.55, 0.5],
  [0.2, 0.5, 0.55],
  [1.8, 1.4, 0.2],
  [0.02, 0.2, 0.3],
  [3, 0.6, 2],
];
const CASES = {
  shadows: { shadows: 2 },
  highlights: { highlights: -2.5 },
  midtones: { midtones: -1 },
  vibrance: { vibrance: 0.8 },
  muted: { vibrance: -1 },
  dehaze: { dehaze: 1, hazeColor: [0.7, 0.8, 0.9] },
  haze: { dehaze: -0.8, hazeColor: [0.5, 0.6, 0.7] },
  mixer: {
    mixer: { red: [0.2, 0.8, 0], green: [1.5, -0.5, 0], blue: [-0.3, 0.3, 1] },
  },
  all: {
    mixer: { red: [1.2, -0.2, 0], blue: [0, -0.1, 1.1] },
    dehaze: 0.6,
    shadows: 3,
    midtones: 1,
    highlights: -3,
    vibrance: 0.5,
  },
};
const EXPOSURE = -1;
const encode = (v) => {
  v = Math.min(1, Math.max(0, v));
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
};

for (const compat of [false, true])
  await postBrowser(
    'tonemap-enhance',
    5397,
    () => launchBrowser({ headless: true }),
    async (page, shot) => {
      await page.evaluate(
        async ({ compat, bars, exposure }) => {
          if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
          const { Engine } = await import('/packages/core/dist/index.js'),
            { Tonemap } = await import('/packages/tonemap/dist/index.js'),
            { ColorEnhance } = await import('/packages/tonemap/dist/enhance.js'),
            { LocalExposure } = await import('/packages/tonemap/dist/local.js'),
            { ColorOutput } = await import('/packages/environment/dist/index.js');
          const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
          engine.stop();
          const errors = [],
            watched = new Set();
          let made;
          engine.onError = (error) => errors.push(String(error.message ?? error));
          const source = () => {
            const device = engine.gpu,
              { width, height } = engine.canvas;
            if (!watched.has(device)) {
              watched.add(device);
              device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
            }
            if (made?.device !== device) {
              const texture = device.createTexture({
                  size: [width, height],
                  format: 'rgba32float',
                  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                }),
                data = new Float32Array(width * height * 4);
              for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++)
                  data.set([...bars[Math.floor((x * bars.length) / width)], 1], 4 * (y * width + x));
              device.queue.writeTexture({ texture }, data, { bytesPerRow: width * 16 }, [width, height]);
              made = { device, texture };
            }
            return made.texture;
          };
          const tonemap = Tonemap.attach(engine, { curve: 'linear', exposure, source });
          const frame = async () => {
            engine.render({ delta: 1 / 60 });
            await engine.gpu.queue.onSubmittedWorkDone();
          };
          let pipelines = 0;
          window.t = {
            engine,
            tonemap,
            frame,
            errors,
            ColorEnhance,
            LocalExposure,
            ColorOutput,
            enhance: new ColorEnhance(),
            count: () => pipelines,
            watch() {
              const device = engine.gpu,
                create = device.createRenderPipeline.bind(device);
              device.createRenderPipeline = (d) => (pipelines++, create(d));
            },
          };
          await frame();
        },
        { compat, bars: BARS, exposure: EXPOSURE },
      );
      const frame = async (set) => {
        await page.evaluate(`(async (t) => { ${set}; await t.frame(); })(window.t)`);
        return shot();
      };
      const set = (options) => `
        for (const key of Object.keys(t.enhance.options)) delete t.enhance.options[key];
        Object.assign(t.enhance.options, ${JSON.stringify(options)})`;
      // The centre pixel of each bar against the oracle of the exposed colour, through `list` in order.
      const compare = (image, list, name) => {
        let worst = 0;
        BARS.forEach((bar, i) => {
          const x = Math.floor(((i + 0.5) * image.width) / BARS.length),
            at = 4 * (Math.floor(image.height / 2) * image.width + x),
            want = list.reduce(
              (c, options) => enhanceOracle(c, options),
              bar.map((v) => v * 2 ** EXPOSURE),
            );
          want.forEach((v, c) => {
            const off = Math.abs(encode(v) - image.data[at + c]);
            worst = Math.max(worst, off);
            assert.ok(off <= 1, `${name}, bar ${i} channel ${c}: ${image.data[at + c]}, oracle ${encode(v)}`);
          });
        });
        return worst;
      };
      const differs = (a, b) => a.data.reduce((worst, v, i) => Math.max(worst, Math.abs(v - b.data[i])), 0);

      const plain = await frame('');
      compare(plain, [], 'plain');
      const identity = await frame('t.tonemap.options.extensions = [t.enhance]');
      assert.equal(differs(identity, plain), 0, 'default options change no pixel');
      await page.evaluate(() => window.t.watch());
      const worst = {};
      for (const [name, options] of Object.entries(CASES)) {
        const image = await frame(set(options));
        assert.ok(differs(image, plain) > 5, `${name} changes the picture`);
        worst[name] = compare(image, [options], name);
      }
      assert.equal(await page.evaluate(() => window.t.count()), 0, 'live options build no pipeline');
      assert.equal(differs(await frame(set({})), plain), 0, 'back to the defaults');
      const chain = [CASES.mixer, CASES.vibrance];
      worst.two = compare(
        await frame(`t.tonemap.options.extensions = ${JSON.stringify(chain)}.map((o) => new t.ColorEnhance(o))`),
        chain,
        'two in one list',
      );
      const before = await frame(`t.tonemap.options.extensions = [t.enhance]; ${set(CASES.all)}`);
      const restored = await frame('await t.engine.rebootDevice(); t.engine.stop()');
      assert.equal(differs(restored, before), 0, 'the same frame after a device restore');
      const together = await frame(`
        t.tonemap.options.extensions = [t.enhance, new t.LocalExposure()];
        Object.assign(t.tonemap.options, { temperature: 5000, grain: 0.1, whitePoint: 4 })`);
      assert.ok(differs(together, before) > 0);
      await frame(`
        Object.assign(t.tonemap.options, { temperature: undefined, grain: undefined, whitePoint: undefined, curve: 'agx' });
        t.output = t.ColorOutput.attach(t.engine, { force: true })`);
      const hdr = await frame('');
      assert.ok(
        hdr.data.some((v, i) => i % 4 !== 3 && v > 0),
        'the HDR output path draws',
      );
      const errors = await page.evaluate(() => (window.t.engine.dispose(), window.t.errors));
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({ backend: compat ? 'webgl2-compat' : 'webgpu', bars: BARS.length, worstLevels: worst }),
      );
    },
  );
