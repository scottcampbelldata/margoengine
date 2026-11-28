// The rendered surface must follow Flood's elevations to the edge of an inland map.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { Flood } = await import('/packages/water/dist/flood.js');
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:80px;height:48px';
    document.body.replaceChildren(canvas);
    const camera = { position: [2, 16, 12], target: [0, 0, 0], near: 0.1, far: 200 };
    const engine = await EngineKernel.create(canvas, { backend: 'webgpu', camera });
    const device = engine.gpu;
    const waterShaders = [];
    const createShaderModule = device.createShaderModule.bind(device);
    device.createShaderModule = (descriptor) => {
      if (descriptor.code.includes('@fragment fn fragment(i:Output)->Result')) waterShaders.push(descriptor.code);
      return createShaderModule(descriptor);
    };
    device.pushErrorScope('validation');
    const columns = 40,
      rows = 32,
      width = 20,
      length = 16;
    const terrain = device.createTexture({
      size: [columns, rows],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: terrain }, new Float32Array(columns * rows), { bytesPerRow: columns * 4 }, [
      columns,
      rows,
    ]);
    const sample = async (boundary, checkDetach = false) => {
      const water = Water.attach(engine, {
        height: -6,
        size: [width, length],
        segments: 16,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 1.6 }],
        terrain: { heightmap: () => terrain, origin: [-10, -8], size: [width, length] },
        fill: () => 2,
      });
      const flood = Flood.attach(engine, { surface: water, maxDepth: 2.2, maxSpeed: 6, boundary, farField: null });
      engine.render({ delta: 0 });
      const reading = await flood.read();
      const mesh = await WaveQuery.capture(water);
      const at = [
        [0, 16],
        [columns - 1, 16],
        [20, 0],
        [20, rows - 1],
        [1, 1],
        [20, 16],
      ].map(([i, j]) => {
        const k = j * columns + i;
        return {
          solver: reading.depth[k] + reading.bed[k],
          rendered: mesh.heightAt(-10 + (i + 0.5) * 0.5, -8 + (j + 0.5) * 0.5),
        };
      });
      flood.dispose();
      if (checkDetach) engine.render({ delta: 0 });
      water.dispose();
      return at;
    };
    const inland = await sample({ east: 'open' });
    // Isolate the edge blend from the far field that already joins the sea to the solved edge.
    const coastal = await sample({ west: 'sea', east: 'open' }, true);
    const validation = (await device.popErrorScope())?.message ?? '';
    engine.dispose();
    terrain.destroy();
    return {
      inland,
      coastal,
      validation,
      surf: waterShaders.map((source) => /const COAST_SURF=(true|false);/.exec(source)?.[1]),
    };
  });
  assert.deepEqual(errors, []);
  assert.equal(result.validation, '');
  assert.deepEqual(result.surf, ['false', 'false', 'true']);
  for (const { solver, rendered } of result.inland)
    assert.ok(Math.abs(rendered - solver) < 1e-4, JSON.stringify({ solver, rendered }));
  const [sea, ...land] = result.coastal;
  assert.ok(sea.rendered < sea.solver - 1, 'A side marked sea still blends into the offshore surface.');
  for (const { solver, rendered } of land.slice(0, 3))
    assert.ok(Math.abs(rendered - solver) < 1e-4, JSON.stringify({ solver, rendered }));
  console.log('Flood surface follows inland boundary elevations and retains the sea transition.');
} finally {
  await browser.close();
}
