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
  const result = await browser.page.evaluate(async (single) => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { FFTOcean } = await import('/packages/water/dist/fft.js');
    const { Underwater } = await import('/packages/water/dist/underwater.js');
    const { PostStack } = await import('/packages/post/dist/stack.js');
    const { invertMatrixStable } = await import('/packages/math/dist/mat4.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:192px;height:128px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      exactSize: single ? [192, 128] : undefined,
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
    // Exact dielectric underside: a constant sky gives (1-F)*sky within Snell's
    // window and zero beyond it in an empty, non-scattering medium. Compare
    // every fully covered pixel against independently reconstructed world rays.
    water.setWaveHeight(0);
    engine.camera.position = [0, -3, 0];
    engine.camera.target = [0, 1, -5];
    options.absorption = [0, 0, 0];
    options.scattering = [0, 0, 0];
    options.waterline = 0;
    options.skyHorizon = options.skyZenith = [0.8, 0.4, 0.2];
    const [, underside] = await frame();
    const inverse = new Float32Array(16);
    invertMatrixStable(engine.camera.matrix, inverse, new Float64Array(52));
    const unproject = (x, y, z) => {
      const v = [(x / underside.width) * 2 - 1, 1 - (y / underside.height) * 2, z, 1];
      const p = [0, 1, 2, 3].map((r) => v.reduce((sum, value, c) => sum + inverse[c * 4 + r] * value, 0));
      return p.slice(0, 3).map((value) => value / p[3]);
    };
    let windowPixels = 0,
      tirPixels = 0,
      undersideError = 0;
    for (let y = 1; y < underside.height - 1; y++)
      for (let x = 1; x < underside.width - 1; x++) {
        const near = unproject(x + 0.5, y + 0.5, 1),
          far = unproject(x + 0.5, y + 0.5, 0.000001);
        const v = far.map((value, k) => value - near[k]),
          length = Math.hypot(...v),
          ray = v.map((value) => value / length);
        if (ray[1] <= 0) continue;
        const t = -near[1] / ray[1];
        const p = near.map((value, k) => value + ray[k] * t);
        // Keep a full raster footprint away from the finite patch boundary.
        if (t < 0 || Math.abs(p[0]) > 35 || Math.abs(p[2]) > 35) continue;
        const c = ray[1],
          sin2 = 1.333 ** 2 * (1 - c * c);
        let fresnel = 1;
        if (sin2 < 1) {
          const ct = Math.sqrt(1 - sin2);
          fresnel = 0.5 * ((1.333 * c - ct) / (1.333 * c + ct)) ** 2 + 0.5 * ((c - 1.333 * ct) / (c + 1.333 * ct)) ** 2;
          windowPixels++;
        } else tirPixels++;
        const actual = at(underside, x, y);
        for (let k = 0; k < 3; k++)
          undersideError = Math.max(undersideError, Math.abs(actual[k] - options.skyHorizon[k] * (1 - fresnel)));
      }
    // Resize and rebuild resources on restoration; the optical boundary is unchanged.
    underwater.onDeviceRestored(engine);
    const restoredWorst = worst([underside, (await frame())[1]]);
    options.refractiveIndex = 1;
    const [, matchedIndex] = await frame();
    let matchedIndexError = 0;
    for (let y = 0; y < matchedIndex.height / 2; y++)
      for (let x = 0; x < matchedIndex.width; x++)
        for (let k = 0; k < 3; k++)
          matchedIndexError = Math.max(matchedIndexError, Math.abs(at(matchedIndex, x, y)[k] - options.skyHorizon[k]));
    options.refractiveIndex = 1.333;
    // Borrowed environment is read live and must replace the fallback gradient.
    const environment = d.createTexture({ size: [1, 1], format: 'rgba16float', usage: 6 });
    d.queue.writeTexture(
      { texture: environment },
      new Uint16Array([0x3400, 0x3800, 0x3c00, 0x3c00]),
      { bytesPerRow: 8 },
      [1, 1],
    );
    options.environment = () => environment;
    const [, environmentFrame] = await frame();
    let environmentError = 0;
    for (let y = 1; y < underside.height - 1; y++)
      for (let x = 1; x < underside.width - 1; x++) {
        // Baseline already checked against Fresnel: reuse its transmission fraction.
        const baseline = at(underside, x, y),
          actual = at(environmentFrame, x, y);
        for (let k = 0; k < 3; k++)
          environmentError = Math.max(
            environmentError,
            Math.abs(actual[k] - (baseline[k] / options.skyHorizon[k]) * [0.25, 0.5, 1][k]),
          );
      }
    options.environment = undefined;
    environment.destroy();
    // 6. An FFT ocean drives the same stage.
    stack.dispose();
    underwater.dispose();
    water.dispose();
    marker.dispose();
    engine.camera.position = [0, -8, 0];
    engine.camera.target = [0, 0, -8];
    const ocean = FFTOcean.attach(engine, { resolution: 64, cascades: [{ length: 64 }] });
    const fft = new Underwater({
      surface: ocean,
      absorption: [0, 0, 0],
      scattering: [0, 0, 0],
      waterline: 0,
      skyHorizon: [0.8, 0.4, 0.2],
      skyZenith: [0.8, 0.4, 0.2],
    });
    stack = PostStack.attach(engine, [recorder('in2'), fft, recorder('out2')]);
    const fftFrame = await frame();
    let fftFinite = true;
    for (const v of fftFrame[1].data) if (!Number.isFinite(v)) fftFinite = false;
    const fftChanged = worst(fftFrame) > 1e-3;
    // The exact submitted spectral normals define an independent per-pixel
    // dielectric oracle. This catches first-frame depth self-hits and FFT bands.
    const maskBuffer = d.createBuffer({ size: fftFrame[1].width * fftFrame[1].height * 16, usage: 132 });
    const encoder = d.createCommandEncoder(),
      maskPass = encoder.beginComputePass();
    maskPass.setPipeline(recordPipeline);
    maskPass.setBindGroup(
      0,
      d.createBindGroup({
        layout: recordPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: fft.targets[0].createView() },
          { binding: 1, resource: { buffer: maskBuffer } },
        ],
      }),
    );
    maskPass.dispatchWorkgroups(Math.ceil(fftFrame[1].width / 8), Math.ceil(fftFrame[1].height / 8));
    maskPass.end();
    d.queue.submit([encoder.finish()]);
    const maskData = (await read({ buffer: maskBuffer, size: [fftFrame[1].width, fftFrame[1].height] })).data;
    invertMatrixStable(engine.camera.matrix, inverse, new Float64Array(52));
    let fftOpticalPixels = 0,
      fftOpticalError = 0;
    for (let y = 0; y < fftFrame[1].height; y++)
      for (let x = 0; x < fftFrame[1].width; x++) {
        const i = (y * fftFrame[1].width + x) * 4,
          n = Array.from(maskData.subarray(i, i + 3));
        if (maskData[i + 3] >= 0 || Math.hypot(...n) < 0.5) continue;
        const near = unproject(x + 0.5, y + 0.5, 1),
          far = unproject(x + 0.5, y + 0.5, 0.000001),
          v = far.map((p, k) => p - near[k]),
          length = Math.hypot(...v);
        const cosine = Math.max(0, Math.min(1, v.reduce((s, p, k) => s + p * n[k], 0) / length / Math.hypot(...n)));
        const sin2 = 1.333 ** 2 * (1 - cosine * cosine);
        let fresnel = 1;
        if (sin2 < 1) {
          const ct = Math.sqrt(1 - sin2);
          fresnel =
            0.5 * ((1.333 * cosine - ct) / (1.333 * cosine + ct)) ** 2 +
            0.5 * ((cosine - 1.333 * ct) / (cosine + 1.333 * ct)) ** 2;
        }
        const actual = at(fftFrame[1], x, y);
        for (let k = 0; k < 3; k++)
          fftOpticalError = Math.max(fftOpticalError, Math.abs(actual[k] - [0.8, 0.4, 0.2][k] * (1 - fresnel)));
        fftOpticalPixels++;
      }
    maskBuffer.destroy();
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
      windowPixels,
      tirPixels,
      undersideError,
      restoredWorst,
      fftOpticalPixels,
      fftOpticalError,
      matchedIndexError,
      environmentError,
      single,
      validation: validation?.message,
    };
  }, process.argv.includes('--single'));
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
  assert.ok(result.windowPixels > 1000, `Snell window coverage ${result.windowPixels}`);
  assert.ok(result.tirPixels > 1000, `total internal reflection coverage ${result.tirPixels}`);
  assert.ok(result.undersideError < 0.002, `dielectric underside ${result.undersideError}`);
  assert.equal(result.restoredWorst, 0);
  assert.ok(result.fftOpticalPixels > 1000, `FFT underside coverage ${result.fftOpticalPixels}`);
  assert.ok(result.fftOpticalError < 0.002, `FFT dielectric underside ${result.fftOpticalError}`);
  assert.ok(result.matchedIndexError < 0.001, `matched IOR ${result.matchedIndexError}`);
  assert.ok(result.environmentError < 0.002, `borrowed environment ${result.environmentError}`);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-underwater-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}${result.single ? '-single' : ''}.json`,
    JSON.stringify({ ...result, hardware: browser.hardware }, null, 2),
  );
} finally {
  await browser.close();
}
