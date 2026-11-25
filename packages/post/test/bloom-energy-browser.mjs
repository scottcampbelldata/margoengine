// Real-GPU check (KB-CABIN-BLOOM1): the glow of a small steady light carries its energy. Glare spreads each point's
// light by a point spread function that integrates to the share scattered (Spencer, Shirley, Zimmerman and Greenberg,
// SIGGRAPH 1995), so Bloom's glow of a source sums to `strength` times its light above the threshold, whatever the
// source's size. Bloom.encodeImage runs on a 512 x 512 linear rgba16float image holding only a lantern flame 2 x 3 px
// wide at 17,000 cd/m2 (a hurricane lantern's 6.5 cd over its 11 mm flame, pi 0.011^2 m2; Mills, LBNL 2003), a
// kerosene flame's colour, in the middle. The glow (output less input, summed over the image, per channel) must be
// strength x the flame's light within 1%, with the Cabin Hearth kit's options (strength 0.12, threshold 1.2, radius
// 0.8) and the defaults, on the first frame and on a steady second one, and when the flame moves 40 px between them.
// The tolerance: every chain level is binary16, rounded to within 2^-11 of its value (IEEE 754-2008), and the glow is
// all positive, so the six down and five up stores and the composite move the sum by at most 12 x 2^-11, 0.59%; the
// output on the flame's own 6 px is its 27,000 (red) plus the glow, rounded to half a binary16 step there (8), 48 in
// all, 0.24% of the kit's 0.12 x 6 x 27,000; the threshold comes off each tap's mean, at least a quarter of the flame's
// light, so it moves the sum under 0.03%. 0.86% in all, inside 1%.
// The fireflies: a one-texel spike on a frame after one without it keeps only the Karis share of its glow (what
// `fireflies: 'karis'` keeps of it, within 1%; 25% here), and keeps it all (within 1%) when it is still there the next
// frame; `'karis'` damps the steady flame as main did, `'none'` keeps the spike's first frame. Before KB-CABIN-BLOOM1
// the flame kept 57% of its glow on every frame (the Karis average of every top box).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-bloom-energy',
  5399,
  () => launchBrowser({ headless: true }),
  async (page) => {
    const result = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Bloom } = await import('/packages/post/dist/bloom.js');
      const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
      engine.stop();
      const device = engine.gpu,
        size = 512,
        errors = [];
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const half = (v) => {
        if (v === 0) return 0;
        const e = Math.floor(Math.log2(v));
        return ((e + 15) << 10) | Math.round((v / 2 ** e - 1) * 1024);
      };
      const toFloat = (h) => {
        const e = (h >> 10) & 31,
          m = h & 1023,
          s = h & 0x8000 ? -1 : 1;
        if (e === 31) return m ? NaN : s * Infinity;
        return s * (e ? 2 ** (e - 15) * (1 + m / 1024) : 2 ** -14 * (m / 1024));
      };
      // 1,900 K (a kerosene flame) as linear sRGB with luminance 1, times 17,000 cd/m2.
      const tint = [1, 0.56, 0.24],
        y = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2],
        flame = tint.map((c) => (c / y) * 17000);
      /** An image with `w x h` px of `color` at `[x, y]`; returns the half-float data and the exact sums it holds. */
      const image = (x0, y0, w, h, color) => {
        const data = new Uint16Array(size * size * 4),
          sum = [0, 0, 0];
        for (let y = y0; y < y0 + h; y++)
          for (let x = x0; x < x0 + w; x++) {
            const o = (y * size + x) * 4,
              v = color.map(half);
            data.set([...v, half(1)], o);
            for (let c = 0; c < 3; c++) sum[c] += toFloat(v[c]);
          }
        return { data, sum };
      };
      const input = device.createTexture({
          size: [size, size],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        }),
        output = device.createTexture({
          size: [size, size],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        }),
        read = device.createBuffer({ size: size * size * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      /** One frame of `bloom` over `frame`: the glow's share of strength x the light, per channel. */
      const run = async (bloom, frame) => {
        device.queue.writeTexture({ texture: input }, frame.data, { bytesPerRow: size * 8 }, [size, size]);
        const encoder = device.createCommandEncoder();
        bloom.encodeImage({ device, encoder, width: size, height: size }, input.createView(), output.createView());
        encoder.copyTextureToBuffer({ texture: output }, { buffer: read, bytesPerRow: size * 8 }, [size, size]);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const out = new Uint16Array(read.getMappedRange().slice(0));
        read.unmap();
        const glow = [0, 0, 0];
        for (let i = 0; i < size * size; i++)
          for (let c = 0; c < 3; c++) glow[c] += toFloat(out[i * 4 + c]) - toFloat(frame.data[i * 4 + c]);
        const strength = bloom.options.strength ?? 0.8;
        return glow.map((g, c) => (frame.sum[c] ? g / (strength * frame.sum[c]) : g));
      };
      const kit = { strength: 0.12, threshold: 1.2, radius: 0.8 },
        still = image(255, 254, 2, 3, flame),
        moved = image(295, 254, 2, 3, flame),
        dark = image(0, 0, 0, 0, flame),
        spike = image(300, 200, 1, 1, flame),
        shares = {};
      for (const [name, options] of [
        ['kit', kit],
        ['defaults', {}],
      ]) {
        const steady = new Bloom(options);
        shares[`${name} first`] = await run(steady, still);
        shares[`${name} steady`] = await run(steady, still);
        steady.dispose();
        const moving = new Bloom(options);
        await run(moving, still);
        shares[`${name} moved 40 px`] = await run(moving, moved);
        moving.dispose();
      }
      const fireflies = new Bloom(kit);
      await run(fireflies, dark);
      shares['spike, new'] = await run(fireflies, spike);
      shares['spike, still there'] = await run(fireflies, spike);
      fireflies.dispose();
      const karis = new Bloom({ ...kit, fireflies: 'karis' });
      shares['karis first'] = await run(karis, still);
      shares['karis steady'] = await run(karis, still);
      karis.dispose();
      const karisSpike = new Bloom({ ...kit, fireflies: 'karis' });
      shares['karis spike'] = await run(karisSpike, spike);
      karisSpike.dispose();
      const none = new Bloom({ ...kit, fireflies: 'none' });
      await run(none, dark);
      shares['none, spike new'] = await run(none, spike);
      none.dispose();
      for (const resource of [input, output, read]) resource.destroy();
      engine.dispose();
      return { shares, errors };
    });
    for (const [name, share] of Object.entries(result.shares))
      console.log(name, share.map((s) => s.toFixed(4)).join(' '));
    assert.deepEqual(result.errors, []);
    const within = (name, share) =>
      assert.ok(
        share.every((s) => Math.abs(s - 1) <= 0.01),
        `${name}: the glow is strength x the light within 1% (${share.map((s) => s.toFixed(4))})`,
      );
    for (const name of [
      'kit first',
      'kit steady',
      'kit moved 40 px',
      'defaults first',
      'defaults steady',
      'defaults moved 40 px',
    ])
      within(name, result.shares[name]);
    within('spike, still there', result.shares['spike, still there']);
    within('none, spike new', result.shares['none, spike new']);
    const { 'spike, new': fresh, 'karis spike': damped } = result.shares;
    assert.ok(
      fresh.every((s, c) => s < 0.5 && Math.abs(s - damped[c]) <= 0.01 * damped[c]),
      `a new spike keeps the Karis share (${fresh.map((s) => s.toFixed(4))} against ${damped.map((s) => s.toFixed(4))})`,
    );
    for (const name of ['karis first', 'karis steady'])
      assert.ok(
        result.shares[name].every((s) => s < 0.6),
        `${name}: the Karis average damps the steady flame as before (${result.shares[name].map((s) => s.toFixed(4))})`,
      );
  },
);
