import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { animatedTriangle } from '../tests/support/gltf-pro-fixture.js';
import { decodePNG } from '../tests/support/png.js';
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  const fixture = animatedTriangle();
  fixture.doc.nodes[1].children = [2];
  fixture.doc.nodes.push(
    { name: 'Knee', translation: [0, -1, 0], children: [3] },
    { name: 'Ankle', translation: [0, -1, 0] },
  );
  const result = await page.evaluate(
    async ({ doc, buffers }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { box, engineRuntime } = await import('/packages/core/dist/extension.js');
      const { parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { Animation } = await import('/packages/animation/dist/index.js');
      const { SSAO } = await import('/packages/post/dist/index.js');
      const { Shadows } = await import('/packages/shadows/dist/index.js'),
        { Clustered } = await import('/packages/clustered/dist/index.js'),
        { VFX } = await import('/packages/vfx/dist/index.js'),
        { Animator } = await import('/packages/animator/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js');
      const { TAA } = await import('/packages/taa/dist/index.js'),
        { Splats } = await import('/packages/splats/dist/index.js');
      const assert = (ok, message) => {
          if (!ok) throw new Error(message);
        },
        canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, {
          backend: 'webgpu',
          capacity: 128,
          camera: { position: [3, 3, 6], target: [0, 0, 0], near: 0.1, far: 100 },
        }),
        engine = engineRuntime(instance),
        device = engine.gpu,
        modules = [],
        create = device.createShaderModule.bind(device);
      device.createShaderModule = (d) => {
        const m = create(d);
        modules.push(m);
        return m;
      };
      device.pushErrorScope('validation');
      const model = parseGLTF(
          instance,
          doc,
          buffers.map((b) => new Uint8Array(b)),
        ),
        animation = Animation.attach(model),
        animator = Animator.attach(animation, { states: { move: 'Move' }, initial: 'move' });
      const taa = TAA.attach(instance);
      taa.add(model);
      const splats = Splats.attach(instance, {
        positions: new Float32Array([-1, 0.5, 0, 1, 0.5, 0]),
        covariances: new Float32Array([0.04, 0, 0, 0.01, 0, 0.01, 0.01, 0, 0, 0.04, 0, 0.01]),
        colors: new Float32Array([1, 0.1, 0.1, 0.5, 0.1, 0.1, 1, 0.5]),
      });
      const shadows = Shadows.attach(instance, { resolution: 128, distance: 30, lightSize: 0.03 }),
        clustered = Clustered.attach(instance, { grid: [4, 3, 4] }),
        particles = VFX.attach(instance, {
          capacity: 512,
          rate: 0,
          gravity: [0, 0, 0],
          velocity: [0, 0, 0],
          spread: 0,
          turbulence: 0,
          lifetime: [2, 2],
          position: [0, 1, 0],
        });
      clustered.add(model);
      shadows.add(model);
      const sharedGeometry = box(),
        staticMesh = instance.createMesh().setGeometry(sharedGeometry).setPosition([0, -0.5, 0]),
        secondStatic = instance.createMesh().setGeometry(sharedGeometry).setPosition([2, -0.5, 0]),
        dynamicMesh = instance.createMesh().setGeometry(box()).setPosition([0, 0.5, 1]);
      shadows.add(staticMesh, { static: true });
      shadows.add(secondStatic, { static: true });
      shadows.add(dynamicMesh);
      const lights = [
        { position: [0, 1, 1], range: 10, color: [1, 0, 0], intensity: 5 },
        {
          position: [0, 2, 0],
          range: 10,
          direction: [0, -1, 0],
          outerAngle: 0.7,
          innerAngle: 0.3,
          color: [0, 0, 1],
          intensity: 8,
        },
        { position: [500, 500, 500], range: 1 },
      ];
      clustered.setLights(lights);
      const terrain = Terrain.attach(instance, {
        resolution: 16,
        levels: 3,
        size: [100, 100],
        origin: [-50, -50],
        heightScale: 1,
        layers: Array.from({ length: 4 }, (_, i) => ({ height: [-10, 10], slope: [0, 1], scale: 1 + i })),
        textures: (device) => {
          const heightmap = device.createTexture({
              size: [4, 4],
              format: 'r32float',
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            }),
            layers = device.createTexture({
              size: [1, 1, 4],
              format: 'rgba8unorm-srgb',
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
          device.queue.writeTexture({ texture: heightmap }, new Float32Array(16).fill(-1), { bytesPerRow: 16 }, [4, 4]);
          device.queue.writeTexture(
            { texture: layers },
            new Uint8Array([30, 100, 30, 255, 90, 80, 65, 255, 100, 100, 100, 255, 200, 180, 120, 255]),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return { heightmap, layers };
        },
      });
      shadows.add(terrain, { static: true });
      clustered.add(terrain);
      particles.burst(100);
      instance.render({ culling: false, delta: 0.25 });
      await device.queue.onSubmittedWorkDone();
      const readBuffer = async (buffer, size = buffer.size) => {
        const read = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, read, 0, size);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const bytes = read.getMappedRange().slice(0);
        read.unmap();
        read.destroy();
        return bytes;
      };
      const indirect = new Uint32Array(await readBuffer(particles.gpuState.indirect));
      assert(indirect[0] === 3 && indirect[1] === 100, 'GPU particle compaction/indirect count failed: ' + indirect);
      const state = new Float32Array(await readBuffer(particles.gpuState.particles));
      let alive = 0;
      for (let i = 0; i < state.length / 2; i += 8) {
        if (state[i + 3] > 0) {
          alive++;
          assert(Math.abs(state[i + 1] - 1) < 1e-6, 'Unexpected particle position');
        }
      }
      assert(alive === 100, 'Particle lifetimes were not initialized');
      const skinned = new Float32Array(await readBuffer(model.primitives[0].deformed));
      assert(Math.abs(skinned[0] + 0.5) < 1e-5, 'Animator did not update the existing skinning palette: ' + skinned[0]);
      const counts = new Uint32Array(await readBuffer(clustered.lightLists.counts)),
        indices = new Uint32Array(await readBuffer(clustered.lightLists.indices));
      assert(
        counts.some((v) => v > 0),
        'No lights reached clusters',
      );
      for (let i = 0; i < counts.length; i++)
        for (let j = 0; j < counts[i]; j++) assert(indices[i * 1024 + j] < 2, 'Distant light survived culling');
      clustered.setLights(Array.from({ length: 1024 }, () => ({ position: [0, 1, 1], range: 10 })));
      instance.render({ culling: false });
      await device.queue.onSubmittedWorkDone();
      const crowdedCounts = new Uint32Array(await readBuffer(clustered.lightLists.counts)),
        crowdedIndices = new Uint32Array(await readBuffer(clustered.lightLists.indices));
      const fullCluster = crowdedCounts.findIndex((v) => v === 1024);
      assert(
        fullCluster !== -1 && crowdedIndices[fullCluster * 1024 + 1023] === 1023,
        'Crowded clusters truncated lights',
      );
      clustered.setLights(lights);
      assert(
        shadows.stats.staticDraws === 0 && shadows.stats.cacheHits === 1,
        'Stationary static shadow cache was not reused',
      );
      instance.render({ culling: false, delta: 0.1 });
      await device.queue.onSubmittedWorkDone();
      assert(
        shadows.stats.staticDraws === 0 && shadows.stats.cacheHits === 2,
        'Static shadow cache was not reused twice',
      );
      shadows.invalidate();
      instance.render({ culling: false });
      await device.queue.onSubmittedWorkDone();
      assert(shadows.stats.staticDraws === 8, 'Explicit shadow invalidation failed');
      // One million particles exercises real storage limits and a GPU-only indirect draw.
      const million = VFX.attach(instance, {
        capacity: 1_000_000,
        rate: 0,
        gravity: [0, 0, 0],
        turbulence: 0,
        size: 0.0001,
      });
      million.burst(1_000_000);
      instance.render({ culling: false });
      await device.queue.onSubmittedWorkDone();
      const largeArgs = new Uint32Array(await readBuffer(million.gpuState.indirect));
      assert(largeArgs[1] === 1_000_000, 'Million-particle indirect count failed');
      million.dispose();
      particles.options.rate = 0;
      instance.render({ culling: false, delta: 1 });
      instance.render({ culling: false, delta: 1 });
      await device.queue.onSubmittedWorkDone();
      const dead = new Uint32Array(await readBuffer(particles.gpuState.indirect));
      assert(dead[1] === 0, 'Dead particles were still drawn');
      const bounce = VFX.attach(instance, {
        capacity: 1,
        rate: 0,
        position: [0, 0.1, 0],
        velocity: [0, -2, 0],
        gravity: [0, -10, 0],
        size: 0.1,
        bounce: 0.5,
        turbulence: 0,
        spread: 0,
        lifetime: [3, 3],
      });
      bounce.burst(1);
      instance.render({ culling: false, delta: 0.25 });
      await device.queue.onSubmittedWorkDone();
      const bounced = new Float32Array(await readBuffer(bounce.gpuState.particles));
      assert(
        Math.abs(bounced[1] - 0.05) < 1e-6 && Math.abs(bounced[5] - 2.25) < 1e-6,
        'GPU gravity/ground collision failed',
      );
      bounce.dispose();
      const removeFoot = animator.addFootIK({
        hip: 1,
        knee: 2,
        ankle: 3,
        pole: [0, 0, 2],
        raycast: (origin) => ({ position: [origin[0], -1.5, origin[2]], normal: [0, 1, 0] }),
      });
      instance.render({ culling: false });
      await device.queue.onSubmittedWorkDone();
      assert(
        Math.abs(model.nodes[3].matrix[13] + 1.5) < 1e-5,
        'Foot IK did not place the ankle on terrain: ' + model.nodes[3].matrix[13],
      );
      assert(Math.abs(model.nodes[3].matrix[5] - 1) < 1e-5, 'Foot normal alignment failed');
      removeFoot();
      instance.camera.position = [5, 3, 6];
      instance.camera.target = [2, 0, 0];
      instance.render({ culling: false });
      await device.queue.onSubmittedWorkDone();
      assert(shadows.stats.staticDraws === 8, 'Camera motion did not invalidate static cascades');
      const ssao = SSAO.attach(instance, { samples: 8 });
      ssao.add(model);
      taa.options.depth = () => ssao.depthTexture;
      instance.render({ culling: false });
      await device.queue.onSubmittedWorkDone();
      ssao.dispose();
      delete taa.options.depth;
      const compile = (await Promise.all(modules.map((m) => m.getCompilationInfo()))).flatMap((i) =>
          i.messages.filter((m) => m.type === 'error').map((m) => m.message),
        ),
        validation = await device.popErrorScope();
      assert(!validation && compile.length === 0, JSON.stringify({ validation: validation?.message, compile }));
      await instance.rebootDevice();
      engine.gpu.pushErrorScope('validation');
      instance.render({ culling: false, delta: 0.1 });
      await engine.gpu.queue.onSubmittedWorkDone();
      const restored = await engine.gpu.popErrorScope();
      assert(!restored, 'Device recovery failed: ' + restored?.message);
      const summary = {
        particles: indirect[1],
        maxParticles: largeArgs[1],
        clusters: counts.length,
        litClusters: counts.filter((v) => v > 0).length,
        maxLightsPerCluster: crowdedCounts[fullCluster],
        shaderModules: modules.length,
        cacheHits: shadows.stats.cacheHits,
        taa: true,
        splats: splats.count,
      };
      window.gameScene = { instance, engine, shadows, clustered, terrain, animator };
      return summary;
    },
    {
      doc: fixture.doc,
      buffers: fixture.buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]),
    },
  );
  const lit = await decodePNG(await page.locator('canvas').screenshot({ path: 'test-results/game-lit.png' }));
  await page.evaluate(async () => {
    const s = window.gameScene;
    s.engine.gpu.pushErrorScope('validation');
    s.clustered.dispose();
    s.instance.render({ culling: false });
    await s.engine.gpu.queue.onSubmittedWorkDone();
  });
  const shadowed = await decodePNG(await page.locator('canvas').screenshot({ path: 'test-results/game-shadowed.png' }));
  await page.evaluate(async () => {
    const s = window.gameScene;
    s.shadows.options.lightSize = 0;
    s.instance.render({ culling: false });
    await s.engine.gpu.queue.onSubmittedWorkDone();
  });
  const hard = await decodePNG(await page.locator('canvas').screenshot());
  await page.evaluate(async () => {
    const s = window.gameScene;
    s.shadows.options.lightSize = 0.3;
    s.instance.render({ culling: false });
    await s.engine.gpu.queue.onSubmittedWorkDone();
  });
  const soft = await decodePNG(await page.locator('canvas').screenshot({ path: 'test-results/game-soft-shadows.png' }));
  await page.evaluate(async () => {
    const s = window.gameScene;
    s.shadows.dispose();
    s.instance.render({ culling: false });
    await s.engine.gpu.queue.onSubmittedWorkDone();
  });
  const plain = await decodePNG(await page.locator('canvas').screenshot({ path: 'test-results/game-plain.png' }));
  const changed = (a, b) => {
    let count = 0;
    for (let i = 0; i < a.data.length; i += 4)
      if (
        Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]) >
        3
      )
        count++;
    return count;
  };
  result.clusteredPixels = changed(lit, shadowed);
  result.shadowPixels = changed(shadowed, plain);
  assert.ok(result.clusteredPixels > 20, 'Clustered lighting did not affect rendered pixels');
  assert.ok(result.shadowPixels > 20, 'CSM/PCSS did not affect rendered pixels');
  assert.ok(
    result.shadowPixels < (plain.width * plain.height) / 10,
    'Flat terrain developed widespread self-shadow acne',
  );
  result.pcssPixels = changed(hard, soft);
  assert.ok(result.pcssPixels > 10, 'PCSS light size did not change penumbra filtering');
  await page.evaluate(async () => {
    const s = window.gameScene,
      error = await s.engine.gpu.popErrorScope();
    if (error) throw new Error(error.message);
    s.instance.dispose();
    if (s.engine.hasPlugin(s.animator.name) || s.engine.hasPlugin(s.terrain.name))
      throw new Error('Game plugin cleanup leaked');
  });
  assert.deepEqual(errors, []);
  await writeFile('test-results/modern-game.json', JSON.stringify({ hardware, ...result }, null, 2));
  console.log(JSON.stringify({ hardware, ...result }, null, 2));
} finally {
  await browser.close();
}
await import('./modern-temporal-tests.js');
