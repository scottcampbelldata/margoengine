// KB-WATER-SHORESAW1 regression: the waterline of a flowing sea on a beach is a straight line where the sea's level meets
// the sand, not a staircase of the coastal grid's cells. A plane beach of 1:50 runs diagonally across 4 m heightmap
// cells under a calm sea; seen from above, the first water pixel of each row lies on one straight line. The dry cells'
// depth, clamped to 0, put the line on their centres: a step of a whole cell wherever the line crossed into the next row
// (the dune coast's near shoreline drew teeth 0.78 by 3.9 m). Then the mesh: a pond held 3 m above the sea in a bowl,
// probed with the water shader's own surface() on the dry slope just past its waterline, stands at the pond's level.
// A vertex whose four texels were dry took the sea's level, so the triangle from the last wet vertex dived under the
// sand within one mesh cell and the waterline stepped with the mesh. Runs on WebGPU or (MARGO_COMPAT=1) the WebGL2 layer.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  const r = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js'),
      { Water } = await import('/packages/water/dist/index.js'),
      { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const W = 480,
      H = 320,
      canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${W}px;height:${H}px`;
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 200, 0.01], target: [0, 0, 0], near: 1, far: 5000 },
      }),
      device = engine.gpu;
    device.pushErrorScope('validation');
    // 128 x 128 cells of 4 m over 512 m. The beach rises 1 in 50 along the diagonal (x - z) / sqrt 2, so the sea at
    // level 0 meets it on the line x = z, which crosses a new row of cells every cell.
    const N = 128,
      CELL = 4,
      ground = new Float32Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = -256 + (i + 0.5) * CELL,
          z = -256 + (j + 0.5) * CELL;
        ground[j * N + i] = ((x - z) * Math.SQRT1_2) / 50;
      }
    const texture = device.createTexture({
      size: [N, N],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, ground, { bytesPerRow: N * 4 }, [N, N]);
    const water = Water.attach(engine, {
      size: [512, 512],
      segments: 64,
      height: 0,
      color: [0.9, 0.1, 0.1],
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 20 }],
      lights: [],
      terrain: { heightmap: () => texture, origin: [-256, -256], size: [512, 512] },
    });
    await waitForPipelines(() => engine.render({ delta: 1 / 60 }));
    // fixed-wait: 60 frames of the calm flow settling at the sea's level.
    for (let i = 0; i < 60; i++) {
      engine.render({ delta: 1 / 60 });
      await device.queue.onSubmittedWorkDone();
    }
    const off = new OffscreenCanvas(W, H),
      c = off.getContext('2d', { willReadFrequently: true });
    canvas.setAttribute('width', W);
    engine.render({ delta: 1 / 60 });
    c.drawImage(canvas, 0, 0);
    const image = c.getImageData(0, 0, W, H).data;
    const validation = (await device.popErrorScope())?.message;
    water.dispose();
    texture.destroy();
    engine.dispose();
    // Water pixels differ from the clear colour, which the dry corner of the frame shows. The dry side is +x (right).
    const clear = (W - 1) * 4,
      isWater = (o) =>
        Math.abs(image[o] - image[clear]) +
          Math.abs(image[o + 1] - image[clear + 1]) +
          Math.abs(image[o + 2] - image[clear + 2]) >
        8;
    const edges = [];
    for (let y = 40; y < H - 40; y++) {
      let last = -1;
      for (let x = 0; x < W; x++) if (isWater((y * W + x) * 4)) last = x;
      if (last > 0 && last < W - 1) edges.push([y, last]);
    }
    return { edges, validation };
  });
  assert.equal(r.validation, undefined, r.validation);
  assert.ok(r.edges.length > 150, `waterline rows: ${r.edges.length}`);
  const { edges } = r,
    mean = (f) => edges.reduce((a, e) => a + f(e), 0) / edges.length,
    my = mean((e) => e[0]),
    mx = mean((e) => e[1]),
    gain = mean((e) => (e[0] - my) * (e[1] - mx)) / mean((e) => (e[0] - my) ** 2),
    off = Math.sqrt(mean((e) => (e[1] - mx - gain * (e[0] - my)) ** 2));
  // The line x = z runs at 45 degrees on the screen.
  assert.ok(Math.abs(Math.abs(gain) - 1) < 0.05, `the waterline runs at ${gain.toFixed(3)} px a row, not 1`);
  assert.ok(off < 0.7, `the waterline is straight, not a staircase of cells: ${off.toFixed(2)} px off its line`);
  // The pond: 128 x 128 cells of 4 m; a bowl round (100, 0) with its bed 2 m up inside 20 m, rising 1 in 10 to 6 m,
  // filled to 3 m (the waterline at 30 m from its centre); the sea west of x = -100.
  const p = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js'),
      { Water } = await import('/packages/water/dist/index.js'),
      { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:200px';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 200, 0.01], target: [0, 0, 0], near: 1, far: 5000 },
      }),
      device = engine.gpu;
    device.pushErrorScope('validation');
    const N = 128,
      CELL = 4,
      bed = (x, z) => (x < -100 ? -5 : Math.min(6, 2 + Math.max(0, Math.hypot(x - 100, z) - 20) * 0.1)),
      ground = new Float32Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) ground[j * N + i] = bed(-256 + (i + 0.5) * CELL, -256 + (j + 0.5) * CELL);
    const texture = device.createTexture({
      size: [N, N],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, ground, { bytesPerRow: N * 4 }, [N, N]);
    let source = '';
    const create = device.createShaderModule.bind(device);
    device.createShaderModule = (descriptor) => {
      if (descriptor.code.includes('@vertex fn vertex') && descriptor.code.includes('fn coastal('))
        source = descriptor.code;
      return create(descriptor);
    };
    const water = Water.attach(engine, {
      size: [512, 512],
      segments: 128,
      height: 0,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 20 }],
      lights: [],
      terrain: { heightmap: () => texture, origin: [-256, -256], size: [512, 512] },
      fill: (x, z) => (Math.hypot(x - 100, z) < 40 ? 3 : undefined),
    });
    await waitForPipelines(() => engine.render({ delta: 1 / 60 }));
    // fixed-wait: 60 frames of the pond settling.
    for (let i = 0; i < 60; i++) {
      engine.render({ delta: 1 / 60 });
      await device.queue.onSubmittedWorkDone();
    }
    device.createShaderModule = create;
    if (!source) return { error: 'no water vertex shader' };
    // Along the pond's east radius from 27 to 34.5 m out (the waterline at 30, then one 4 m mesh cell past it), every
    // 0.5 m, sampled as a vertex of that mesh would be (its sample width is the cell's diagonal).
    const rs = Array.from({ length: 16 }, (_, i) => 27 + i * 0.5),
      data = new Float32Array(rs.flatMap((r) => [100 + r, 0, 4 * Math.SQRT2, 0])),
      queries = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      results = device.createBuffer({ size: rs.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      read = device.createBuffer({ size: results.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(queries, 0, data);
    const module = device.createShaderModule({
      code:
        source +
        `
@group(0) @binding(8) var<storage,read> queries:array<vec4f>;
@group(0) @binding(9) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(16) fn probe(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&queries)){return;}let q=queries[id.x];let s=surface(q.xy,q.z);let c=coastal(q.xy);
 results[id.x]=vec4f(s.position.y,c.wet,c.water.x,0);
}`,
    });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'probe' } }),
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: water.uniform } },
          { binding: 3, resource: water.coastal.views[water.coastal.current] },
          { binding: 7, resource: { buffer: water.coastal.connected } },
          { binding: 8, resource: { buffer: queries } },
          { binding: 9, resource: { buffer: results } },
        ],
      }),
      encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(results, 0, read, 0, results.size);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Float32Array(read.getMappedRange()));
    read.unmap();
    const validation = (await device.popErrorScope())?.message;
    water.dispose();
    texture.destroy();
    engine.dispose();
    return { rs, values, validation };
  });
  assert.equal(p.error, undefined, p.error);
  assert.equal(p.validation, undefined, p.validation);
  const dry = p.rs.map((r, i) => [r, ...p.values.slice(i * 4, i * 4 + 3)]).filter(([, , wet]) => wet <= 1e-4);
  assert.ok(
    dry.length >= 3,
    `the probes past the pond's waterline have wet texels around them: ${JSON.stringify(dry)}`,
  );
  for (const [r, y] of dry)
    assert.ok(
      Math.abs(y - 3) < 0.05,
      `the surface ${r} m from the pond's centre, on dry texels, stands at ${y.toFixed(3)} m, not the pond's 3 m`,
    );
  console.log(`ok water shoreline mesh: ${dry.length} dry-texel vertices past the pond hold its 3 m level`);
  assert.deepEqual(errors, []);
  console.log(`ok water shoreline: ${edges.length} rows, ${off.toFixed(2)} px off a straight line`);
} finally {
  await closeAll({ browser });
}
