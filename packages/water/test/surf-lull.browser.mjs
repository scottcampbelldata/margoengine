// KB-WATER-FOAMPATCH-KH1 regression: two swell trains of different length (the dune coast's 72 m and 41 m) beat into
// wave groups, and where they cancel the swell's envelope breaks nothing for a moment. The water's shoreline foam band
// and foam lines are held off where the surf breaks; they read the instant breaking, so in a lull inside the surf zone
// they came on at full strength and drew a flat, hard-edged pale patch (an ellipse in the Kitty Hawk s18 still). The
// gate is now the steady share of breaking waves (Battjes and Janssen 1978, `zone`). This test evaluates the water
// shader's own surfHere along a 1:50 beach at 40 phases over two group periods, on WebGPU or (MARGO_COMPAT=1) the WebGL2
// compatibility layer, and checks that the setup has lulls, that the zone does not move with them, and that the
// shoreline gate stays shut across the surf zone at every phase.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  const result = await page.evaluate(async () => {
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
      size: [400, 64],
      origin: [-50, -32],
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
    // The dune coast's swell at its default 1.2 m surf: 72 m and 41 m trains, both onshore.
    const water = Water.attach(engine, {
      size: [1200, 1200],
      segments: 128,
      horizon: true,
      terrain: { heightmap: () => terrain.texture, origin: [-50, -32], size: [400, 64] },
      depth: () => post.depthTexture,
      sceneColor: () => scene,
      waves: [
        { direction: [-1, 0], amplitude: 0.45, wavelength: 72, steepness: 0.45, phase: 0.4 },
        { direction: [-1, 0], amplitude: 0.24, wavelength: 41, steepness: 0.45, phase: 2.2 },
      ],
    });
    engine.gpu.pushErrorScope('validation');
    engine.render({ delta: 0 });
    await engine.gpu.queue.onSubmittedWorkDone();
    engine.gpu.createShaderModule = create;
    if (!source) return { error: 'the water shader has no surfHere' };
    const xs = Array.from({ length: 160 }, (_, i) => 1 + i * 2),
      device = engine.gpu,
      data = new Float32Array(xs.flatMap((x) => [x, 0, 0.5, 0])),
      queries = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      results = device.createBuffer({ size: xs.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      read = device.createBuffer({ size: results.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(queries, 0, data);
    // x: the instant breaking the gate read before the fix, y: the steady zone it reads now, z: the shoreline gate.
    const module = device.createShaderModule({
      code:
        source +
        `
@group(0) @binding(8) var<storage,read> queries:array<vec4f>;
@group(0) @binding(9) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(32) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&queries)){return;}let q=queries[id.x];let here=surfHere(q.xy,q.z,true);
 let zone=here.weight*here.surf.zone;
 results[id.x]=vec4f(here.weight*here.surf.breaking,zone,1.0-smoothstep(0.0,0.3,zone),here.weight);
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
      pass.dispatchWorkgroups(Math.ceil(xs.length / 32));
      pass.end();
      encoder.copyBufferToBuffer(results, 0, read, 0, results.size);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = Array.from(new Float32Array(read.getMappedRange()));
      read.unmap();
      return values;
    };
    // The group period of 72 m and 41 m deep-water swell is 2 pi / (omega2 - omega1) = 25.9 s; 40 phases over 52 s.
    const instant = xs.map(() => [1e9, -1e9]),
      zone = xs.map(() => [1e9, -1e9]),
      gate = xs.map(() => 0),
      weight = xs.map(() => 1);
    // fixed-wait: 40 deliberate sample phases, each set by setTime (no readiness is awaited).
    for (let step = 0; step < 40; step++) {
      water.setTime(40 + step * 1.3);
      engine.render({ delta: 0 });
      const v = await sample();
      xs.forEach((_, i) => {
        instant[i] = [Math.min(instant[i][0], v[i * 4]), Math.max(instant[i][1], v[i * 4])];
        zone[i] = [Math.min(zone[i][0], v[i * 4 + 1]), Math.max(zone[i][1], v[i * 4 + 1])];
        gate[i] = Math.max(gate[i], v[i * 4 + 2]);
        weight[i] = Math.min(weight[i], v[i * 4 + 3]);
      });
    }
    const validation = (await engine.gpu.popErrorScope())?.message;
    queries.destroy();
    results.destroy();
    read.destroy();
    scene.destroy();
    engine.dispose();
    return { xs, instant, zone, gate, weight, validation };
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.validation, undefined, result.validation);
  const { xs, instant, zone, gate, weight } = result,
    depth = (x) => x / 50,
    band = (lo, hi) => xs.map((x, i) => [x, i]).filter(([x]) => depth(x) >= lo && depth(x) < hi);
  const surf = band(0.05, 1.2);
  assert.ok(
    surf.every(([, i]) => weight[i] > 0.99),
    'the surf field is missing over the beach',
  );
  // The setup has what drew the patch: inside the surf zone the instant breaking falls to nothing in a lull.
  const lulls = surf.filter(([, i]) => instant[i][0] < 0.05);
  assert.ok(lulls.length > 0, 'no wave-group lull in the surf zone: the test no longer covers the defect');
  for (const [x, i] of surf) {
    // The zone is a property of the place: it does not beat with the groups.
    assert.ok(
      zone[i][1] - zone[i][0] < 1e-4,
      `the surf zone share at ${x} m swings ${zone[i][0].toFixed(3)} to ${zone[i][1].toFixed(3)} with the groups`,
    );
    // And the shoreline foam band and foam lines stay off there at every phase, lull or not.
    assert.ok(gate[i] < 0.01, `the shoreline foam opens to ${gate[i].toFixed(2)} at ${x} m (${depth(x)} m deep)`);
  }
  // Offshore of the break the zone is open sea: the shoreline gate is wide open there.
  for (const [x, i] of band(4.5, 6.5))
    assert.ok(zone[i][1] < 0.02, `${depth(x)} m deep at ${x} m reads ${zone[i][1].toFixed(3)} of waves breaking`);
  assert.deepEqual(errors, []);
  console.log(
    `surf lull: ${lulls.length} of ${surf.length} surf-zone probes reach a lull; the shoreline gate stays under ` +
      `${Math.max(...surf.map(([, i]) => gate[i])).toFixed(4)} across the surf zone`,
  );
} finally {
  await browser.close();
}
