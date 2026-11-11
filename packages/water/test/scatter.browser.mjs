import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

// Wave subsurface scattering on the GPU: the WGSL term against an independent JavaScript evaluation of the same
// translucency formula, then rendered frames: backlit crests gain the tint, a light behind the camera adds almost
// nothing, and disposing restores the plain frame exactly.
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  mode = hardware?.compat ? 'compat' : 'webgpu',
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const shot = (name) =>
  page.locator('canvas').screenshot(name ? { path: `test-results/water-scatter-${name}-${mode}.png` } : {});
// Cases: world y, crest, normal, view, then the expected colour from the formula below.
const cases = [
  [0.3, 0, [0, 1, 0], [0, 0.2, 1]],
  [0.1, 0.6, [0.3, 0.9, 0.3], [0.1, 0.3, 0.95]],
  [-0.2, 0, [0, 1, 0], [0, 0.2, 1]],
  [0.5, 0, [0, 1, 0], [0, 0.2, -1]],
  [0.25, 0.1, [-0.4, 0.8, 0.2], [0.5, 0.1, 0.8]],
].map(([y, crest, n, v]) => {
  const norm = (a) => a.map((x) => x / Math.hypot(...a));
  return [y, crest, norm(n), norm(v)];
});
const settings = { color: [0.1, 0.6, 0.4], strength: 1.5, power: 3, distortion: 0.4 };
const light = { direction: [0, 0.2, -1], intensity: 2, radiance: [1, 0.9, 0.8] };
const amplitudes = [0.3, 0.2];
try {
  const gpuValues = await page.evaluate(
    async ({ cases, settings, light, amplitudes }) => {
      const { scatterShader } = await import('/packages/water/src/scatter-shader.ts');
      const { waterFrame } = await import('/packages/water/src/coastal.ts');
      const adapter = await navigator.gpu.requestAdapter();
      const gpu = await adapter.requestDevice();
      gpu.pushErrorScope('validation');
      const frame = new Float32Array(132);
      frame[20 + 1] = 0; // still level
      frame[20 + 3] = amplitudes.length;
      amplitudes.forEach((a, j) => (frame[32 + j * 8 + 2] = a));
      const d = light.direction.map((x) => x / Math.hypot(...light.direction));
      frame.set([...d, light.intensity, ...light.radiance, 0], 112);
      const scatter = new Float32Array([
        ...settings.color,
        settings.strength,
        settings.power,
        settings.distortion,
        0,
        0,
      ]);
      const input = new Float32Array(cases.flatMap(([y, crest, n, v]) => [0, y, 0, crest, ...n, 0, ...v, 0]));
      const buffer = (data, usage) => {
        const b = gpu.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
        gpu.queue.writeBuffer(b, 0, data);
        return b;
      };
      const frameBuffer = buffer(frame, GPUBufferUsage.UNIFORM),
        scatterBuffer = buffer(scatter, GPUBufferUsage.UNIFORM),
        inputBuffer = buffer(input, GPUBufferUsage.STORAGE),
        output = gpu.createBuffer({ size: cases.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
        staging = gpu.createBuffer({
          size: cases.length * 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
      const code =
        waterFrame +
        scatterShader(1, 'vec2f(frame.settings.y,1.0)') +
        `
fn waterShadow(p:vec3f)->f32 {return 0.5;}
@group(0) @binding(2) var<storage,read> cases:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
 let a=cases[id.x*3u];let n=cases[id.x*3u+1u].xyz;let v=cases[id.x*3u+2u].xyz;
 result[id.x]=vec4f(waterScatter(a.xyz,a.xz,a.w,n,v),0);
}`;
      const pipeline = gpu.createComputePipeline({
        layout: 'auto',
        compute: { module: gpu.createShaderModule({ code }), entryPoint: 'main' },
      });
      const encoder = gpu.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        gpu.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [frameBuffer, scatterBuffer, inputBuffer, output].map((b, binding) => ({
            binding,
            resource: { buffer: b },
          })),
        }),
      );
      pass.dispatchWorkgroups(cases.length);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, staging.size);
      gpu.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const values = Array.from(new Float32Array(staging.getMappedRange().slice(0)));
      const validation = (await gpu.popErrorScope())?.message;
      gpu.destroy();
      return { values, validation };
    },
    { cases, settings, light, amplitudes },
  );
  assert.equal(gpuValues.validation, undefined);
  // Independent evaluation: thickness max(crest, clamp(y / sum of amplitudes)), bent half vector L + N d,
  // pow(saturate(V . -H), power), times radiance, intensity, colour, strength and the 0.5 shadow stub.
  const total = amplitudes.reduce((a, b) => a + b);
  const l = light.direction.map((x) => x / Math.hypot(...light.direction));
  let worst = 0,
    lit = 0;
  cases.forEach(([y, crest, n, v], i) => {
    const thickness = Math.max(crest, Math.min(1, Math.max(0, y / total)));
    const bent = l.map((x, k) => x + n[k] * settings.distortion),
      h = bent.map((x) => x / Math.hypot(...bent));
    const back = Math.max(0, Math.min(1, -(v[0] * h[0] + v[1] * h[1] + v[2] * h[2]))) ** settings.power;
    for (let k = 0; k < 3; k++) {
      const expected =
        settings.color[k] * settings.strength * thickness * light.radiance[k] * light.intensity * back * 0.5;
      worst = Math.max(worst, Math.abs(gpuValues.values[i * 4 + k] - expected) / Math.max(1, expected));
      lit = Math.max(lit, expected);
    }
  });
  assert.ok(lit > 0.1, 'the cases include a strongly backlit crest');
  assert.ok(worst < 1e-5, `scatter reference error ${worst}`);

  // Rendered: a low light straight ahead of the camera, then behind it.
  await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:160px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 2.5, 12], target: [0, 0, -8], near: 0.1, far: 200 },
    });
    engine.gpu.pushErrorScope('validation');
    const lights = [{ direction: [0, 0.12, -1, 3], radiance: [1, 0.95, 0.85] }];
    const water = Water.attach(engine, {
      size: [80, 80],
      segments: 160,
      lights,
      waves: [
        { direction: [0, 1], amplitude: 0.5, wavelength: 7, steepness: 0.6 },
        { direction: [0.4, 1], amplitude: 0.2, wavelength: 3.5 },
      ],
    });
    engine.render({ delta: 0 });
    window.scatterTest = { engine, water, lights };
  });
  const plain = await shot();
  const lit2 = await page.evaluate(async () => {
    const t = window.scatterTest;
    const { WaterScatter } = await import('/packages/water/dist/scatter.js');
    t.scatter = WaterScatter.attach(t.engine, { surface: t.water });
    t.engine.render({ delta: 0 });
    return t.water['shaderCode'];
  });
  assert.ok(
    lit2.includes('let body=waterScatter(i.world,i.xz,i.crest,n,v)+bottom*transmission+'),
    'scatter joins the body colour',
  );
  assert.ok(
    lit2.includes('let b:vec2f=vec2f(frame.settings.y,1.0);'),
    'without bodies crests measure from the still level',
  );
  const backlit = await shot('backlit');
  await page.evaluate(() => {
    const t = window.scatterTest;
    t.scatter.set({ strength: 0 });
    t.engine.render({ delta: 0 });
  });
  const off = await shot();
  await page.evaluate(() => {
    const t = window.scatterTest;
    t.scatter.set({ strength: 1 });
    t.lights[0].direction = [0, 0.12, 1, 3];
    t.engine.render({ delta: 0 });
  });
  const frontScatter = await shot();
  const lifecycle = await page.evaluate(async () => {
    const t = window.scatterTest;
    t.scatter.onDeviceRestored(t.engine);
    t.engine.render({ delta: 0 });
    t.scatter.dispose();
    t.engine.render({ delta: 0 });
    return { validation: (await t.engine.gpu.popErrorScope())?.message };
  });
  const front = await shot();
  await page.evaluate(() => {
    const t = window.scatterTest;
    t.lights[0].direction = [0, 0.12, -1, 3];
    t.engine.render({ delta: 0 });
  });
  const restored = await shot();
  await page.evaluate(() => window.scatterTest.engine.dispose());
  assert.equal(lifecycle.validation, undefined);
  assert.ok(restored.equals(plain), 'disposing restores the plain frame exactly');
  const [p, b, o, fs, f] = await Promise.all([plain, backlit, off, frontScatter, front].map((x) => decodePNG(x)));
  // Mean green-minus-red gain over the water (lower 60% of the frame) and the largest single change.
  const gain = (a, z) => {
    let sum = 0,
      most = 0,
      count = 0;
    for (let y = Math.floor(a.height * 0.4); y < a.height; y++)
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        sum += z.data[i + 1] - z.data[i] - (a.data[i + 1] - a.data[i]);
        for (let k = 0; k < 3; k++) most = Math.max(most, Math.abs(z.data[i + k] - a.data[i + k]));
        count++;
      }
    return { mean: sum / count, most };
  };
  const back = gain(p, b),
    zero = gain(p, o),
    frontGain = gain(f, fs);
  assert.ok(back.mean > 1, `backlit crests gain the blue-green glow (mean ${back.mean})`);
  assert.ok(zero.most <= 1, `strength 0 matches the plain frame (largest change ${zero.most})`);
  assert.ok(frontGain.mean < back.mean / 4, `a light behind the camera adds little (${frontGain.mean})`);
  assert.deepEqual(errors, []);
  const report = { hardware, referenceError: worst, backlitGain: back.mean, frontGain: frontGain.mean };
  console.log(JSON.stringify(report));
  await writeFile(`test-results/water-scatter-${mode}.json`, JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
