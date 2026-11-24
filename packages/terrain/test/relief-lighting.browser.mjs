import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
const errors = [];
context.page.on('pageerror', (error) => errors.push(error.message));
context.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

await runSuite(
  async () => {
    const result = await context.page.evaluate(async () => {
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const { Engine } = await import('/packages/core/dist/index.js');
      const { Terrain } = await import('/packages/terrain/dist/index.js');
      const { TerrainReliefLighting, bakeTerrainReliefLighting } = await import(
        '/packages/terrain/dist/relief-lighting.js'
      );
      const canvas = document.body.appendChild(document.createElement('canvas'));
      using engine = await Engine.create(canvas, { backend: 'webgpu', exactSize: [160, 100] });
      const gpu = engine.gpu;
      gpu.pushErrorScope('validation');
      const width = 65;
      const height = 33;
      const data = new Float32Array(width * height);
      for (let z = 3; z < height - 3; z++) data[z * width + 32] = 18;
      const size = [64, 32];
      const makeHeightmap = () => {
        const texture = gpu.createTexture({ size: [width, height], format: 'r32float', usage: 6 });
        gpu.queue.writeTexture({ texture }, data, { bytesPerRow: width * 4 }, [width, height]);
        return texture;
      };
      const heightmap = makeHeightmap();
      const fromEast = { direction: [1, 0.2, 0], radius: 24, rays: 16, steps: 32 };
      const fromWest = { ...fromEast, direction: [-1, 0.2, 0] };
      async function read(options) {
        const texture = bakeTerrainReliefLighting(gpu, heightmap, size, options);
        const stride = Math.ceil((width * 8) / 256) * 256;
        const buffer = gpu.createBuffer({ size: stride * height, usage: 1 | 8 });
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [width, height]);
        gpu.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const view = new DataView(buffer.getMappedRange());
        const at = (x, z, channel = 0) => {
          const half = view.getUint16(z * stride + x * 8 + channel * 2, true);
          const exponent = (half >>> 10) & 31;
          const mantissa = half & 1023;
          return exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15);
        };
        const report = {
          west: at(24, 16),
          east: at(40, 16),
          ridge: at(32, 16),
          valleySky: at(24, 16, 1),
          openSky: at(2, 0, 1),
          edgeSun: at(62, 30),
        };
        buffer.unmap();
        buffer.destroy();
        texture.destroy();
        return report;
      }
      const east = await read(fromEast);
      const west = await read(fromWest);
      const zenith = await read({ ...fromEast, direction: [0, 1, 0] });
      heightmap.destroy();

      engine.camera.position = [31, 41, 62];
      engine.camera.target = [31, 0, 15];
      engine.lighting.direction.set([1, 0.2, 0, 3]);
      engine.lighting.radiance.set([1, 1, 1, 0.18]);
      const terrain = Terrain.attach(engine, {
        size,
        heightScale: 1,
        resolution: 32,
        levels: 4,
        layers: Array.from({ length: 4 }, () => ({ height: [-1, 100], slope: [0, 1], scale: 1 })),
        textures(device) {
          const layers = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm', usage: 6 });
          device.queue.writeTexture(
            { texture: layers },
            new Uint8Array(16).fill(138),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return { heightmap: makeHeightmap(), layers };
        },
      });
      const effect = TerrainReliefLighting.attach(engine, terrain, fromEast);
      const out = document.createElement('canvas');
      out.width = 160;
      out.height = 100;
      const paint = out.getContext('2d');
      async function capture() {
        await waitForPipelines(async () => {
          engine.render();
          await gpu.queue.onSubmittedWorkDone();
        });
        engine.render();
        paint.drawImage(canvas, 0, 0);
        const pixels = paint.getImageData(0, 0, 160, 100).data;
        return Array.from(pixels);
      }
      const shaded = await capture();
      effect.rebake(fromWest);
      const changed = await capture();
      effect.dispose();
      const unshaded = await capture();
      const medium = (image) => image.reduce((sum, pixel, index) => (index % 4 === 3 ? sum : sum + pixel), 0);
      return {
        east,
        west,
        zenith,
        delta: Math.abs(medium(shaded) - medium(unshaded)),
        switched: changed.reduce((sum, pixel, i) => sum + Math.abs(pixel - shaded[i]), 0),
        released: engine.sceneOf(effect) === undefined,
        validation: (await gpu.popErrorScope())?.message ?? null,
      };
    });
    assert.equal(result.validation, null);
    assert.deepEqual(errors, []);
    assert.equal(result.east.west, 0);
    assert.equal(result.east.east, 1);
    assert.equal(result.east.ridge, 1);
    assert.equal(result.west.west, 1);
    assert.equal(result.west.east, 0);
    assert.equal(result.zenith.west, 1);
    assert.equal(result.zenith.east, 1);
    assert.ok(result.east.openSky > 0.99 && result.east.valleySky < 0.89, JSON.stringify(result.east));
    assert.equal(result.east.edgeSun, 1);
    assert.ok(result.delta > 5000 && result.switched > 5000, JSON.stringify(result));
    assert.equal(result.released, true);
    console.log(
      'Terrain ridge casts directional shadows, valley receives less diffuse skylight, rebake and detach verified.',
    );
  },
  () => context.close(),
);
watchExit();
