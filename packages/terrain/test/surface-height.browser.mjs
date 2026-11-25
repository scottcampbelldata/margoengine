import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
await runSuite(
  async () => {
    const result = await browser.page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { Terrain } = await import('/packages/terrain/dist/index.js');
      const side = 65;
      const heights = Float32Array.from({ length: side * side }, (_, i) => {
        const x = (i % side) / 2 - 16;
        const z = Math.floor(i / side) / 2 - 16;
        return 100 + x * 0.4 + z * 0.25 + (x === 10 && z === 0 ? 50 : 0);
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 144;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 125, 0], target: [0, 100, -8], near: 0.2, far: 160 },
      });
      const device = engine.gpu;
      device.pushErrorScope('validation');
      let raw;
      const upload = () =>
        device.queue.writeTexture({ texture: raw }, heights, { bytesPerRow: side * 4 }, [side, side]);
      const terrain = Terrain.attach(engine, {
        captureSurfaceHeight: true,
        clipmapAnchor: [0, 0],
        origin: [-16, -16],
        size: [32, 32],
        resolution: 8,
        levels: 3,
        heightScale: 1,
        layers: Array.from({ length: 4 }, () => ({ height: [0, 500], slope: [0, 1], scale: 1 })),
        textures(gpu) {
          raw = gpu.createTexture({ size: [side, side], format: 'r32float', usage: 6 });
          upload();
          const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array(16).fill(125),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return { heightmap: raw, layers };
        },
      });
      const read = async () => {
        engine.render({ delta: 0 });
        const texture = terrain.surfaceHeightTexture;
        if (!texture) throw Error('The terrain did not capture its drawn surface');
        const buffer = device.createBuffer({
          size: 512 * side,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 512, rowsPerImage: side }, [side, side]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const data = new Float32Array(buffer.getMappedRange());
          const sample = (x, z) => data[(32 + z * 2) * 128 + 32 + x * 2];
          return { impulse: sample(10, 0), centre: sample(0, 0), diagonal: sample(-7, 9) };
        } finally {
          buffer.destroy();
        }
      };
      try {
        const first = await read();
        const captured = terrain.surfaceHeightTexture;
        for (let i = 0; i < heights.length; i++) heights[i] += 4;
        upload();
        terrain.invalidate();
        const edited = await read();
        const error = await device.popErrorScope();
        return { first, edited, reused: terrain.surfaceHeightTexture === captured, error: error?.message ?? null };
      } finally {
        terrain.dispose();
        engine.dispose();
      }
    });
    console.log('terrain surface heights', JSON.stringify(result));
    assert.equal(result.error, null);
    assert.ok(
      Math.abs(result.first.impulse - 104) < 0.001,
      'the raw 154 m peak is missing from the coarse drawn triangle',
    );
    assert.ok(Math.abs(result.first.centre - 100) < 0.001);
    assert.ok(Math.abs(result.first.diagonal - 99.45) < 0.001);
    for (const key of Object.keys(result.first))
      assert.ok(Math.abs(result.edited[key] - result.first[key] - 4) < 0.001);
    assert.equal(result.reused, true, 'editing heights reuses the surface texture');
  },
  () => browser.close(),
);
watchExit();
