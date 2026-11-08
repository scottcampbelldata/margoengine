// Real-GPU check of LocalExposure, built packages. Tonemap (curve linear, exposure -4) presents a synthetic linear HDR
// source: a bright "window" (luminance 8) on the left and a dark "interior" (0.02) on the right, both with an 8-pixel
// checker of x1.25 and x0.8 detail. A CPU oracle repeats the extension exactly (4 by 4 log2 downsample, the two
// bilateral blur passes in 32-bit floats, bilinear base, stops clamp) and must match every pixel within one 8-bit
// level (the output's own rounding plus float differences). Strength 0 changes no pixel. Inside each region the
// local stops of neighbouring checker cells differ by under 0.02, so the detail keeps its contrast, while the interior comes up by the clamped 3
// stops and the window goes down.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

const W = 320,
  H = 240,
  EXPOSURE = -4,
  value = (x, y) => (x < W / 2 ? 8 : 0.02) * ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 1.25 : 0.8);

await postBrowser(
  'tonemap-local',
  5370,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(
      async ([W, H, EXPOSURE, valueSource]) => {
        const value = eval(valueSource),
          { Engine } = await import('/packages/core/dist/index.js'),
          { Tonemap } = await import('/packages/tonemap/dist/index.js'),
          { LocalExposure } = await import('/packages/tonemap/dist/local.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, { backend: 'webgpu' }),
          device = engine.gpu;
        engine.stop();
        if (canvas.width !== W || canvas.height !== H) throw new Error(`canvas is ${canvas.width} x ${canvas.height}`);
        const data = new Float32Array(W * H * 4);
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) data.set([value(x, y), value(x, y), value(x, y), 1], 4 * (y * W + x));
        const source = device.createTexture({
          size: [W, H],
          format: 'rgba32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: source }, data, { bytesPerRow: W * 16 }, [W, H]);
        const local = new LocalExposure(),
          tonemap = Tonemap.attach(engine, { curve: 'linear', exposure: EXPOSURE, source: () => source });
        window.t = { engine, tonemap, local };
      },
      [W, H, EXPOSURE, value.toString().replace(/\bW\b/g, String(W))],
    );
    const frame = async (set) => {
      await page.evaluate(`(${set})(window.t.tonemap.options, window.t.local); window.t.engine.render({ delta: 1 / 60 })`);
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const plain = await frame('() => {}'),
      zero = await frame('(o, l) => { l.options.strength = 0; o.extensions = [l]; }'),
      on = await frame('(o, l) => { l.options.strength = 0.5; }');
    await page.evaluate(() => (window.t.local.dispose(), window.t.engine.dispose()));

    // CPU oracle of the extension, 32-bit floats where the GPU stores them.
    const f = Math.fround,
      w = Math.ceil(W / 4),
      h = Math.ceil(H / 4),
      down = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0,
          n = 0;
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 4; i++)
            if (4 * x + i < W && 4 * y + j < H) {
              sum += Math.min(14, Math.max(-14, Math.log2(Math.max(f(value(4 * x + i, 4 * y + j)), 1e-4))));
              n++;
            }
        down[y * w + x] = sum / n;
      }
    const sigma = Math.max(0.5, (0.02 * H) / 4),
      taps = Math.min(32, Math.ceil(3 * sigma)),
      edges = 1.3,
      blur = (src, dx, dy) => {
        const out = new Float32Array(w * h);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const c = src[y * w + x];
            let sum = 0,
              weight = 0;
            for (let k = -taps; k <= taps; k++) {
              const qx = Math.min(w - 1, Math.max(0, x + dx * k)),
                qy = Math.min(h - 1, Math.max(0, y + dy * k)),
                v = src[qy * w + qx],
                d = v - c,
                wt = Math.exp(-(k * k) / (2 * sigma * sigma) - (d * d) / (2 * edges * edges));
              sum += wt * v;
              weight += wt;
            }
            out[y * w + x] = sum / weight;
          }
        return out;
      },
      base = blur(blur(down, 1, 0), 0, 1),
      at = (x, y) => base[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))],
      encode = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    let worst = 0,
      zeroDiff = 0;
    const stopsAt = (x, y) => {
      const tx = (x + 0.5) / 4 - 0.5,
        ty = (y + 0.5) / 4 - 0.5,
        ix = Math.floor(tx),
        iy = Math.floor(ty),
        fx = tx - ix,
        fy = ty - iy,
        b =
          (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) +
          (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
      return Math.min(3, Math.max(-3, -0.5 * (b + EXPOSURE - Math.log2(0.18))));
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = 4 * (y * W + x),
          want = encode(Math.min(1, value(x, y) * 2 ** (EXPOSURE + stopsAt(x, y))));
        worst = Math.max(worst, Math.abs(want - on.data[i]));
        zeroDiff = Math.max(zeroDiff, Math.abs(zero.data[i] - plain.data[i]));
      }
    // Detail inside each region, away from the edge: the local stops of neighbouring checker cells (x1.25 against
    // x0.8) differ by almost nothing, so the GPU frame, which matches the oracle, keeps their 1.5625 contrast.
    const decode = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
      r = {
        worst,
        zeroDiff,
        windowSpread: Math.abs(stopsAt(68, 100) - stopsAt(60, 100)),
        interiorSpread: Math.abs(stopsAt(260, 100) - stopsAt(252, 100)),
        windowStops: Math.log2(decode(on.data[4 * (100 * W + 60)]) / (value(60, 100) * 2 ** EXPOSURE)),
        interiorStops: Math.log2(decode(on.data[4 * (100 * W + 252)]) / (value(252, 100) * 2 ** EXPOSURE)),
      };
    console.log(JSON.stringify(r));
    assert.ok(worst <= 1, `every pixel matches the CPU oracle: ${worst} levels`);
    assert.equal(zeroDiff, 0, 'strength 0 changes no pixel');
    assert.ok(r.windowSpread < 0.02 && r.interiorSpread < 0.02, 'the detail inside a region is not compressed');
    assert.ok(r.interiorStops > 2.5 && r.windowStops < -0.4, 'the interior comes up and the window goes down');
  },
);
