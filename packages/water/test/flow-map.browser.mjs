import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const wind = (await readFile(new URL('./data/46042-20230101.txt', import.meta.url), 'utf8'))
  .trim()
  .split('\n')[2]
  .trim()
  .split(/\s+/)
  .map(Number)[5];
try {
  const samples = await page.evaluate(async (wind) => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { WaterFlow } = await import('/packages/water/dist/flow.js');
    const { Ripples } = await import('/packages/water/dist/ripples.js');
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const { flowShader } = await import('/packages/water/src/flow-shader.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:192px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 8,
        camera: { position: [0, 10, 12], target: [0, 0, 0], near: 0.1, far: 100 },
      }),
      gpu = engine.gpu;
    gpu.pushErrorScope('validation');
    const texture = (data, width = 1, height = 1) => {
      const t = gpu.createTexture({
        size: [width, height],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      gpu.queue.writeTexture({ texture: t }, new Float32Array(data), { bytesPerRow: width * 16 }, [width, height]);
      return t;
    };
    const map = texture([0.5, 0.25, 0, 1, -0.25, 0.5, 0, 1, 0.25, -0.5, 0, 1, -0.5, -0.25, 0, 1], 2, 2);
    const n0 = texture([0.6, 0.4, 1, 1]),
      n1 = texture([0.25, 0.75, 1, 1]);
    const uniform = gpu.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const output = gpu.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const staging = gpu.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const code =
      flowShader(0) +
      `\nfn noise(p:vec2f)->vec3f{return vec3f(0,sin(p.x),cos(p.y));}\n@group(0) @binding(4) var<storage,read_write> result:array<vec4f>;\n@compute @workgroup_size(4) fn main(@builtin(global_invocation_id) id:vec3u){let p=array<vec2f,4>(vec2f(-1,-1),vec2f(1,-1),vec2f(0,0),vec2f(5,5))[id.x];result[id.x]=vec4f(flowVector(p),flowingSlope(p));}`;
    const pipeline = gpu.createComputePipeline({
      layout: 'auto',
      compute: { module: gpu.createShaderModule({ code }), entryPoint: 'main' },
    });
    const group = gpu.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: map.createView() },
        { binding: 2, resource: n0.createView() },
        { binding: 3, resource: n1.createView() },
        { binding: 4, resource: { buffer: output } },
      ],
    });
    const frames = [];
    for (const [time, normal, encoded] of [
      [0, 0],
      [0.5, 0],
      [3.9999, 0],
      [4.0001, 0],
      [1, 1],
      [2, 1, true],
    ]) {
      gpu.queue.writeBuffer(
        uniform,
        0,
        new Float32Array([-2, -2, 4, 4, time, 2, 4, 4, encoded ? 0 : 1, normal, 0.2, 0]),
      );
      const encoder = gpu.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, 64);
      gpu.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      frames.push({ time, normal, encoded, data: Array.from(new Float32Array(staging.getMappedRange().slice(0))) });
      staging.unmap();
    }
    const angle = (wind * Math.PI) / 180;
    const water = Water.attach(engine, {
      size: [32, 32],
      segments: 64,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
    });
    const ripples = Ripples.attach(engine, { surface: water, size: 32, resolution: 32 });
    ripples.disturb(0, 0, 2, 0.1);
    let activeMap = map;
    const flow = WaterFlow.attach(engine, {
      surface: water,
      map: () => activeMap,
      signed: true,
      origin: [-16, -16],
      size: [32, 32],
      direction: [-Math.sin(angle), -Math.cos(angle)],
      strength: 0.8,
    });
    flow.setTime(0);
    engine.render({ delta: 0 });
    const query = await WaveQuery.capture(water);
    window.flowTest = {
      engine,
      flow,
      water,
      map,
      n0,
      n1,
      uniform,
      output,
      staging,
      switchMap: (value) => {
        activeMap = value;
      },
    };
    return { frames, height: query.heightAt(0, 0), validation: (await gpu.popErrorScope())?.message };
  }, wind);
  let maxError = 0;
  const positions = [
      [-1, -1],
      [1, -1],
      [0, 0],
      [5, 5],
    ],
    vectors = [
      [1, 0.5],
      [-0.5, 1],
      [0, 0],
      [0, 0],
    ];
  for (const frame of samples.frames)
    for (let i = 0; i < 4; i++) {
      const [x, z] = positions[i],
        [vx, vz] = frame.encoded
          ? [
              [0, -1],
              [-3, 0],
              [-2, -2],
              [0, 0],
            ][i]
          : vectors[i],
        t = (((frame.time / 4) % 1) + 1) % 1,
        other = (t + 0.5) % 1,
        w = 1 - Math.abs(2 * t - 1),
        m = Math.min(1, Math.hypot(vx, vz)) * 0.2;
      const layer = (phase, second) =>
        frame.normal
          ? second
            ? [0.5, -0.5]
            : [-0.2, 0.2]
          : [
              Math.sin((x - vx * phase * 4) / 4 + (second ? 5.17 : 0)) / 4,
              Math.cos((z - vz * phase * 4) / 4 + (second ? 9.23 : 0)) / 4,
            ];
      const a = layer(t, false),
        b = layer(other, true),
        expected = [vx, vz, ...a.map((v, k) => (v * w + b[k] * (1 - w)) * m)];
      for (let k = 0; k < 4; k++) maxError = Math.max(maxError, Math.abs(frame.data[i * 4 + k] - expected[k]));
    }
  assert.ok(maxError < 2e-6, `flow reference error ${maxError}`);
  assert.equal(samples.validation, undefined);
  assert.ok(samples.height > 0, 'flow composes with ripple geometry and query');
  const a = await page.locator('canvas').screenshot();
  await page.evaluate(() => {
    window.flowTest.flow.setTime(0);
    window.flowTest.engine.render({ delta: 0 });
  });
  const same = await page.locator('canvas').screenshot();
  assert.ok(a.equals(same), 'fixed time draws identically');
  await page.evaluate(() => {
    window.flowTest.flow.setTime(1);
    window.flowTest.engine.render({ delta: 0 });
  });
  const changed = await page
    .locator('canvas')
    .screenshot({ path: `test-results/water-flow-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}.png` });
  assert.ok(!a.equals(changed), 'flow changes visible water shading');
  await page.evaluate(async () => {
    const t = window.flowTest;
    const painted = t.engine.gpu.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    t.engine.gpu.queue.writeTexture(
      { texture: painted },
      new Uint8Array([255, 128, 0, 255]),
      { bytesPerRow: 4 },
      [1, 1],
      [2, 1, true],
    );
    t.switchMap(painted);
    t.engine.render({ delta: 0 });
    t.flow.onDeviceRestored(t.engine);
    t.engine.render({ delta: 0 });
    t.flow.dispose();
    t.flow.dispose();
    const { WaterFlow } = await import('/packages/water/dist/flow.js');
    const encoded = WaterFlow.attach(t.engine, {
      surface: t.water,
      map: () => painted,
      normalMaps: [() => t.n0, () => t.n1],
    });
    encoded.setTime(0.5);
    t.engine.render({ delta: 0 });
    encoded.dispose();
    t.engine.render({ delta: 0 });
    for (const k of ['map', 'n0', 'n1', 'uniform', 'output', 'staging']) t[k].destroy();
    t.engine.dispose();
    painted.destroy();
  });
  assert.deepEqual(errors, []);
  const report = {
    hardware,
    maxError,
    visibleChange: true,
    deterministic: true,
    rippleComposition: true,
    windBearing: wind,
  };
  console.log(JSON.stringify(report));
  await writeFile(
    `test-results/water-flow-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}.json`,
    JSON.stringify(report, null, 2),
  );
} finally {
  await browser.close();
}
