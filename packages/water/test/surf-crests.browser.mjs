// KB-WATER-SURFBANDS1 regression: real surf breaks in short-crested sections. Breaking starts and stops along a crest,
// and the breaking crests are shorter the wider the sea's directional spread (Baker et al. 2023). Water's roller rode
// every crest of the surf zone from one side of the frame to the other at one strength, so the Kitty Hawk s18 shot drew
// long, even, pale bands. This test evaluates the water shader's own surfHere over a 1:50 beach under the dune coast's
// two swell trains (72 m and 41 m, 43 degrees apart), on WebGPU or (MARGO_COMPAT=1) the WebGL2 compatibility layer.
// Along the shore it takes, at each point, the strongest roller within one surf wavelength across it: on a long-crested
// band that is the same everywhere; on short-crested surf it has sections, with gaps between them.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const compat = process.env.MARGO_COMPAT === '1' || process.argv.includes('--compat');
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
// The window across the shore: 0.5 to 0.9 m deep on 1:50, about one surf wavelength (the 72 m swell is 19 m long at
// 0.8 m), every 0.5 m; along the shore 240 m every 0.5 m.
const xs = Array.from({ length: 40 }, (_, i) => 25 + i * 0.5),
  zs = Array.from({ length: 481 }, (_, i) => -120 + i * 0.5),
  times = [40, 47.3, 55.9];
