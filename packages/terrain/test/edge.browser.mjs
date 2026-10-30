// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/edge.browser.mjs
// The clipmap's outer rings reach past the heightmap. Main drew them there from the clamped edge texels: a flat shelf
// of the edge height (with stretched walls where the edge is not flat) out to the outermost ring, about a kilometre
// past a small world's corner (biome look plan item 7, the shelf and dark patch beyond a biome world's edge). The
// terrain now draws nothing outside its heightmap rectangle: looking past a corner shows the sky only, while the
// ground inside the map still draws.
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
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      canvas.style.cssText = 'width:128px;height:128px';
      document.body.append(canvas);
      // Camera inside a 100 m map, looking out past its (+X, +Z) corner at (50, 50).
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 25, 0], target: [400, 0, 400], near: 0.5, far: 5000 },
        }),
        device = engine.gpu;
      device.pushErrorScope('validation');
      const terrain = Terrain.attach(engine, {
        origin: [-50, -50],
        size: [100, 100],
        heightScale: 1,
        layers: Array.from({ length: 4 }, () => ({ height: [-100, 100], slope: [0, 1], scale: 0.25 })),
        textures(gpu) {
          const heightmap = gpu.createTexture({ size: [8, 8], format: 'r32float', usage: 6 }),
            layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          // A ramp toward the far edge: main's shelf past it stood 12 m up, a wall above the horizon line too.
          gpu.queue.writeTexture(
            { texture: heightmap },
            Float32Array.from({ length: 64 }, (_, i) => ((i % 8) + (i >> 3)) * 0.85),
            { bytesPerRow: 32 },
            [8, 8],
          );
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array(16).map((_, i) => [230, 40, 40, 255][i & 3]),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return { heightmap, layers };
        },
      });
      const read = () => {
        engine.render({ delta: 1 / 60 });
        const c = new OffscreenCanvas(128, 128).getContext('2d');
        c.drawImage(canvas, 0, 0);
        return c.getImageData(0, 0, 128, 128).data;
      };
      read();
      await device.queue.onSubmittedWorkDone();
      const pixels = read(),
        error = await device.popErrorScope(),
        at = (x, y) => Array.from(pixels.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 3)),
        sky = at(64, 2),
        // Every pixel above the ground near the camera: the ground beyond the map's corner, or sky.
        beyond = [];
      for (let y = 4; y < 70; y += 3) for (let x = 40; x < 88; x += 3) beyond.push(at(x, y));
      const near = at(64, 124);
      terrain.dispose();
      engine.dispose();
      return { error: error?.message ?? null, sky, beyond, near };
    });
    assert.equal(result.error, null);
    // The ground inside the map draws (red), so the check sees terrain where there is some.
    assert.ok(result.near[0] > result.near[1] + 40, `ground inside the map draws: ${result.near}`);
    const off = result.beyond.filter((p) => p.some((v, c) => Math.abs(v - result.sky[c]) > 2));
    assert.deepEqual(off, [], `past the corner only sky (${result.sky}): ${off.length} pixels differ`);
    await writeFile('test-results/terrain-edge.json', JSON.stringify({ hardware, result }, null, 1));
    console.log('ok terrain edge: sky past the corner', result.sky, 'ground inside', result.near);
  },
  () => context.close(),
);
watchExit();
