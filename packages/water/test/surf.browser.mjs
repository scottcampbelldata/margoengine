// KB-WATER-SURF1 regression: a plain swell on a 1:50 sand beach shoals, breaks in lines in the surf zone, stays
// unbroken offshore and runs up the beach, from Water.attach with no surf options. It evaluates the water shader's own
// surfHere at points along the beach normal and reads the coastal flow state, on WebGPU or (MARGO_COMPAT=1) the WebGL2
// compatibility layer. The CPU breaker line (Water.breakerLine, from terrain.heights) sits where the shader breaks, for
// the swell and for a wind sea (KB-WATER-SURFFIELD1: a wind sea's empty long trains set the surf field, so it never broke).
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
  const run = (variant) => page.evaluate(async (variant) => {
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
    // Shore at x = 0, the sea toward +x: 1:50 below the waterline, 1:28 above it, 7 m deep at the map's sea edge.
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
    const water = Water.attach(engine, {
      size: [1200, 1200],
      segments: 128,
      horizon: true,
      terrain: {
        heightmap: () => terrain.texture,
        origin: [-50, -32],
        size: [400, 64],
        // The same beach on the CPU, 400 x 64 texels, for the breaker line.
        heights: { data: Float32Array.from({ length: 400 * 64 }, (_, i) => ground(-50 + (i % 400) + 0.5)), width: 400, height: 64 },
      },
      depth: () => post.depthTexture,
      sceneColor: () => scene,
      // A 60 m swell (6.2 s) of 1 m height running straight onto the beach, or the sea of a wind blowing onshore.
      ...(variant.wind
        ? { wind: { speed: variant.wind, direction: [-1, 0] } }
        : { waves: [{ direction: [-1, 0], amplitude: 0.5, wavelength: 60, steepness: 0.35 }] }),
    });
    engine.gpu.pushErrorScope('validation');
    const started = performance.now();
    engine.render({ delta: 0 });
    await engine.gpu.queue.onSubmittedWorkDone();
    // The first frame builds the surf field and spins the flow up over the surf's last 40 s (KB-WATER-SWASH1).
    const firstFrame = performance.now() - started;
    // On the WebGL2 layer: compute dispatches its CPU tier ran for the first frame, the surf field's build among them.
    const cpu = engine.gpu.dispatches?.cpu;
    engine.gpu.createShaderModule = create;
    if (!source) return { error: 'the water shader has no surfHere' };
    const xs = Array.from({ length: 170 }, (_, i) => 1 + i * 2);
    const device = engine.gpu,
      data = new Float32Array(xs.flatMap((x) => [x, 0, 0.5, 0])),
      queries = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      results = device.createBuffer({
        size: xs.length * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
      read = device.createBuffer({ size: results.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(queries, 0, data);
    const module = device.createShaderModule({
      code:
        source +
        `
@group(0) @binding(8) var<storage,read> queries:array<vec4f>;
@group(0) @binding(9) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(32) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&queries)){return;}let q=queries[id.x];let here=surfHere(q.xy,q.z,true);let s=here.surf;
 results[id.x*2u]=vec4f(s.offset,s.breaking);results[id.x*2u+1u]=vec4f(s.foam,here.weight,s.stir);
}`,
    });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'probe' } });
    // The swash: the highest ground under more than 5 mm of water along the middle row, every third frame of `frames`
    // frames at 30 fps (the wind sea's run is not measured).
    const state = () => water.coastal.states[water.coastal.current];
    const swash = async (frames) => {
      let top = -1;
      for (let i = 0; i < (variant.wind ? 0 : frames); i++) {
        engine.render({ delta: 1 / 30 });
        if (i % 3) continue;
        const t = state(),
          row = Math.floor(t.height / 2),
          buffer = device.createBuffer({ size: t.width * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: t, origin: [0, row, 0] }, { buffer, bytesPerRow: t.width * 16 }, [
          t.width,
          1,
          1,
        ]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const f = new Float32Array(buffer.getMappedRange().slice(0));
        buffer.unmap();
        buffer.destroy();
        for (let c = 0; c < t.width; c++) if (f[c * 4] > 0.005 && f[c * 4 + 1] > 0) top = Math.max(top, f[c * 4 + 1]);
      }
      return top;
    };
    // The first wave period (6.2 s) from the first frame: the spun-up flow already runs up the beach.
    const early = await swash(186);
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
    // 48 phases over 30 s (several wave groups): the highest crest, the most breaking and the most foam at each point.
    const crest = xs.map(() => -1e9),
      trough = xs.map(() => 1e9),
      breaking = xs.map(() => 0),
      foam = xs.map(() => 0),
      weight = xs.map(() => 0);
    // fixed-wait: 48 deliberate sample phases, each set by setTime (no readiness is awaited).
    for (let step = 0; step < 48; step++) {
      water.setTime(40 + step * 0.63);
      engine.render({ delta: 0 });
      const v = await sample();
      xs.forEach((_, i) => {
        crest[i] = Math.max(crest[i], v[i * 8 + 1]);
        trough[i] = Math.min(trough[i], v[i * 8 + 1]);
        breaking[i] = Math.max(breaking[i], v[i * 8 + 3]);
        foam[i] = Math.max(foam[i], v[i * 8 + 4], v[i * 8 + 5]);
        weight[i] = Math.max(weight[i], v[i * 8 + 6]);
      });
    }
    const line = water.breakerLine().flat().map(([x]) => x);
    // Then 20 s more of flow (the probes above jumped the surf's clock to 40 to 70 s) and the run-up over five wave
    // periods (31 s, several wave groups of the three-component train).
    for (let i = 0; i < (variant.wind ? 0 : 600); i++) {
      engine.render({ delta: 1 / 30 });
      if (i % 30 === 29) await device.queue.onSubmittedWorkDone();
    }
    const runUp = await swash(930);
    const validation = (await engine.gpu.popErrorScope())?.message;
    queries.destroy();
    results.destroy();
    read.destroy();
    scene.destroy();
    engine.dispose();
    return { xs, crest, trough, breaking, foam, weight, runUp, early, firstFrame, validation, line, cpu };
  }, variant);
  const result = await run({});
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.validation, undefined, result.validation);
  // The surf field's sweeps (width + height of them, 594 here) run on the GPU tiers of the WebGL2 layer, not one
  // invocation at a time in JavaScript: until 2026-11-18 they shared the deepest edge's atomic module, so the layer's
  // CPU tier ran them all and the first frame took about 7 minutes (KB-WATER-SURFCPU1).
  if (result.cpu !== undefined) assert.ok(result.cpu < 16, `the first frame ran ${result.cpu} compute dispatches on the CPU tier`);
  const { xs, crest, trough, breaking, foam, weight, runUp, early } = result,
    depth = (x) => x / 50,
    band = (lo, hi) => xs.map((x, i) => [x, i]).filter(([x]) => depth(x) >= lo && depth(x) < hi);
  // Offshore of the break (deeper than 3 m) the swell is whole: no breaking and no surf foam.
  for (const [x, i] of band(3, 6.5)) {
    assert.ok(breaking[i] < 0.05, `the swell breaks ${breaking[i].toFixed(2)} at ${x} m in ${depth(x)} m of water`);
    assert.ok(foam[i] < 0.05, `surf foam ${foam[i].toFixed(2)} at ${x} m in ${depth(x)} m of water`);
  }
  // Shoaling: the 1 m swell grows as it slows (Green's law) before it breaks near 0.78 of the depth.
  const height = (i) => crest[i] - trough[i],
    deep = band(5.5, 6.5).map(([, i]) => height(i)),
    shoal = band(1.6, 2.0).map(([, i]) => height(i));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(mean(shoal) > mean(deep) * 1.1, `no shoaling: ${mean(deep).toFixed(2)} m offshore, ${mean(shoal).toFixed(2)} m at 2 m`);
  // The surf zone (0.4 to 1.4 m deep) breaks, with roller foam, and the breaking height is depth limited.
  const surf = band(0.4, 1.4);
  assert.ok(Math.max(...surf.map(([, i]) => breaking[i])) > 0.8, 'no wave breaks in the surf zone');
  assert.ok(Math.min(...surf.map(([, i]) => foam[i])) > 0.3, 'the surf zone has no foam');
  for (const [x, i] of surf)
    assert.ok(height(i) < 0.78 * depth(x) * 1.6 + 0.05, `a ${height(i).toFixed(2)} m wave stands in ${depth(x)} m at ${x} m`);
  // The surf field reaches every connected sea cell along the beach.
  assert.ok(band(0.1, 6.5).every(([, i]) => weight[i] > 0.99), 'the surf field is missing over the beach');
  // KB-WATER-SWASH1 regression: the bores run up the dry beach as far as measured beaches do, from the first frame.
  // Stockdon et al. 2006 (Coastal Engineering 53(7), https://doi.org/10.1016/j.coastaleng.2005.12.005), eq. 18 for a
  // dissipative beach (Iribarren number tan(beta) / sqrt(H0 / L0) = 0.155 here, under 0.3): the run-up exceeded by 2% of
  // waves is R2 = 0.043 sqrt(H0 L0) = 0.333 m for H0 = 1 m and L0 = 60 m. Run-up heights follow a Rayleigh distribution,
  // so the significant run-up, which a train of waves of height H0 reaches, is R2 / sqrt(ln(50) / 2) = R2 / 1.40 = 0.238 m.
  // Stockdon's statistics are of random field seas; this sea is three regular trains, for which the reference is Hunt's
  // law for regular waves (I. A. Hunt, "Design of seawalls and breakwaters", Journal of the Waterways and Harbors Division
  // 85(3), 1959; R. G. Dean and R. A. Dalrymple, "Coastal Processes with Engineering Applications", 2002, ch. 4),
  // R = H0 tan(beta) / sqrt(H0 / L0): 0.155 m on the 1:50 slope the waves break on (0.277 m on the 1:28 foreshore). The
  // flow must land within 30% of it. The old virtual pipe ran up 0.014 to 0.042 m; this flow runs 0.126 m on 0.78 m cells,
  // about half Stockdon's significant run-up, and more on finer cells (docs/limits.md).
  const R2 = 0.043 * Math.sqrt(1 * 60),
    significant = R2 / Math.sqrt(Math.log(50) / 2),
    hunt = (1 / 50 / Math.sqrt(1 / 60)) * 1;
  assert.ok(
    Math.abs(runUp / hunt - 1) <= 0.3,
    `the swash runs ${runUp.toFixed(3)} m up the beach; Hunt 1959 gives ${hunt.toFixed(3)} m for these regular waves`,
  );
  // The flow spins up over the surf's 40 s before the first frame, so the first wave period already runs up at least half
  // as far; the old flow started at rest and first wetted the sand about 20 s in (2 sqrt(h / g) / slope from 0.35 m).
  assert.ok(early >= 0.5 * runUp, `the first 6.2 s run up ${early.toFixed(3)} m, against ${runUp.toFixed(3)} m later`);
  // The CPU breaker line: one straight line along the beach where the shader's swell breaks, and every probe between it
  // and the inner surf zone breaks (the mean envelope reaches 0.78 of the depth there, its sets sooner).
  const breaksAtLine = (r, label) => {
    assert.ok(r.line.length > 0, `${label}: no breaker line`);
    const x = r.line.reduce((s, v) => s + v, 0) / r.line.length;
    assert.ok(Math.max(...r.line) - Math.min(...r.line) < 1e-3, `${label}: the line is straight along the beach: ${Math.min(...r.line)} to ${Math.max(...r.line)}`);
    const inside = r.xs.map((p, i) => [p, i]).filter(([p]) => p <= x && depth(p) >= 0.4);
    assert.ok(inside.length > 3, `${label}: the line at ${x} m leaves no probes inside it`);
    for (const [p, i] of inside) assert.ok(r.breaking[i] > 0.5, `${label}: inside the breaker line at ${x} m, ${p} m breaks only ${r.breaking[i].toFixed(2)}`);
    return x;
  };
  const swellLine = breaksAtLine(result, 'swell');
  const windy = await run({ wind: 12 });
  assert.equal(windy.error, undefined, windy.error);
  assert.equal(windy.validation, undefined, windy.validation);
  const windLine = breaksAtLine(windy, 'wind sea');
  assert.ok(windLine > swellLine, `the 12 m/s sea breaks further out (${windLine} m) than the 1 m swell (${swellLine} m)`);
  assert.deepEqual(errors, []);
  console.log(`breaker line: swell ${depth(swellLine).toFixed(2)} m deep, 12 m/s wind sea ${depth(windLine).toFixed(2)} m deep; the shader breaks inside both`);
  console.log(
    `surf: breaking from ${Math.max(...band(0, 6.5).filter(([, i]) => breaking[i] > 0.5).map(([x]) => depth(x))).toFixed(2)} m deep, ` +
      `height ${mean(deep).toFixed(2)} m offshore and ${mean(shoal).toFixed(2)} m at 2 m, run-up ${runUp.toFixed(3)} m ` +
      `(${early.toFixed(3)} m in the first wave period; Hunt 1959 ${hunt.toFixed(3)} m, Stockdon 2006 significant ${significant.toFixed(3)} m), ` +
      `first frame ${result.firstFrame.toFixed(0)} ms`,
  );
} finally {
  await browser.close();
}
