// Sources brighter than half floats hold (a sun at 1e6): the rgba16float cube, specular mips and SH stay finite and keep
// the sun's energy. The stored texels are divided by `radianceScale` (peak / 60000) and lighting multiplies it back.
// 1. CubeFaces with a 1e6 sun: SH radiance and irradianceAt against an f64 projection of the same texels.
// 2. Equirect on the rgba32float (float32-filterable) and rgba16float paths: the pipeline is linear in radiance, so
//    the 1e6 sun environment must equal the uniform one plus (1e6 - 1) / 1000 times the change a 1001 sun makes
//    (that one fits half floats unscaled). Every cube and specular texel is finite.
// 3. Consumers of the stored texels: background (equirect and cube), EnvironmentBlend, baked KTX2 save and load.
import { Camera } from '@margoengine/core';
import { Environment, EnvironmentBackground, halfToFloat } from '../dist/index.js';
import { EnvironmentBlend } from '../dist/blend.js';
import { loadPrefilteredEnvironment, savePrefilteredEnvironment } from '../dist/prefiltered.js';
import { assert, faceDirection, readTexture, hardware } from './gpu-read.js';

const align = (n) => Math.ceil(n / 256) * 256;
// The shader's SH basis (shaders.ts sphericalHarmonics) in f64, and its irradiance band factors / PI.
const basis = ([x, y, z]) => [
  0.282094792,
  0.488602512 * y,
  0.488602512 * z,
  0.488602512 * x,
  1.092548431 * x * y,
  1.092548431 * y * z,
  0.315391565 * (3 * z * z - 1),
  1.092548431 * x * z,
  0.546274215 * (x * x - y * y),
];
const band = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25];
const area = (x, y) => Math.atan((x * y) / Math.sqrt(x * x + y * y + 1));

/** f64 radiance SH (27 floats) of six RGBA faces with exact texel solid angles. */
function projectFaces(size, faces) {
  const out = new Float64Array(27),
    inv = 1 / size;
  for (let face = 0; face < 6; face++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const u0 = x * 2 * inv - 1,
          v0 = y * 2 * inv - 1,
          u1 = u0 + 2 * inv,
          v1 = v0 + 2 * inv,
          omega = area(u0, v0) - area(u0, v1) - area(u1, v0) + area(u1, v1),
          b = basis(faceDirection(face, u0 + inv, v0 + inv)),
          i = (y * size + x) * 4;
        for (let k = 0; k < 9; k++)
          for (let c = 0; c < 3; c++) out[k * 3 + c] += faces[face][i + c] * omega * b[k];
      }
  return out;
}
const irradiance = (radiance, n) => {
  const b = basis(n);
  return [0, 1, 2].map((c) => b.reduce((sum, v, k) => sum + band[k] * radiance[k * 3 + c] * v, 0));
};
/** Largest coefficient error relative to the reference L0 of its channel. */
const shError = (got, want) => {
  let worst = 0;
  for (let k = 0; k < 9; k++)
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[k * 3 + c] - want[k * 3 + c]) / Math.abs(want[c]));
  return worst;
};
const scaleOf = (environment) => environment.radianceScale ?? 1;
const lightingSH = (environment) => Array.from(environment.sh.radiance, (v) => v * scaleOf(environment));

async function allFinite(device, texture) {
  for (let mip = 0; mip < texture.mipLevelCount; mip++) {
    const level = await readTexture(device, texture, mip);
    for (let i = 0; i < level.data.length; i++)
      if (!Number.isFinite(level.data[i])) return `mip ${mip} texel ${i >> 2} is ${level.data[i]}`;
  }
  return '';
}

