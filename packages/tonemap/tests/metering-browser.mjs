// Real-GPU check of the auto-exposure metering modes, built packages. Tonemap meters a synthetic linear HDR source
// (grey everywhere, so luminance is the value): background 0.02, a bright box 2.0 on the left, a mid box 0.5 in the
// centre and a tiny light of 5000 at the top right. For every metering (average, center, spot, mask) under both
// methods (mean, histogram), the exposure the GPU stores is compared with a CPU oracle that repeats the meter exactly:
// the same 64 by 64 sample grid, weights, log2 clamp and 64 histogram bins (within 0.002 stops: float sums in a
// different order). The spot on the mid box must meter log2(0.18 / 0.5); a mask of 0 everywhere keeps the exposure.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

await postBrowser(
  'tonemap-metering',
  5369,
  () => launchBrowser({ headless: true }),
  async (page) => {
    const r = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu' }),
        device = engine.gpu,
        W = canvas.width,
        H = canvas.height;
      engine.stop();
      const value = (x, y) =>
        x >= 0.1 * W && x < 0.4 * W && y >= 0.3 * H && y < 0.7 * H
          ? 2
          : x >= 0.45 * W && x < 0.55 * W && y >= 0.45 * H && y < 0.55 * H
            ? 0.5
            : x >= 0.9 * W && x < 0.95 * W && y >= 0.05 * H && y < 0.1 * H
              ? 5000
              : 0.02;
      const data = new Float32Array(W * H * 4);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) data.set([value(x, y), value(x, y), value(x, y), 1], 4 * (y * W + x));
      const source = device.createTexture({
        size: [W, H],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: source }, data, { bytesPerRow: W * 16 }, [W, H]);
      // Mask: 1 on the right half, 0 on the left (8 by 4 texels).
      const mw = 8,
        mh = 4,
        mask = device.createTexture({
          size: [mw, mh],
          format: 'r8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        }),
        maskData = new Uint8Array(256 * mh);
      for (let y = 0; y < mh; y++) for (let x = mw / 2; x < mw; x++) maskData[256 * y + x] = 255;
      device.queue.writeTexture({ texture: mask }, maskData, { bytesPerRow: 256 }, [mw, mh]);
      const empty = device.createTexture({
        size: [1, 1],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: empty }, new Uint8Array(4), { bytesPerRow: 256 }, [1, 1]);
      const tonemap = Tonemap.attach(engine, { curve: 'linear', source: () => source, autoExposure: true }),
        read = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const run = async (a, reset = true) => {
        tonemap.options.autoExposure = { min: -16, max: 16, speed: 1.5, ...a };
        if (reset) device.queue.writeBuffer(tonemap.aeBuffer, 0, new Float32Array(2));
        engine.render({ delta: 1 / 60 });
        const e = device.createCommandEncoder();
        e.copyBufferToBuffer(tonemap.aeBuffer, 0, read, 0, 8);
        device.queue.submit([e.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const v = [...new Float32Array(read.getMappedRange())];
        read.unmap();
        return v;
      };
      await run({}, false);
      // CPU oracle of the meter shader.
      const f = Math.fround,
        oracle = (a) => {
          const rect = [0, 0, W, H],
            metering = a.metering ?? 'average',
            [plo, phi] = a.percentiles ?? [0.1, 0.9];
          let dom = rect;
          if (metering === 'spot') {
            const rr = (a.spot?.radius ?? 0.05) * Math.min(W, H);
            dom = [(a.spot?.x ?? 0.5) * W - rr, (a.spot?.y ?? 0.5) * H - rr, 2 * rr, 2 * rr];
          }
          let sw = 0,
            sv = 0;
          const bins = new Array(64).fill(0);
          for (let gy = 0; gy < 64; gy++)
            for (let gx = 0; gx < 64; gx++) {
              const u = (gx + 0.5) / 64,
                v = (gy + 0.5) / 64,
                px = Math.min(Math.max(dom[0] + u * dom[2], 0), W - 1),
                py = Math.min(Math.max(dom[1] + v * dom[3], 0), H - 1),
                l = Math.min(value(Math.trunc(px), Math.trunc(py)), 65000),
                lv = Math.min(Math.max(Math.log2(Math.max(f(l), 0.0001)), -12), 12);
              let w = 1;
              if (metering === 'center') {
                const dx = (px - W / 2) / H,
                  dy = (py - H / 2) / H;
                w = Math.exp(-8 * (dx * dx + dy * dy));
              } else if (metering === 'spot') w = Math.hypot(u - 0.5, v - 0.5) <= 0.5 ? 1 : 0;
              else if (metering === 'mask') w = Math.min(Math.trunc((px / W) * mw), mw - 1) >= mw / 2 ? 1 : 0;
              sw += w;
              sv += w * lv;
              bins[Math.min(Math.trunc(((lv + 12) / 24) * 64), 63)] += Math.trunc(w * 256 + 0.5);
            }
          let level = sv / sw;
          if (a.method === 'histogram') {
            const count = bins.reduce((s, n) => s + n, 0),
              lo = count * plo,
              hi = count * phi;
            let below = 0,
              kept = 0,
              sum = 0;
            for (let b = 0; b < 64; b++) {
              const part = Math.min(hi, below + bins[b]) - Math.max(lo, below);
              if (part > 0) {
                kept += part;
                sum += part * (-12 + (b + 0.5) * 0.375);
              }
              below += bins[b];
            }
            level = sum / kept;
          }
          return Math.log2(0.18) - level;
        };
      const out = { modes: {}, worst: 0 };
      for (const metering of ['average', 'center', 'spot', 'mask'])
        for (const method of ['mean', 'histogram']) {
          const a = { metering, method, ...(metering === 'mask' ? { mask } : {}) },
            [gpu, set] = await run(a),
            cpu = oracle(a);
          out.modes[metering + ' ' + method] = [gpu, cpu, set];
          out.worst = Math.max(out.worst, Math.abs(gpu - cpu));
        }
      const spot = await run({ metering: 'spot', spot: { x: 0.5, y: 0.5, radius: 0.04 } });
      out.spot = spot[0];
      // Zero weight everywhere: the exposure stays where the spot left it.
      out.kept = (await run({ metering: 'mask', mask: empty }, false))[0];
      engine.dispose();
      return out;
    });
    console.log(JSON.stringify(r));
    const m = r.modes;
    assert.ok(r.worst < 0.002, `every mode matches the CPU oracle: ${r.worst} stops`);
    assert.ok(Object.values(m).every(([, , set]) => set === 1), 'each run stored an exposure');
    assert.ok(Math.abs(r.spot - Math.log2(0.18 / 0.5)) < 1e-4, `the spot on the mid box meters it: ${r.spot}`);
    assert.equal(r.kept, r.spot, 'an empty mask keeps the exposure');
    const values = Object.values(m).map(([gpu]) => gpu);
    assert.equal(new Set(values.map((v) => v.toFixed(2))).size, values.length, 'every mode meters differently');
    assert.ok(
      m['mask mean'][0] < m['mask histogram'][0],
      'the histogram drops the tiny light that pulls the mean of the right half down',
    );
  },
);