try {
  const result = await page.evaluate(
    async ({ compat, xs, zs, times }) => {
      if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { Water } = await import('/packages/water/dist/index.js'),
        { Bloom } = await import('/packages/post/dist/index.js'),
        { TerrainHeightmap } = await import('/packages/terrain/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:200px';
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [-20, 6, 0], target: [60, 0, 0], near: 0.1, far: 2000 },
      });
      const post = Bloom.attach(engine, { strength: 0, exposure: 0 });
      // Shore at x = 0, the sea toward +x: 1:50 below the waterline, 1:28 above it.
      const ground = (x) => (x > 0 ? -x / 50 : -x / 28);
      const terrain = TerrainHeightmap.attach(engine, (x) => ground(x), {
        size: [240, 320],
        origin: [-40, -160],
        resolution: 512,
      });
      let source = '';
      const create = engine.gpu.createShaderModule.bind(engine.gpu);
      engine.gpu.createShaderModule = (descriptor) => {
        if (descriptor.code.includes('fn surfHere')) source = descriptor.code;
        return create(descriptor);
      };
      const scene = engine.gpu.createTexture({
        size: [320, 200],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      // The dune coast's swell at its default 1.2 m surf (packages/scenes/src/dune-coast.ts).
      const water = Water.attach(engine, {
        size: [1200, 1200],
        segments: 128,
        horizon: true,
        terrain: { heightmap: () => terrain.texture, origin: [-40, -160], size: [240, 320] },
        depth: () => post.depthTexture,
        sceneColor: () => scene,
        waves: [
          { direction: [-0.97, 0.24], amplitude: 0.45, wavelength: 72, steepness: 0.45, phase: 0.4 },
          { direction: [-0.88, -0.47], amplitude: 0.24, wavelength: 41, steepness: 0.45, phase: 2.2 },
        ],
      });
      engine.gpu.pushErrorScope('validation');
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
      engine.gpu.createShaderModule = create;
      if (!source) return { error: 'the water shader has no surfHere' };
      const device = engine.gpu,
        points = zs.flatMap((z) => xs.flatMap((x) => [x, z, 0.5, 0])),
        data = new Float32Array(points),
        count = points.length / 4,
        queries = device.createBuffer({
          size: data.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
        results = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
        read = device.createBuffer({ size: results.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(queries, 0, data);
      const module = device.createShaderModule({
        code:
          source +
          `
@group(0) @binding(8) var<storage,read> queries:array<vec4f>;
@group(0) @binding(9) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&queries)){return;}let q=queries[id.x];let here=surfHere(q.xy,q.z,true);
 results[id.x]=vec4f(here.surf.foam.x*here.weight,here.weight*here.surf.zone,here.weight,0.0);
}`,
      });
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'probe' } });
      const sample = async () => {
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: water.uniform } },
            { binding: 3, resource: water.coastal.views[water.coastal.current] },
            { binding: 7, resource: { buffer: water.coastal.connected } },
            { binding: 8, resource: { buffer: queries } },
            { binding: 9, resource: { buffer: results } },
          ],
        });
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();
        encoder.copyBufferToBuffer(results, 0, read, 0, results.size);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(read.getMappedRange()));
        read.unmap();
        return values;
      };
      const frames = [];
      // fixed-wait: three deliberate sample times, each set by setTime (no readiness is awaited).
      for (const time of times) {
        water.setTime(time);
        engine.render({ delta: 0 });
        const v = await sample();
        // Per point along the shore: the strongest roller across the window, the least zone and the least weight.
        frames.push(
          zs.map((_, j) => {
            let roller = 0,
              zone = 1,
              weight = 1;
            for (let i = 0; i < xs.length; i++) {
              const at = (j * xs.length + i) * 4;
              roller = Math.max(roller, v[at]);
              zone = Math.min(zone, v[at + 1]);
              weight = Math.min(weight, v[at + 2]);
            }
            return [roller, zone, weight];
          }),
        );
      }
      const validation = (await engine.gpu.popErrorScope())?.message;
      queries.destroy();
      results.destroy();
      read.destroy();
      scene.destroy();
      engine.dispose();
      return { frames, validation };
    },
    { compat, xs, zs, times },
  );
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.validation, undefined, result.validation);
  const { frames } = result;
  for (const frame of frames) {
    assert.ok(
      frame.every(([, zone, weight]) => weight > 0.99 && zone > 0.3),
      'the window is not all surf zone: the test no longer covers the defect',
    );
  }
  // Along the shore: the share of points whose strongest roller across the window is under half (the gaps between
  // breaking sections), the coefficient of variation of that roller, and the mean length of the sections over half.
  const stats = frames.map((frame) => {
    const rollers = frame.map(([roller]) => roller),
      mean = rollers.reduce((sum, r) => sum + r, 0) / rollers.length,
      deviation = Math.sqrt(rollers.reduce((sum, r) => sum + (r - mean) ** 2, 0) / rollers.length),
      gaps = rollers.filter((r) => r < 0.5).length / rollers.length,
      runs = [];
    let run = 0;
    for (const r of rollers) {
      if (r >= 0.5) run++;
      else if (run) {
        runs.push(run * 0.5);
        run = 0;
      }
    }
    if (run) runs.push(run * 0.5);
    return {
      mean,
      variation: deviation / Math.max(mean, 1e-6),
      gaps,
      sections: runs.length,
      length: runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : 0,
      longest: Math.max(0, ...runs),
    };
  });
  assert.deepEqual(errors, []);
  console.log(
    `surf crests: ${JSON.stringify(stats.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.toFixed(3)]))))}`,
  );
  for (const s of stats) {
    // There is surf: breaking sections cover most of the shore.
    assert.ok(s.gaps < 0.6, `the roller is under half along ${(s.gaps * 100).toFixed(0)}% of the shore`);
    // And it is short-crested: gaps between sections, several sections, none the whole 240 m.
    assert.ok(s.gaps > 0.1, `the roller is unbroken along ${((1 - s.gaps) * 100).toFixed(0)}% of the shore`);
    assert.ok(s.sections >= 4, `only ${s.sections} breaking sections along 240 m of shore`);
    assert.ok(s.variation > 0.25, `the roller varies by ${(s.variation * 100).toFixed(0)}% along the shore`);
    // No section runs on like a band: the longest is under 60 m (the s18 frame is about 50 m wide at the surf).
    assert.ok(s.longest < 60, `a breaking section runs ${s.longest} m along the shore`);
  }
} finally {
  await browser.close();
}