window.runTests = async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  assert(adapter, 'WebGPU adapter unavailable');
  const float32 = adapter.features.has('float32-filterable');
  const device = await adapter.requestDevice({ requiredFeatures: float32 ? ['float32-filterable'] : [] }),
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const report = { checks: [], hardware: hardware(adapter), float32Filterable: float32 },
    small = { samples: 64, brdfSize: 16, brdfSamples: 64 },
    sun = 1e6,
    sky = [1, 0.5, 0.25];

  // 1. CubeFaces: one 2 x 2 sun of 1e6 on +X over a coloured sky, against the f64 projection of the same texels.
  {
    const size = 16,
      faces = Array.from({ length: 6 }, () => new Float32Array(size * size * 4));
    for (const face of faces) for (let i = 0; i < face.length; i += 4) face.set([...sky, 1], i);
    for (const [x, y] of [
      [7, 5],
      [8, 5],
      [7, 6],
      [8, 6],
    ])
      faces[0].set([sun, sun / 2, sun / 4, 1], (y * size + x) * 4);
    const environment = await Environment.create(device, { size, faces }, small);
    const reference = projectFaces(size, faces),
      error = shError(lightingSH(environment), reference);
    let irradianceError = 0;
    for (const n of [
      [1, -0.2, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0.3, -0.5, 0.81],
    ]) {
      const length = Math.hypot(...n),
        d = n.map((v) => v / length),
        got = environment.irradianceAt(d),
        want = irradiance(reference, d);
      for (let c = 0; c < 3; c++)
        irradianceError = Math.max(irradianceError, Math.abs(got[c] - want[c]) / Math.abs(want[c]));
    }
    const finite = (await allFinite(device, environment.cubeTexture)) || (await allFinite(device, environment.specularTexture));
    assert(!finite, `CubeFaces sun: non-finite texel, ${finite}`);
    // f16 storage rounds each stored texel by at most half a unit in the last place (2^-11 relative); the sums run in
    // f32 over 1,536 texels. Measured 3.6e-7 (SH) and 4.0e-7 (irradiance) on the RTX A6000, native WebGPU
    // and the WebGL2 compatibility layer; main (the sun clamped to 65504) was 1.59.
    assert(error < 1e-3, `CubeFaces sun: SH error ${error} against the f64 projection (scale ${scaleOf(environment)})`);
    assert(irradianceError < 1e-3, `CubeFaces sun: irradianceAt error ${irradianceError}`);
    report.cubeFaces = { radianceScale: scaleOf(environment), shError: error, irradianceError };
    environment.dispose();
    report.checks.push('CubeFaces with a 1e6 sun: SH and irradianceAt equal the f64 projection; every texel finite');
  }

  // 2. Equirect, both upload paths: the 1e6 sun equals the uniform sky plus (1e6 - 1) / 1000 times a 1001 sun's change.
  const image = (value) => {
    const width = 64,
      height = 32,
      data = new Float32Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([...sky, 1], i);
    for (const [x, y] of [
      [40, 10],
      [41, 10],
      [40, 11],
      [41, 11],
    ])
      data.set([value, value / 2, value / 4, 1], (y * width + x) * 4);
    return { width, height, data };
  };
  const options = (path) => ({ size: 16, specularSize: 16, specularMips: 3, ...small, float32: path === 'float32' });
  report.equirect = {};
  let bright;
  for (const path of float32 ? ['float32', 'half'] : ['half']) {
    const create = (value) => Environment.create(device, image(value), options(path));
    const flat = await create(1),
      dim = await create(1001),
      lit = await create(sun);
    const k = (sun - 1) / 1000,
      f = lightingSH(flat),
      d = lightingSH(dim),
      predicted = f.map((v, i) => v + k * (d[i] - v)),
      error = shError(lightingSH(lit), predicted);
    const finite =
      (await allFinite(device, lit.cubeTexture)) ||
      (await allFinite(device, lit.specularTexture)) ||
      (lit.sh.radiance.every(Number.isFinite) ? '' : 'SH');
    assert(!finite, `${path} equirect sun: non-finite ${finite}`);
    // Each of the three environments rounds its stored texels to f16 (2^-11 relative); the 1001 sun's rounding is
    // multiplied by k with its sky subtracted. Measured on the A6000 at most 1.9e-4 (rgba32float) and 1.3e-4
    // (rgba16float), both backends; main was 1.26 on the rgba32float path (the cube store overflowed).
    assert(error < 2e-3, `${path} equirect sun: SH ${error} off the linear prediction (scale ${scaleOf(lit)})`);
    report.equirect[path] = { radianceScale: scaleOf(lit), shError: error, keptOfLinear: lightingSH(lit)[0] / predicted[0] };
    flat.dispose();
    dim.dispose();
    if (bright) lit.dispose();
    else bright = lit;
  }
  report.checks.push(`equirect with a 1e6 sun (${Object.keys(report.equirect).join(', ')}): SH linear in radiance; texels finite`);

  // 3a. Background: the sky behind the camera reads the same radiance from the scaled textures, equirect and cube.
  {
    const size = 48,
      camera = new Camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 90, near: 0.1, far: 50 });
    camera.update(1, true);
    let worst = 0;
    for (const source of ['equirect', 'cube']) {
      const background = new EnvironmentBackground(bright, { source });
      const color = device.createTexture({
          size: [size, size],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        }),
        depth = device.createTexture({ size: [size, size], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      const encoder = device.createCommandEncoder(),
        colorView = color.createView(),
        depthView = depth.createView();
      encoder
        .beginRenderPass({
          colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          depthStencilAttachment: { view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
        })
        .end();
      background.record({
        backend: 'webgpu',
        device,
        encoder,
        color: colorView,
        depth: depthView,
        format: 'rgba16float',
        camera,
        width: size,
        height: size,
        descriptor: { depthStencil: { format: 'depth32float' } },
      });
      const row = align(size * 8),
        buffer = device.createBuffer({ size: row * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyTextureToBuffer({ texture: color }, { buffer, bytesPerRow: row }, [size, size]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const bits = new Uint16Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      color.destroy();
      depth.destroy();
      background.dispose();
      // The centre pixel looks along -Z, the sky (the sun is at u 0.64, v 0.33, well outside the view's centre).
      const centre = [0, 1, 2].map((c) => halfToFloat(bits[(24 * row) / 2 + 24 * 4 + c]));
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(centre[c] - sky[c]) / sky[c]);
      assert(worst < 4e-3, `${source} background of the scaled environment: ${centre} vs ${sky}`);
    }
    report.background = { worst };
    report.checks.push('background of a scaled environment: equirect and cube read the unscaled sky');
  }

  // 3b. EnvironmentBlend: half way between the sun and a plain sky lights as the mean of the two.
  {
    const plain = await Environment.create(device, image(1), options('half'));
    const blend = await EnvironmentBlend.create(device, bright, plain, { t: 0.5 });
    let worst = 0;
    for (const n of [
      [0.5, 0.7, -0.5],
      [-1, 0, 0],
      [0, -1, 0],
    ]) {
      const got = blend.environment.irradianceAt(n),
        a = bright.irradianceAt(n),
        b = plain.irradianceAt(n);
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[c] - (a[c] + b[c]) / 2) / ((a[c] + b[c]) / 2));
    }
    const finite = await allFinite(device, blend.environment.cubeTexture);
    assert(!finite, `blend output: non-finite ${finite}`);
    // The output holds f32 SH blended on the CPU, so only f32 rounding remains.
    assert(worst < 1e-5, `blend of a scaled environment: irradiance ${worst} off the mean`);
    report.blend = { radianceScale: scaleOf(blend.environment), irradianceError: worst };
    blend.dispose();
    plain.dispose();
    report.checks.push('EnvironmentBlend of a scaled environment lights as the weighted mean');
  }

  // 3c. Baked KTX2: saving and loading keeps the scale, so the loaded environment lights the same.
  {
    const loaded = await loadPrefilteredEnvironment(device, await savePrefilteredEnvironment(bright));
    assert(scaleOf(loaded) === scaleOf(bright), `baked scale ${scaleOf(loaded)} vs ${scaleOf(bright)}`);
    for (const n of [
      [0.5, 0.7, -0.5],
      [0, -1, 0],
    ]) {
      const got = loaded.irradianceAt(n),
        want = bright.irradianceAt(n);
      for (let c = 0; c < 3; c++) assert(got[c] === want[c], `baked irradiance ${got} vs ${want}`);
    }
    loaded.dispose();
    report.checks.push('baked KTX2 of a scaled environment loads with the same scale and lighting');
  }

  bright.dispose();
  await device.queue.onSubmittedWorkDone();
  const validation = await device.popErrorScope();
  assert(!validation && !errors.length, `validation: ${validation?.message ?? errors.join('; ')}`);
  return report;
};
