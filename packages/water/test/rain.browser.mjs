import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

// Rain rings on the GPU: the WGSL ring slope against an independent JavaScript evaluation using the same PCG hash,
// then rendered frames: rain 0 matches the plain frame, rain 1 changes it, WaterFlow and WaterRain compose in either
// attach order, splashes move a Ripples field, and disposing restores the plain frame exactly.
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
// The frame scenes put the sun in the mirror direction of the view's centre (camera at 0, 3, 6 looking at the origin),
// so the water shows the sun's glint where the rings and splashes tilt the surface: their change is then measured on a
// lit surface, not on a dim sky reflection, and holds the floors set before the first run (rings 0.5, splashes 0.2).
const GLINT = [0, 0.45, -0.9, 3];
const shot = (name) =>
  page.locator('canvas').screenshot(name ? { path: `test-results/water-rain-${name}-${mode}.png` } : {});

// Settings chosen so time / lifetime and xz / cell are exact in f32: the drop slot is the same on both sides.
const settings = { time: 1.5, rain: 0.7, cell: 0.5, strength: 0.35, lifetime: 0.75 };
const points = [];
for (let z = 0; z < 24; z++) for (let x = 0; x < 24; x++) points.push([x * 0.0437 - 0.31, z * 0.0391 + 0.12, 0]);
points.push([0.2, 0.3, 1], [0.5, -0.4, 10]); // footprints that fade the rings out

// Water's PCG hash (Jarzynski and Olano, JCGT 9(3), 2020), as the surface shader defines it.
const pcg = (v) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const hash = (cx, cz, salt) => Math.fround((pcg((cx >>> 0) + pcg((cz >>> 0) + pcg(salt))) >>> 8) * 5.9604645e-8);
const f = Math.fround;
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const reference = ([x, z, footprint]) => {
  const { cell, rain, strength } = settings,
    width = f(cell * f(0.05)),
    fade = 1 - smoothstep(width, width * 4, footprint);
  if (rain <= 0 || fade <= 0) return [0, 0, 0];
  let sx = 0,
    sz = 0;
  for (let layer = 0; layer < 3; layer++) {
    const px = f(f(f(x) / cell) + f(layer * f(0.37))),
      pz = f(f(f(z) / cell) + f(layer * f(0.71))),
      cx = Math.floor(px),
      cz = Math.floor(pz);
    const clock = f(f(settings.time / settings.lifetime) + hash(cx, cz, layer)),
      slot = Math.floor(clock),
      age = clock - slot;
    const k = pcg((Math.imul(slot | 0, 3) + layer) >>> 0);
    if (hash(cx, cz, k) >= rain) continue;
    const ox = (px - cx - (0.25 + 0.5 * hash(cx, cz, (k + 1) >>> 0))) * cell,
      oz = (pz - cz - (0.25 + 0.5 * hash(cx, cz, (k + 2) >>> 0))) * cell,
      d = Math.hypot(ox, oz);
    if (d <= 0) continue;
    const g = (d - age * 0.25 * cell) / width,
      s = ((-2 * g * Math.exp(-g * g)) / 0.85776388) * (1 - age) * (1 - age);
    sx += (ox / d) * s;
    sz += (oz / d) * s;
  }
  return [-sx * strength * fade, 0, -sz * strength * fade];
};

