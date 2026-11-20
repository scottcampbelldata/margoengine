// Real-GPU check, built packages, on WebGPU and the WebGL2 compatibility layer: Tonemap's white balance applies the
// 3x3 adaptation matrix from `whiteBalanceMatrix` in the shader, column for column. A grey card lit by a 1750 K candle
// (the Planckian white of 1750 K, whose negative blue the shader clips to 0) is balanced with temperature 1750: every
// channel must come out as the CPU matrix gives it, within one 8-bit code, and none may be black. A per-channel RGB gain
// went negative below 1903.4 K (red and green to 0 after the clamp), so the card turned pure blue.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';
import { whiteBalanceMatrix } from '../dist/index.js';

const W = 320,
  H = 240,
  K = 1750;
// The Planckian white at K (Kim et al. 2002 locus, XYZ to linear Rec.709), scaled to a mid grey card.
function planckianRGB(t) {
  const x = -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991,
    y = -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683,
    X = x / y,
    Z = (1 - x - y) / y;
  return [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 + 0.041556 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ];
}
const card = planckianRGB(K).map((v) => 0.25 * v),
  clipped = card.map((v) => Math.max(v, 0)),
  m = whiteBalanceMatrix(K),
  balanced = [0, 1, 2].map((r) => m[r] * clipped[0] + m[3 + r] * clipped[1] + m[6 + r] * clipped[2]),
  encode = (v) => {
    const c = Math.min(Math.max(v, 0), 1);
    return Math.round(255 * (c >= 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c));
  },
  want = balanced.map(encode);
assert.ok(card[2] < 0, 'the 1750 K white lies outside Rec.709');
for (const compat of [false, true])
  await postBrowser(
    'tonemap-white-balance',
    5371,
    () => launchBrowser({ headless: true }),
    async (page, shot) => {
      await page.evaluate(
        async ([W, H, compat, card, K]) => {
          if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
          const { Engine } = await import('/packages/core/dist/index.js'),
            { Tonemap } = await import('/packages/tonemap/dist/index.js');
          const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' }),
            device = engine.gpu;
          engine.stop();
          const data = new Float32Array(W * H * 4);
          for (let i = 0; i < W * H; i++) data.set([...card, 1], 4 * i);
          const source = device.createTexture({
            size: [W, H],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          device.queue.writeTexture({ texture: source }, data, { bytesPerRow: W * 16 }, [W, H]);
          const tonemap = Tonemap.attach(engine, { source: () => source, curve: 'linear', temperature: K });
          engine.render({ delta: 1 / 60 });
          await device.queue.onSubmittedWorkDone();
          window.t = { engine, tonemap, source };
        },
        [W, H, compat, card, K],
      );
      const image = await shot();
      await page.evaluate(() => (window.t.source.destroy(), window.t.engine.dispose()));
      const i = 4 * ((image.height >> 1) * image.width + (image.width >> 1)),
        got = [image.data[i], image.data[i + 1], image.data[i + 2]];
      console.log(JSON.stringify({ backend: compat ? 'webgl2-compat' : 'webgpu', want, got }));
      for (let c = 0; c < 3; c++) {
        assert.ok(got[c] > 0, `${compat ? 'compat' : 'webgpu'}: channel ${c} is not black (${got})`);
        assert.ok(Math.abs(got[c] - want[c]) <= 1, `${compat ? 'compat' : 'webgpu'}: ${got} against ${want}`);
      }
    },
  );
