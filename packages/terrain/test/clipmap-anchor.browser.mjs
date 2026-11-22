import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

// Steep terrain viewed obliquely. A 2 mm camera move crosses every ring's lattice near the left side of the
// frame. With the terrain anchored, it may move the projected image slightly but cannot rebuild the ridge.
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
await runSuite(
  async () => {
    const result = await browser.page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { Terrain } = await import('/packages/terrain/dist/index.js');
      const size = 257,
        width = 480,
        height = 270;
      const heights = new Float32Array(size * size);
      for (let z = 0; z < size; z++)
        for (let x = 0; x < size; x++) {
          const ridge = Math.exp(-(((x - 89 - 19 * Math.cos(z / 31)) / 20) ** 2));
          heights[z * size + x] =
            ridge * (247 + 89 * Math.sin(z / 12) + 23 * Math.cos(z / 4)) + 21 * Math.sin((x + z) / 18);
        }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        exactSize: true,
        camera: { position: [-128.001, 160, -189.29], target: [-340, 148, 123], near: 0.5, far: 2200, fov: 44 },
      });
      engine.scene.background = '#00ff00';
      engine.lighting.direction.set([0.72, 0.36, -0.6, 3.18]);
      const capture = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
      const read = (x) => {
        engine.camera.position = [x, 160, -189.29];
        engine.render({ delta: 0 });
        capture.drawImage(canvas, 0, 0);
        return capture.getImageData(0, 0, width, height).data;
      };
      const inspect = async (clipmapAnchor) => {
        const terrain = Terrain.attach(engine, {
          origin: [-1024, -1024],
          size: [2048, 2048],
          heightScale: 1,
          levels: 7,
          resolution: 32,
          clipmapAnchor,
          layers: Array.from({ length: 4 }, () => ({ height: [-500, 500], slope: [0, 1], scale: 0.25 })),
          textures(device) {
            const heightmap = device.createTexture({ size: [size, size], format: 'r32float', usage: 6 });
            const layers = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
            device.queue.writeTexture({ texture: heightmap }, heights, { bytesPerRow: 4 * size }, [size, size]);
            device.queue.writeTexture(
              { texture: layers },
              new Uint8Array(16).fill(142),
              { bytesPerRow: 4, rowsPerImage: 1 },
              [1, 1, 4],
            );
            return { heightmap, layers };
          },
        });
        try {
          read(-128.001);
          await engine.gpu.queue.onSubmittedWorkDone();
          const before = read(-128.001);
          const version = terrain.shadowVersion;
          const after = read(-127.999);
          let changed = 0,
            silhouette = 0,
            ground = 0;
          const sky = (a, i) => a[i] < 8 && a[i + 1] > 247 && a[i + 2] < 8;
          for (let i = 0; i < before.length; i += 4) {
            ground += +!sky(before, i);
            silhouette += +(sky(before, i) !== sky(after, i));
            changed += +(Math.max(...[0, 1, 2].map((c) => Math.abs(before[i + c] - after[i + c]))) > 16);
          }
          return { changed, silhouette, ground, shadowChanges: terrain.shadowVersion - version };
        } finally {
          terrain.dispose();
        }
      };
      engine.gpu.pushErrorScope('validation');
      try {
        const following = await inspect('camera');
        const anchored = await inspect(undefined);
        const error = await engine.gpu.popErrorScope();
        return { following, anchored, error: error?.message ?? null };
      } finally {
        engine.dispose();
      }
    });
    assert.equal(result.error, null);
    assert.ok(result.following.changed > 200, JSON.stringify(result));
    assert.ok(result.following.silhouette > 30, JSON.stringify(result));
    assert.ok(result.anchored.ground > 10000, JSON.stringify(result));
    assert.ok(result.anchored.changed < 10 && result.anchored.silhouette < 10, JSON.stringify(result));
    assert.equal(result.anchored.shadowChanges, 0, JSON.stringify(result));
    console.log('ok fixed terrain across camera boundary', JSON.stringify(result));
  },
  () => browser.close(),
);
watchExit();
