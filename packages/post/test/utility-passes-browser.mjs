// Real-GPU check of the utility passes, built packages. A light and a dark box meet in a vertical edge. KawaseBlur
// spreads it further with more levels and larger kernels, stays monotone across it and never leaks from one view of a
// split screen into the other; ColorAverage and LUT1D are compared pixel by pixel with the formulas on the CPU; and
// DepthDownsample's textures are read back and compared texel by texel with a CPU reduction of the same source.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

const W = 320,
  H = 240;
await postBrowser(
  'post-utility-passes',
  5413,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { PostStack } = await import('/packages/post/dist/stack.js');
      const modules = {};
      for (const entry of ['kawase-blur', 'color-average', 'lut1d', 'depth-downsample'])
        Object.assign(modules, await import(`/packages/post/dist/${entry}.js`));
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      engine.stop();
      for (const [x, color] of [
        [-1, '#e0c080'],
        [1, '#203050'],
      ])
        engine
          .createMesh()
          .setGeometry(box(2, 2, 0.2))
          .setPosition([x, 0, 0])
          .setMaterial(new PbrMaterial({ color, roughness: 1 }));
      const stack = PostStack.attach(engine, []);
      window.t = { engine, stack, modules };
    });
    const render = async (views) => {
      await page.evaluate(async (split) => {
        const { engine } = window.t,
          camera = engine.camera;
        engine.render(
          split
            ? {
                delta: 1 / 60,
                views: [
                  { camera, viewport: [0, 0, 0.5, 1], clear: { color: '#ff0000' } },
                  { camera, viewport: [0.5, 0, 0.5, 1], clear: { color: '#000000' } },
                ],
              }
            : { delta: 1 / 60 },
        );
        await engine.gpu.queue.onSubmittedWorkDone();
      }, views);
      return shot();
    };
    const use = async (name, options, views) => {
      await page.evaluate(
        ([name, options]) => {
          const t = window.t;
          if (t.effect) t.stack.removeEffect(t.effect);
          t.effect = name ? new t.modules[name](options) : undefined;
          if (t.effect) t.stack.addEffect(t.effect);
        },
        [name, options],
      );
      return render(views);
    };
    const at = (image, x, y) => {
      const i = 4 * (y * image.width + x);
      return [...image.data.subarray(i, i + 3)];
    };
    const differs = (a, b) => a.data.reduce((max, v, i) => Math.max(max, Math.abs(v - b.data[i])), 0);

    // KawaseBlur.
    const sharp = await use('KawaseBlur', { enabled: false });
    const zero = await use('KawaseBlur', { strength: 0 });
    assert.equal(differs(sharp, zero), 0, 'strength 0 equals disabled');
    let edge = 0,
      step = 0;
    for (let x = 100; x < 220; x++) {
      const d = Math.abs(at(sharp, x + 1, 120)[0] - at(sharp, x, 120)[0]);
      if (d > step) [edge, step] = [x + 1, d];
    }
    assert.ok(step > 90, `a sharp edge without the blur: ${step}`);
    // Pixels on the middle row near the edge that the blur changes by more than 3 levels.
    const spread = (image) => {
      let n = 0;
      for (let x = edge - 40; x < edge + 40; x++) if (Math.abs(at(image, x, 120)[0] - at(sharp, x, 120)[0]) > 3) n++;
      return n;
    };
    const spreads = {};
    for (const [label, options] of [
      ['dual1', { levels: 1 }],
      ['dual3', { levels: 3 }],
      ['verySmall', { method: 'kawase', size: 'very-small', resolutionScale: 1 }],
      ['medium', { method: 'kawase' }],
      ['quarter', { method: 'kawase', size: 'small', resolutionScale: 0.25 }],
    ]) {
      const image = await use('KawaseBlur', options);
      spreads[label] = spread(image);
      for (let x = edge - 30; x < edge + 30; x++)
        assert.ok(at(image, x + 1, 120)[0] <= at(image, x, 120)[0] + 2, `${label} falls across the edge at ${x}`);
      // Far from every edge the flat face keeps its colour.
      if (label === 'dual1' || label === 'verySmall')
        for (const x of [edge - 35, edge + 35])
          for (let c = 0; c < 3; c++)
            assert.ok(Math.abs(at(image, x, 120)[c] - at(sharp, x, 120)[c]) <= 2, `${label} keeps the face at ${x}`);
    }
    assert.ok(
      spreads.dual1 >= 2 && spreads.dual3 > spreads.dual1 + 8,
      `more levels, wider: ${JSON.stringify(spreads)}`,
    );
    assert.ok(spreads.medium > spreads.verySmall + 8 && spreads.quarter > spreads.verySmall, JSON.stringify(spreads));
    // Split screen: the left view clears to red, the right to black. No red crosses into the right view.
    for (const method of ['dual', 'kawase']) {
      const split = await use('KawaseBlur', { method, levels: 4 }, true);
      for (let x = W / 2; x < W / 2 + 6; x++)
        assert.deepEqual(at(split, x, 4), [0, 0, 0], `${method}: the right view stays black at ${x}`);
      assert.ok(at(split, W / 2 - 1, 4)[0] > 200, `${method}: the left view keeps its red to its edge`);
    }

    // ColorAverage and LUT1D against their formulas on the frame's own pixels.
    const plain = await use('ColorAverage', { enabled: false });
    const compare = (image, want, tolerance, label) => {
      let worst = 0;
      for (let i = 0; i < plain.data.length; i += 4) {
        const w = want([plain.data[i], plain.data[i + 1], plain.data[i + 2]]);
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(image.data[i + c] - w[c]));
      }
      assert.ok(worst <= tolerance, `${label}: off by ${worst}`);
      return worst;
    };
    const average = (weights) => (p) => {
      const v = (p[0] * weights[0] + p[1] * weights[1] + p[2] * weights[2]) / (weights[0] + weights[1] + weights[2]);
      return [v, v, v];
    };
    compare(await use('ColorAverage', {}), average([1, 1, 1]), 1, 'ColorAverage');
    compare(await use('ColorAverage', { weights: [1, 0, 0] }), average([1, 0, 0]), 1, 'ColorAverage weights');
    compare(
      await use('ColorAverage', { blend: 'multiply' }),
      (p) => {
        const g = average([1, 1, 1])(p)[0] / 255;
        return p.map((v) => v * g);
      },
      1,
      'ColorAverage multiply',
    );
    const invert = (p) => p.map((v) => 255 - v);
    compare(await use('LUT1D', { lut: { data: [1, 1, 1, 0, 0, 0] } }), invert, 1, 'LUT1D invert');
    compare(
      await use('LUT1D', { lut: 'LUT_1D_SIZE 2\nDOMAIN_MAX 2 2 2\n0 0 0\n1 1 1' }),
      (p) => p.map((v) => v / 2),
      1,
      'LUT1D domain',
    );
    // A 3000 entry table, wrapped over three texture rows, one curve a channel.
    const curves = (p) => [255 * Math.sqrt(p[0] / 255), 255 * (p[1] / 255) ** 2, 255 - p[2]];
    await page.evaluate(() => {
      const data = [];
      for (let i = 0; i < 3000; i++) data.push(Math.sqrt(i / 2999), (i / 2999) ** 2, 1 - i / 2999);
      window.t.table = { data };
    });
    await page.evaluate(() => {
      const t = window.t;
      t.stack.removeEffect(t.effect);
      t.effect = new t.modules.LUT1D({ lut: t.table });
      t.stack.addEffect(t.effect);
    });
    compare(await render(), curves, 1, 'LUT1D curves');
    // The same inversion from a texture, with a depth mask over everything (so the table binds after the depth).
    await page.evaluate(() => {
      const t = window.t,
        device = t.engine.gpu,
        texels = new Uint8Array(256 * 4).map((_, i) => 255 - (i >> 2));
      const texture = device.createTexture({ size: [256, 1], format: 'rgba8unorm', usage: 0x4 | 0x2 });
      device.queue.writeTexture({ texture }, texels, { bytesPerRow: 1024 }, [256, 1]);
      t.effect.setLUT(texture);
      Object.assign(t.effect.options, { mask: 'depth', maskRange: [0, 0.001] });
    });
    compare(await render(), invert, 1, 'LUT1D texture');

    // DepthDownsample from a depth of known values, read back.
    await use();
    const reduce = (source, width, height, outW, outH, mode) => {
      const out = [],
        kept = [];
      for (let y = 0; y < outH; y++)
        for (let x = 0; x < outW; x++) {
          const x0 = Math.floor((x * width) / outW),
            y0 = Math.floor((y * height) / outH),
            ex = Math.max(Math.floor(((x + 1) * width) / outW), x0 + 1) - x0,
            ey = Math.max(Math.floor(((y + 1) * height) / outH), y0 + 1) - y0,
            samples = [];
          const median = mode === 'representative',
            mx = median ? Math.min(ex, 4) : ex,
            my = median ? Math.min(ey, 4) : ey;
          for (let j = 0; j < my; j++)
            for (let i = 0; i < mx; i++) {
              const px = x0 + (median ? Math.floor(((2 * i + 1) * ex) / (2 * mx)) : i),
                py = y0 + (median ? Math.floor(((2 * j + 1) * ey) / (2 * my)) : j);
              samples.push([source[py * width + px], py * width + px]);
            }
          samples.sort((a, b) => b[0] - a[0]);
          const near = mode === 'near' || (mode === 'checkerboard' && (x + y) % 2 === 0);
          const pick = median ? samples[(samples.length - 1) >> 1] : near ? samples[0] : samples.at(-1);
          out.push(pick[0]);
          kept.push(pick[1]);
        }
      return { out, kept };
    };
    // Distinct values, so the kept texel is known; one footprint size (2 x 2) and one uneven, wide one.
    for (const [width, height, outW, outH] of [
      [8, 6, 4, 3],
      [37, 23, 7, 3],
    ])
      for (const mode of ['representative', 'near', 'far', 'checkerboard']) {
        const source = Array.from({ length: width * height }, (_, i) => Math.fround(((i * 613) % 997) / 997));
        const got = await page.evaluate(
          async ({ source, width, height, outW, outH, mode }) => {
            const t = window.t,
              device = t.engine.gpu;
            const make = (format, data, bytes) => {
              const texture = device.createTexture({ size: [width, height], format, usage: 0x4 | 0x2 });
              device.queue.writeTexture({ texture }, data, { bytesPerRow: width * bytes }, [width, height]);
              return texture;
            };
            const depth = make('r32float', new Float32Array(source), 4);
            // The normal texture holds each texel's index in red.
            const ids = new Float32Array(width * height * 4);
            source.forEach((_, i) => (ids[i * 4] = i));
            const normal = make('rgba32float', ids, 16);
            const pass = t.modules.DepthDownsample.attach(t.engine, {
              depth: () => depth,
              normal: () => normal,
              width: outW,
              height: outH,
              mode,
            });
            t.engine.render({ delta: 1 / 60 });
            const read = async (texture, bytes) => {
              const row = Math.ceil((outW * bytes) / 256) * 256,
                buffer = device.createBuffer({ size: row * outH, usage: 0x8 | 0x1 }),
                encoder = device.createCommandEncoder();
              encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [outW, outH]);
              device.queue.submit([encoder.finish()]);
              await buffer.mapAsync(1);
              const data = buffer.getMappedRange().slice(0);
              buffer.destroy();
              return { data, row };
            };
            const d = await read(pass.texture, 4),
              n = await read(pass.normalTexture, 8),
              out = [],
              kept = [],
              half = (h) => {
                const e = (h >> 10) & 31,
                  m = h & 1023;
                return e ? (1 + m / 1024) * 2 ** (e - 15) : (m / 1024) * 2 ** -14;
              };
            for (let y = 0; y < outH; y++)
              for (let x = 0; x < outW; x++) {
                out.push(new Float32Array(d.data, y * d.row)[x]);
                kept.push(half(new Uint16Array(n.data, y * n.row)[x * 4]));
              }
            pass.dispose();
            depth.destroy();
            normal.destroy();
            return { out, kept };
          },
          { source, width, height, outW, outH, mode },
        );
        assert.deepEqual(got, reduce(source, width, height, outW, outH, mode), `${mode} ${width}x${height}`);
      }
    // From its own capture of the scene: depth at the boxes, 0 on the empty background.
    const own = await page.evaluate(async () => {
      const t = window.t,
        device = t.engine.gpu,
        pass = t.modules.DepthDownsample.attach(t.engine, { mode: 'near' });
      t.engine.render({ delta: 1 / 60 });
      const { width, height } = pass.texture,
        row = Math.ceil((width * 4) / 256) * 256,
        buffer = device.createBuffer({ size: row * height, usage: 0x8 | 0x1 }),
        encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: pass.texture }, { buffer, bytesPerRow: row }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(1);
      const data = new Float32Array(buffer.getMappedRange().slice(0));
      buffer.destroy();
      const value = (x, y) => data[(y * row) / 4 + x];
      const out = { width, height, box: value(width >> 1, height >> 1), empty: value(1, 1) };
      pass.dispose();
      return out;
    });
    assert.deepEqual([own.width, own.height], [W / 2, H / 2]);
    // The box faces are 4.9 from the camera: reversed depth near / distance, with a 0.1 near plane about 0.02.
    assert.ok(own.box > 0.005 && own.box < 0.1 && own.empty === 0, JSON.stringify(own));
    console.log(JSON.stringify({ edge, step, spreads, own }));
    await page.evaluate(() => window.t.engine.dispose());
  },
);