try {
  const gpu = await page.evaluate(
    async ({ points, settings }) => {
      const { rainShader } = await import('/packages/water/src/rain-shader.ts');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      device.pushErrorScope('validation');
      const buffer = (data, usage) => {
        const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(b, 0, data);
        return b;
      };
      const frame = buffer(
          new Float32Array([
            settings.time,
            settings.rain,
            settings.cell,
            settings.strength,
            settings.lifetime,
            0,
            0,
            0,
          ]),
          GPUBufferUsage.UNIFORM,
        ),
        input = buffer(new Float32Array(points.flatMap((p) => [...p, 0])), GPUBufferUsage.STORAGE),
        output = device.createBuffer({
          size: points.length * 16,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        }),
        staging = device.createBuffer({
          size: points.length * 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
      const code = `
fn ripplePcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
${rainShader(0)}
@group(0) @binding(1) var<storage,read> cases:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
 let c=cases[id.x];result[id.x]=vec4f(rainRipple(c.xy,c.z),0);
}`;
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      });
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [frame, input, output].map((b, binding) => ({ binding, resource: { buffer: b } })),
        }),
      );
      pass.dispatchWorkgroups(points.length);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, staging.size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const values = Array.from(new Float32Array(staging.getMappedRange().slice(0)));
      const validation = (await device.popErrorScope())?.message;
      device.destroy();
      return { values, validation };
    },
    { points, settings },
  );
  assert.equal(gpu.validation, undefined);
  let worst = 0,
    rings = 0;
  points.forEach((p, i) => {
    const expected = reference(p);
    if (Math.hypot(...expected) > 0.01) rings++;
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(gpu.values[i * 4 + k] - expected[k]));
  });
  assert.ok(rings > 20, `the sample points cross many rings (${rings})`);
  assert.ok(worst < 2e-4, `rain reference error ${worst}`);
  assert.deepEqual(gpu.values.slice(-8), [0, 0, 0, 0, 0, 0, 0, 0], 'wide footprints fade the rings out');

  await page.evaluate(async (glint) => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:160px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 3, 6], target: [0, 0, 0], near: 0.1, far: 100 },
    });
    engine.gpu.pushErrorScope('validation');
    const water = Water.attach(engine, {
      size: [32, 32],
      segments: 64,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
    });
    engine.lighting.direction.set(glint);
    engine.render({ delta: 0 });
    window.rainTest = { engine, water };
  }, GLINT);
  const plain = await shot();
  const orders = await page.evaluate(async () => {
    const t = window.rainTest;
    const { WaterRain } = await import('/packages/water/dist/rain.js');
    const { WaterFlow } = await import('/packages/water/dist/flow.js');
    const both = (code) => [
      code.includes('ripple=flowingNormal(i.world.xz,footprint)*(1.0-foam);'),
      code.includes('+rainRipple(i.world.xz,footprint)*(1.0-foam)'),
    ];
    const result = {};
    let flow = WaterFlow.attach(t.engine, { surface: t.water });
    let rain = WaterRain.attach(t.engine, { surface: t.water });
    t.engine.render({ delta: 0 });
    result.flowFirst = both(t.water['shaderCode']);
    rain.dispose();
    flow.dispose();
    rain = WaterRain.attach(t.engine, { surface: t.water });
    flow = WaterFlow.attach(t.engine, { surface: t.water });
    t.engine.render({ delta: 0 });
    result.rainFirst = both(t.water['shaderCode']);
    rain.dispose();
    flow.dispose();
    t.weather = { rain: 0 };
    t.rain = WaterRain.attach(t.engine, { surface: t.water, weather: t.weather, cell: 2, strength: 0.6 });
    t.rain.setTime(1.3);
    t.engine.render({ delta: 0 });
    return result;
  });
  assert.deepEqual(orders.flowFirst, [true, true], 'flow then rain keeps both normals');
  assert.deepEqual(orders.rainFirst, [true, true], 'rain then flow keeps both normals');
  const dry = await shot();
  await page.evaluate(() => {
    const t = window.rainTest;
    t.weather.rain = 1;
    t.engine.render({ delta: 0 });
  });
  const wet = await shot('rings');
  await page.evaluate(() => {
    const t = window.rainTest;
    t.rain.dispose();
    t.engine.render({ delta: 0 });
  });
  const restored = await shot();
  const lifecycle = await page.evaluate(async () => {
    const t = window.rainTest;
    const { WaterRain } = await import('/packages/water/dist/rain.js');
    const rain = WaterRain.attach(t.engine, { surface: t.water });
    rain.onDeviceRestored(t.engine);
    t.engine.render({ delta: 0 });
    rain.dispose();
    t.engine.render({ delta: 0 });
    const validation = (await t.engine.gpu.popErrorScope())?.message;
    t.engine.dispose();
    return { validation };
  });
  // Splashes alone (ring strength 0) move a Ripples field: two identical scenes, one in rain and one dry, differ
  // only through the splashes the wet one sends into the field.
  const splashScene = async (wet) => {
    const calls = await page.evaluate(async ([wet, glint]) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { Water } = await import('/packages/water/dist/index.js');
      const { WaterRain } = await import('/packages/water/dist/rain.js');
      const { Ripples } = await import('/packages/water/dist/ripples.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:256px;height:160px';
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 8,
        camera: { position: [0, 3, 6], target: [0, 0, 0], near: 0.1, far: 100 },
      });
      engine.gpu.pushErrorScope('validation');
      const water = Water.attach(engine, {
        size: [32, 32],
        segments: 64,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
      });
      engine.lighting.direction.set(glint);
      const field = Ripples.attach(engine, { surface: water, size: 16, resolution: 64, followCamera: false });
      const places = [];
      const disturb = field.disturb.bind(field);
      field.disturb = (x, z, radius, depth) => {
        places.push([x, z, radius, depth]);
        return disturb(x, z, radius, depth);
      };
      const rain = WaterRain.attach(engine, {
        surface: water,
        rain: wet ? 1 : 0,
        strength: 0,
        splashes: { field, rate: 300, area: 8, radius: 0.5, depth: 0.1 },
      });
      for (let i = 0; i < 8; i++) engine.render({ delta: 1 / 30 });
      window.rainTest = { engine, rain, field };
      return places;
    }, [wet, GLINT]);
    const image = await shot(wet ? 'splashes' : undefined);
    const validation = await page.evaluate(async () => {
      const t = window.rainTest;
      t.rain.dispose();
      t.field.dispose();
      const message = (await t.engine.gpu.popErrorScope())?.message;
      t.engine.dispose();
      return message;
    });
    assert.equal(validation, undefined);
    return { calls, image };
  };
  const dryScene = await splashScene(false),
    wetScene = await splashScene(true);
  assert.equal(dryScene.calls.length, 0, 'no rain, no splashes');
  // 300 a second over 8 frames at 1/30 s (the first frame has no elapsed time yet): 70 owed, at most 32 a frame.
  assert.ok(wetScene.calls.length >= 60 && wetScene.calls.length <= 80, `splash count ${wetScene.calls.length}`);
  for (const [x, z, radius, depth] of wetScene.calls) {
    assert.ok(Math.abs(x) <= 4 && Math.abs(z - 6) <= 4, `splash at ${x}, ${z} inside the area around the camera`);
    assert.deepEqual([radius, depth], [0.5, -0.1]);
  }
  assert.equal(lifecycle.validation, undefined);
  assert.ok(restored.equals(plain), 'disposing restores the plain frame exactly');
  const [p, d, w, c, s] = await Promise.all([plain, dry, wet, dryScene.image, wetScene.image].map((x) => decodePNG(x)));
  const change = (a, b) => {
    let sum = 0,
      most = 0;
    for (let i = 0; i < a.data.length; i += 4)
      for (let k = 0; k < 3; k++) {
        const e = Math.abs(a.data[i + k] - b.data[i + k]);
        sum += e;
        most = Math.max(most, e);
      }
    return { mean: sum / (a.data.length * 0.75), most };
  };
  const zero = change(p, d),
    ringChange = change(p, w),
    splashes = change(c, s);
  assert.ok(zero.most <= 1, `rain 0 matches the plain frame (largest change ${zero.most})`);
  assert.ok(ringChange.mean > 0.5, `rain 1 rings change the water (mean ${ringChange.mean})`);
  assert.ok(splashes.mean > 0.2, `splashes move the ripple field (mean ${splashes.mean})`);
  assert.deepEqual(errors, []);
  const report = { hardware, referenceError: worst, rings, ringsMean: ringChange.mean, splashMean: splashes.mean };
  console.log(JSON.stringify(report));
  await writeFile(`test-results/water-rain-${mode}.json`, JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
