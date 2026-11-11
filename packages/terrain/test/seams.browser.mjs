// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/seams.browser.mjs
// Clipmap seams must be watertight under float rounding (Rust engine port R22): the rings meet where one ring's edge
// morphs onto the next ring's coarser lattice, so a crack shows the clear colour through the ground. The camera looks
// down on rough ground from 200 positions that step through fractions of a cell (every ring snaps anew), over a
// green clear colour; every pixel shows ground, so not one may be the clear colour.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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
        size = 160,
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.style.cssText = `width:${size}px;height:${size}px`;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          exactSize: true,
          camera: { position: [0, 30, 0], target: [6, 0, 6], near: 0.1, far: 2000 },
        }),
        device = engine.gpu;
      engine.scene.background = '#00ff00';
      device.pushErrorScope('validation');
      const n = 257,
        heights = new Float32Array(n * n);
      // Rough ground: steep enough that a ring edge off the next ring's lattice opens a gap a pixel wide.
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++)
          heights[z * n + x] =
            0.06 * Math.sin(x * 0.9) * Math.cos(z * 0.7) + 0.04 * Math.sin((x - z) * 0.37) + 0.02 * Math.cos(x * 2.3 + z);
      const terrain = Terrain.attach(engine, {
        origin: [-512, -512],
        size: [1024, 1024],
        heightScale: 100,
        cellSize: 0.37,
        resolution: 32,
        layers: Array.from({ length: 4 }, () => ({ height: [-100, 100], slope: [0, 1], scale: 0.25 })),
        textures(gpu) {
          const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 6 }),
            layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture({ texture: heightmap }, heights, { bytesPerRow: n * 4 }, [n, n]);
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array(16).map((_, i) => [200, 60, 40, 255][i & 3]),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return { heightmap, layers };
        },
      });
      const read = () => {
        engine.render({ delta: 1 / 60 });
        const c = new OffscreenCanvas(size, size).getContext('2d');
        c.drawImage(canvas, 0, 0);
        return c.getImageData(0, 0, size, size).data;
      };
      read();
      await device.queue.onSubmittedWorkDone();
      let worst = 0,
        total = 0,
        first = null;
      for (let k = 0; k < 200; k++) {
        // Steps of 0.0731 and 0.1193 m: every ring's snap and morph change across the run.
        const x = k * 0.0731,
          z = -k * 0.1193;
        engine.camera.position = [x, 30 + (k % 7) * 0.013, z];
        engine.camera.target = [x + 6, 0, z + 6];
        const pixels = read();
        let open = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i] < 8 && pixels[i + 1] > 247 && pixels[i + 2] < 8) {
            open++;
            first ??= { k, x: (i / 4) % size, y: Math.floor(i / 4 / size) };
          }
        worst = Math.max(worst, open);
        total += open;
      }
      const centre = Array.from(read().subarray(((size / 2) * size + size / 2) * 4, ((size / 2) * size + size / 2) * 4 + 3)),
        error = await device.popErrorScope();
      terrain.dispose();
      engine.dispose();
      return { error: error?.message ?? null, worst, total, first, centre };
    });
    await writeFile('test-results/terrain-seams.json', JSON.stringify({ hardware, result }, null, 1));
    assert.equal(result.error, null);
    // The ground draws (red, not the green clear colour), so the count looks at terrain.
    assert.ok(result.centre[0] > result.centre[1] + 40, `ground draws: ${result.centre}`);
    assert.equal(result.total, 0, `clear colour through the ground: ${JSON.stringify(result)}`);
    console.log('ok terrain seams: 0 clear-colour pixels over 200 camera offsets');
  },
  () => context.close(),
);
watchExit();
