import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

// Underwater checks against independent arithmetic: Beer-Lambert extinction of a known path, exact pass-through above
// the surface and when disabled, the waterline row from the near-plane geometry, and finite sunlit in-scatter.
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await browser.page.evaluate(async () => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { FFTOcean } = await import('/packages/water/dist/fft.js');
    const { Underwater } = await import('/packages/water/dist/underwater.js');
    const { PostStack } = await import('/packages/post/dist/stack.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:192px;height:128px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [0, -3, 0], target: [0, -3, -10], near: 0.1, far: 100 },
    });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    engine.lighting.direction.set([0.3, 1, 0.2, 2]);
    const marker = engine
      .createMesh()
      .setGeometry(box(3, 3, 3))
      .setMaterial(new PbrMaterial({ color: '#d0d0d0', roughness: 1 }))
      .setPosition([0, -3, -10]);
    const water = Water.attach(engine, {
      size: [80, 80],
      segments: 64,
      waves: [{ direction: [1, 0], amplitude: 0.1, wavelength: 12 }],
    });
    water.setWaveHeight(0);
    const options = { surface: water, absorption: [0.38, 0.1, 0.045], scattering: [0, 0, 0], shafts: 0, waterline: 0 };
    const underwater = new Underwater(options);
    // Two transparent HDR recorders around the stage: what it reads and what it writes, compared in linear light.
    const recordCode = `@group(0) @binding(0) var t:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> out:array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(t);if(any(id.xy>=size)){return;}out[id.y*size.x+id.x]=textureLoad(t,vec2i(id.xy),0);
}`;
    let recordPipeline;
    const recorders = [];
    const recorder = (name) => {
      const r = { name, buffer: undefined, size: [0, 0] };
      recorders.push(r);
      return {
        name,
        setup() {},
        joinStack() {
          return {
            kind: 'hdr',
            render(c, input) {
              recordPipeline ??= d.createComputePipeline({
                layout: 'auto',
                compute: { module: d.createShaderModule({ code: recordCode }), entryPoint: 'main' },
              });
              if (!r.buffer || r.size[0] !== c.width || r.size[1] !== c.height) {
                r.buffer?.destroy();
                r.size = [c.width, c.height];
                r.buffer = d.createBuffer({
                  size: c.width * c.height * 16,
                  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
                });
              }
              const pass = c.encoder.beginComputePass();
              pass.setPipeline(recordPipeline);
              pass.setBindGroup(
                0,
                d.createBindGroup({
                  layout: recordPipeline.getBindGroupLayout(0),
                  entries: [
                    { binding: 0, resource: input },
                    { binding: 1, resource: { buffer: r.buffer } },
                  ],
                }),
              );
              pass.dispatchWorkgroups(Math.ceil(c.width / 8), Math.ceil(c.height / 8));
              pass.end();
              return input;
            },
          };
        },
      };
    };
    const read = async (r) => {
      const staging = d.createBuffer({ size: r.buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const e = d.createCommandEncoder();
      e.copyBufferToBuffer(r.buffer, 0, staging, 0, r.buffer.size);
      d.queue.submit([e.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.destroy();
      return { data, width: r.size[0], height: r.size[1] };
    };
    let stack = PostStack.attach(engine, [recorder('in'), underwater, recorder('out')]);
    // Returns [stage input, stage output] of one frame.
    const frame = async () => {
      engine.render({ delta: 0 });
      const n = recorders.length;
      return [await read(recorders[n - 2]), await read(recorders[n - 1])];
    };
    const at = (f, x, y) => Array.from(f.data.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 3));
    const worst = ([a, b], rows = [0, a.height]) => {
      let w = 0;
      for (let y = rows[0]; y < rows[1]; y++)
        for (let x = 0; x < a.width; x++)
          for (let k = 0; k < 4; k++) {
            const i = (y * a.width + x) * 4 + k;
            w = Math.max(w, Math.abs(a.data[i] - b.data[i]));
          }
      return w;
    };
    // 1. Beer-Lambert: the camera ray to the centre of the box face travels 8.5 m from the eye, 8.4 m past the near plane.
    const fogged = await frame();
    const cx = Math.floor(fogged[0].width / 2),
      cy = Math.floor(fogged[0].height / 2);
    const before = at(fogged[0], cx, cy),
      after = at(fogged[1], cx, cy);
    const path = 8.4;
    const extinction = options.absorption.map((a, i) => {
      const expected = before[i] * Math.exp(-a * path);
      return Math.abs(after[i] - expected) / Math.max(expected, 1e-4);
    });
    // 2. Disabled while submerged passes through exactly.
    options.enabled = false;
    const disabledWorst = worst(await frame());
    options.enabled = true;
    // 3. Above the surface nothing changes.
    engine.camera.position = [0, 3, 0];
    engine.camera.target = [0, 3, -10];
    marker.setPosition([0, 3, -10]);
    const aboveWorst = worst(await frame());
    // 4. Waterline: eye 2 cm below a flat surface, looking level. Rows whose near-plane point is above y=0 are unchanged.
    engine.camera.position = [0, -0.02, 0];
    engine.camera.target = [0, -0.02, -10];
    marker.setPosition([0, 0, -10]);
    const line = await frame();
    const m = engine.camera.matrix;
    // Row of the near-plane point at height 0: project (0, 0, -near) through the camera's own matrix.
    const clip = [1, 3].map((r) => m[4 + r] * 0 + m[8 + r] * -0.1 + m[12 + r]);
    const lineRow = (0.5 - (clip[0] / clip[1]) * 0.5) * line[0].height;
    const unchangedAbove = worst(line, [0, Math.floor(lineRow) - 1]);
    let changedBelow = 0;
    for (let y = Math.ceil(lineRow) + 1; y < line[0].height; y++)
      if (Math.abs(at(line[0], cx, y)[0] - at(line[1], cx, y)[0]) > 1e-4) changedBelow++;
    const belowRows = line[0].height - Math.ceil(lineRow) - 1;
    // 5. Sunlit in-scatter over a wavy surface: finite, positive, spatially varying, and larger with shafts on.
    water.setWaveHeight(1);
    engine.camera.position = [0, -4, 0];
    engine.camera.target = [0, -6, -10];
    marker.setPosition([0, -40, 0]);
    options.scattering = [0.02, 0.035, 0.04];
    options.shafts = 1;
    options.waterline = 2;
    const [, lit] = await frame();
    options.shafts = 0;
    const [, ambientOnly] = await frame();
    let finite = true,
      litMin = Infinity,
      litMax = 0,
      shaftGain = 0;
    for (let i = 0; i < lit.data.length; i += 4) {
      if (![0, 1, 2].every((k) => Number.isFinite(lit.data[i + k]) && lit.data[i + k] >= 0)) finite = false;
      litMin = Math.min(litMin, lit.data[i + 2]);
      litMax = Math.max(litMax, lit.data[i + 2]);
      shaftGain = Math.max(shaftGain, lit.data[i + 2] - ambientOnly.data[i + 2]);
    }
    // 6. An FFT ocean drives the same stage.
    stack.dispose();
    underwater.dispose();
    water.dispose();
    const ocean = FFTOcean.attach(engine, { resolution: 64, cascades: [{ length: 64 }] });
    const fft = new Underwater({ surface: ocean });
    stack = PostStack.attach(engine, [recorder('in2'), fft, recorder('out2')]);
    const fftFrame = await frame();
    let fftFinite = true;
    for (const v of fftFrame[1].data) if (!Number.isFinite(v)) fftFinite = false;
    const fftChanged = worst(fftFrame) > 1e-3;
    let detachedCode;
    try {
      new Underwater({ surface: {} });
    } catch (error) {
      detachedCode = error.code;
    }
    const validation = await d.popErrorScope();
    return {
      before,
      after,
      extinction,
      aboveWorst,
      lineRow,
      unchangedAbove,
      changedBelow,
      belowRows,
      finite,
      litMin,
      litMax,
      shaftGain,
      disabledWorst,
      fftFinite,
      fftChanged,
      detachedCode,
      validation: validation?.message,
    };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, undefined);
  assert.ok(
    result.before.every((v) => v > 0.01),
    `lit marker ${result.before}`,
  );
  // rgba16float stores about 11 significant bits: relative error 1/1024 per value, two values compared.
  for (const e of result.extinction) assert.ok(e < 0.004, `Beer-Lambert extinction ${result.extinction}`);
  assert.equal(result.aboveWorst, 0);
  assert.ok(result.lineRow > 4 && result.lineRow < 60, `waterline row ${result.lineRow}`);
  assert.equal(result.unchangedAbove, 0);
  assert.equal(result.changedBelow, result.belowRows);
  assert.equal(result.finite, true);
  assert.ok(result.litMin > 0, `in-scatter ${result.litMin}`);
  assert.ok(result.litMax > result.litMin * 1.05, `in-scatter varies ${result.litMin}..${result.litMax}`);
  assert.ok(result.shaftGain > 0, 'sunlit shafts add light');
  assert.equal(result.disabledWorst, 0);
  assert.equal(result.fftFinite, true);
  assert.equal(result.fftChanged, true);
  assert.equal(result.detachedCode, 'state');
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-underwater-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}.json`,
    JSON.stringify({ ...result, hardware: browser.hardware }, null, 2),
  );
} finally {
  await browser.close();
}
