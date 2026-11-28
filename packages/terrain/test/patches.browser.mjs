// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/patches.browser.mjs
// TerrainOptions.patches (Above the Treeline look round 3): painted weights that share a texel were drawn as their
// average, so a far alpine slope of rock, gravel and turf read as one grey-brown felt. With `patches` the layers resolve
// into patches with crisp edges. A flat terrain with a red and a green layer, seen from above:
// 1. weights 50/50 everywhere: without patches every pixel is the mix; with them most pixels are one layer or the other
//    and both layers show;
// 2. a weight of 1 for one layer draws exactly what it draws without patches;
// 3. seen from far enough that a pixel covers a whole patch cell, the patched ground is the painted mix again (no
//    aliasing, and not the stronger layer alone).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        size = 128,
        errors = [],
        rules = Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.25 })),
        // Layer 0 red, layer 1 green, the rest black (weight 0 everywhere).
        colours = (gpu) => {
          const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array([200, 40, 40, 255, 40, 200, 40, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return layers;
        },
        plane = (gpu, side, data, format, bytes) => {
          const texture = gpu.createTexture({ size: [side, side], format, usage: 6 });
          gpu.queue.writeTexture({ texture }, data, { bytesPerRow: side * bytes }, [side, side]);
          return texture;
        };
      async function picture({ red, patches, eye }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: eye, target: [0, 0, 0], near: 1, far: 100000, fov: 40 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        const side = 16,
          weights = new Uint8Array(side * side * 4);
        for (let i = 0; i < side * side; i++) {
          weights[i * 4] = red;
          weights[i * 4 + 1] = 255 - red;
        }
        const terrain = Terrain.attach(engine, {
          origin: [-20000, -20000],
          size: [40000, 40000],
          heightScale: 1,
          cellSize: 2,
          levels: 12,
          layers: rules,
          ...(patches ? { patches } : {}),
          textures: (gpu) => ({
            heightmap: plane(gpu, 2, new Float32Array(4), 'r32float', 4),
            layers: colours(gpu),
            weights: [plane(gpu, side, weights, 'rgba8unorm', 4), plane(gpu, side, new Uint8Array(side * side * 4), 'rgba8unorm', 4)],
          }),
        });
        engine.lighting.direction.set([0.001, 1, 0.002, 4]);
        const read = () => {
          engine.render({ delta: 1 / 60 });
          const c = new OffscreenCanvas(size, size).getContext('2d');
          c.drawImage(canvas, 0, 0);
          return c.getImageData(0, 0, size, size).data;
        };
        read();
        await device.queue.onSubmittedWorkDone();
        const pixels = read(),
          error = await device.popErrorScope();
        if (error) errors.push(error.message);
        terrain.dispose();
        engine.dispose();
        canvas.remove();
        return pixels;
      }
      // Share of green in each pixel: about 0.17 for the red layer, 0.83 for the green one, near 0.5 for the mix.
      const greens = (p) => {
          const out = [];
          for (let i = 0; i < p.length; i += 4) out.push(p[i + 1] / Math.max(1, p[i] + p[i + 1]));
          return out;
        },
        split = (p) => {
          const g = greens(p);
          return {
            red: g.filter((v) => v < 0.3).length / g.length,
            green: g.filter((v) => v > 0.7).length / g.length,
            mean: g.reduce((a, b) => a + b, 0) / g.length,
          };
        },
        worst = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0),
        near = [0.3, 90, 0.4],
        far = [0.3, 30000, 0.4],
        patches = { size: 14, contrast: 0.6 },
        out = {};
      out.mixPlain = split(await picture({ red: 128, eye: near }));
      out.mixPatched = split(await picture({ red: 128, patches, eye: near }));
      out.pure = worst(await picture({ red: 255, eye: near }), await picture({ red: 255, patches, eye: near }));
      out.farPlain = split(await picture({ red: 128, eye: far }));
      out.farPatched = split(await picture({ red: 128, patches, eye: far }));
      out.errors = errors;
      return out;
    });
    console.log('terrain patches check:', JSON.stringify({ hardware, result }));
    assert.deepEqual(result.errors, []);
    // Before: every pixel of a 50/50 texel is the mix.
    assert.ok(result.mixPlain.red + result.mixPlain.green < 0.01, 'without patches the ground is the mix');
    assert.ok(result.mixPatched.red > 0.2 && result.mixPatched.green > 0.2, 'both layers show as patches');
    assert.ok(result.mixPatched.red + result.mixPatched.green > 0.75, 'most pixels are one layer, not the mix');
    assert.ok(result.pure <= 1, `a weight of 1 draws as painted (largest difference ${result.pure})`);
    assert.ok(
      Math.abs(result.farPatched.mean - result.farPlain.mean) < 0.03 && result.farPatched.red + result.farPatched.green < 0.05,
      'far ground is the painted mix again',
    );
  },
  () => context.close(),
);
watchExit();
