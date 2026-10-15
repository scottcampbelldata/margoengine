import {Engine, Camera, PbrMaterial, box} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {Environment, EnvironmentBackground, loadEnvironmentImage, projectEquirectSH, shBasis, halfToFloat, IBL_WGSL, iblLayoutEntries, iblBindGroupEntries, ColorBackground, EnvironmentLighting, Fog, decodeUltraHDR} from '../dist/index.js';
import {parseGLTF} from '@margoengine/gltf-pro';
import {animatedTriangle} from '../../../tests/support/gltf-pro-fixture.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const align = n => Math.ceil(n / 256) * 256;

// Same conventions as the shaders: equirect center faces -Z, row 0 is +Y; cube faces in WebGPU layer order.
function equirectDirection(u, v) {
  const phi = 2 * Math.PI * (u - 0.5), theta = Math.PI * v;
  return [Math.sin(theta) * Math.sin(phi), Math.cos(theta), -Math.sin(theta) * Math.cos(phi)];
}
function faceDirection(face, u, v) {
  const d = [[1, -v, -u], [-1, -v, u], [u, 1, v], [u, -1, -v], [u, -v, 1], [-u, -v, -1]][face], l = Math.hypot(...d);
  return d.map(x => x / l);
}
function equirect(width, height, radiance) {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...radiance(equirectDirection((x + 0.5) / width, (y + 0.5) / height)), 1], (y * width + x) * 4);
  return {width, height, data};
}
// Smooth, direction-coded HDR environment: red follows +X, green +Y, blue -Z.
const coded = d => [1 + d[0], 1 + d[1], 1 - d[2]].map(v => v * 1.5);

async function readTexture(device, texture, mip = 0) {
  const width = Math.max(1, texture.width >> mip), height = Math.max(1, texture.height >> mip), layers = texture.depthOrArrayLayers, row = align(width * 8);
  const buffer = device.createBuffer({size: row * height * layers, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({texture, mipLevel: mip}, {buffer, bytesPerRow: row, rowsPerImage: height}, [width, height, layers]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const bits = new Uint16Array(buffer.getMappedRange().slice(0)), out = new Float32Array(width * height * layers * 4);
  buffer.unmap(); buffer.destroy();
  for (let l = 0; l < layers; l++) for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++)
    out[((l * height + y) * width) * 4 + x] = halfToFloat(bits[(l * height + y) * row / 2 + x]);
  return {width, height, layers, data: out, at: (layer, x, y) => [...out.subarray(((layer * height + y) * width + x) * 4, ((layer * height + y) * width + x) * 4 + 4)]};
}
// environment.brdfLut: a storage buffer of size x size pack2x16float(scale, bias).
async function readLut(device, lut) {
  const buffer = device.createBuffer({size: lut.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ}), encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(lut, 0, buffer, 0, lut.size); device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const bits = new Uint16Array(buffer.getMappedRange().slice(0)), width = Math.round(Math.sqrt(bits.length / 2));
  buffer.unmap(); buffer.destroy();
  return {width, at: (_, x, y) => [halfToFloat(bits[(y * width + x) * 2]), halfToFloat(bits[(y * width + x) * 2 + 1])]};
}

// Brute-force reference for the split-sum BRDF: uniform grid over the hemisphere of L with core's GGX D and
// separable Smith G, independent of the GPU's importance sampling.
function brdfReference(nv, roughness, steps = 700) {
  const alpha = roughness * roughness, a2 = alpha * alpha, v = [Math.sqrt(1 - nv * nv), 0, nv];
  const g1 = x => 2 * x / (x + Math.sqrt(a2 + (1 - a2) * x * x));
  let scale = 0, bias = 0;
  const dTheta = Math.PI / 2 / steps, dPhi = 2 * Math.PI / (steps * 2);
  for (let i = 0; i < steps; i++) {
    const theta = (i + 0.5) * dTheta, st = Math.sin(theta), nl = Math.cos(theta);
    for (let j = 0; j < steps * 2; j++) {
      const phi = (j + 0.5) * dPhi, l = [st * Math.cos(phi), st * Math.sin(phi), nl];
      let h = [l[0] + v[0], l[1] + v[1], l[2] + v[2]];
      const len = Math.hypot(...h); h = h.map(x => x / len);
      const nh = h[2], vh = Math.max(0, h[0] * v[0] + h[2] * v[2]);
      const q = nh * nh * (a2 - 1) + 1, d = a2 / (Math.PI * q * q);
      const f = d * g1(nv) * g1(nl) / (4 * nv * nl) * nl * st * dTheta * dPhi, fc = (1 - vh) ** 5;
      scale += (1 - fc) * f; bias += fc * f;
    }
  }
  return [scale, bias];
}
// Karis, "Physically Based Shading on Mobile" (2014) analytic fit of the UE4 environment BRDF.
function karisApproximation(nv, roughness) {
  const r = [roughness * -1 + 1, roughness * -0.0275 + 0.0425, roughness * -0.572 + 1.04, roughness * 0.022 - 0.04];
  const a004 = Math.min(r[0] * r[0], 2 ** (-9.28 * nv)) * r[0] + r[1];
  return [-1.04 * a004 + r[2], 1.04 * a004 + r[3]];
}

const tonemap = c => {const m = c / (1 + c); return 255 * (m < 0.0031308 ? m * 12.92 : 1.055 * m ** (1 / 2.4) - 0.055);};
function directionAt(camera, x, y, width, height) {
  const m = camera.matrix, inverse = new Float64Array(16);
  invert(m, inverse);
  const ndc = [(x + 0.5) / width * 2 - 1, 1 - (y + 0.5) / height * 2, 0.5, 1], w = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) w[r] += inverse[c * 4 + r] * ndc[c];
  const p = [w[0] / w[3] - camera.position[0], w[1] / w[3] - camera.position[1], w[2] / w[3] - camera.position[2]], l = Math.hypot(...p);
  return p.map(v => v / l);
}
function invert(m, out) {
  // Gauss-Jordan on a column-major matrix (test-only reference, independent of the package's invert).
  const a = [];
  for (let r = 0; r < 4; r++) a.push([m[r], m[4 + r], m[8 + r], m[12 + r], ...[0, 1, 2, 3].map(c => +(c === r))]);
  for (let c = 0; c < 4; c++) {
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c]; for (let k = 0; k < 8; k++) a[c][k] /= d;
    for (let r = 0; r < 4; r++) if (r !== c) {const f = a[r][c]; for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k];}
  }
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[r][4 + c];
}
const rotateY = (d, angle) => {const c = Math.cos(angle), s = Math.sin(angle); return [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]];};

window.runEnvironmentTests = async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  assert(adapter, 'WebGPU adapter unavailable');
  const device = await adapter.requestDevice(), errors = [], modules = [], report = {checks: []};
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const createShaderModule = device.createShaderModule.bind(device);
  device.createShaderModule = descriptor => {const module = createShaderModule(descriptor); modules.push(module); return module;};
  const small = {samples: 64, brdfSize: 16, brdfSamples: 64};

  // 1. Constant environment: every prefiltered mip is constant and SH is L0 only.
  {
    const c = [0.5, 1.25, 3];
    const environment = await Environment.create(device, equirect(64, 32, () => c), {size: 32, specularSize: 32, specularMips: 4, ...small});
    assert(environment.specularMips === 4 && environment.specularTexture.mipLevelCount === 4, 'specular mip count');
    let worst = 0;
    for (let mip = 0; mip < 4; mip++) {
      const level = await readTexture(device, environment.specularTexture, mip);
      for (let i = 0; i < level.data.length; i += 4) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(level.data[i + k] - c[k]) / c[k]);
    }
    assert(worst < 2e-3, `constant environment prefiltered error ${worst}`);
    const {radiance} = environment.sh, l0 = 2 * Math.sqrt(Math.PI);
    for (let k = 0; k < 3; k++) assert(Math.abs(radiance[k] - c[k] * l0) < 1e-3 * c[k] * l0, `L0 ${radiance[k]} vs ${c[k] * l0}`);
    for (let k = 3; k < 27; k++) assert(Math.abs(radiance[k]) < 2e-3, `constant environment has L1/L2 energy at ${k}: ${radiance[k]}`);
    for (const d of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0.2, 0.5, -0.84]]) environment.irradianceAt(d).forEach((v, k) => assert(Math.abs(v - c[k]) < 3e-3 * c[k], `irradiance ${v} vs ${c[k]}`));
    report.constant = {maxRelativeError: worst, sh0: [...radiance.slice(0, 3)]};
    environment.dispose();
    report.checks.push('constant environment: constant prefiltered values at every mip, SH equals the constant (L0 only)');
  }

  // 2. A single bright direction: GPU SH matches the CPU projection and the analytic delta projection.
  {
    const target = [0.48, 0.6, -0.64], radius = 4 * Math.PI / 180, value = 50;
    const image = equirect(256, 128, d => d[0] * target[0] + d[1] * target[1] + d[2] * target[2] > Math.cos(radius) ? [value, value * 0.5, value * 0.25] : [0, 0, 0]);
    const environment = await Environment.create(device, image, {...small, shSize: 64});
    const cpu = projectEquirectSH(image), gpu = environment.sh.radiance;
    let power = 0;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 256; x++) power += image.data[(y * 256 + x) * 4] * (2 * Math.PI / 256) * (Math.cos(Math.PI * y / 128) - Math.cos(Math.PI * (y + 1) / 128));
    const basis = shBasis(...target), scale = power * basis[0];
    let cpuError = 0, analyticError = 0;
    for (let k = 0; k < 9; k++) for (let channel = 0; channel < 3; channel++) {
      const weight = [1, 0.5, 0.25][channel], analytic = power * weight * basis[k];
      cpuError = Math.max(cpuError, Math.abs(gpu[k * 3 + channel] - cpu[k * 3 + channel]) / (scale * weight));
      analyticError = Math.max(analyticError, Math.abs(gpu[k * 3 + channel] - analytic) / (scale * weight));
    }
    assert(cpuError < 0.02 && analyticError < 0.03, `bright-direction SH error: CPU ${cpuError}, analytic ${analyticError}`);
    // The brightest SH irradiance direction points at the source.
    const toward = environment.irradianceAt(target)[0], away = environment.irradianceAt(target.map(v => -v))[0];
    assert(toward > 10 * Math.max(away, 1e-3), `irradiance not oriented toward the light: ${toward} vs ${away}`);
    // Mip-filtered importance sampling keeps a mid-roughness mip free of isolated fireflies.
    const level = await readTexture(device, environment.specularTexture, 2);
    let outliers = 0, peak = 0;
    for (let layer = 0; layer < 6; layer++) for (let y = 1; y < level.height - 1; y++) for (let x = 1; x < level.width - 1; x++) {
      const v = level.at(layer, x, y)[0]; peak = Math.max(peak, v);
      const neighbors = Math.max(level.at(layer, x - 1, y)[0], level.at(layer, x + 1, y)[0], level.at(layer, x, y - 1)[0], level.at(layer, x, y + 1)[0]);
      if (v > 4 * neighbors + 0.05) outliers++;
    }
    assert(outliers === 0 && peak > 0.1, `fireflies in prefiltered mip 2: ${outliers} outliers, peak ${peak}`);
    report.brightDirection = {cpuRelativeError: cpuError, analyticRelativeError: analyticError, prefilterPeak: peak};
    environment.dispose();
    report.checks.push('single bright direction: SH matches CPU and analytic projections; prefiltered mip has no fireflies');
  }

  // 3. Prefiltered mip 0 equals the source, and the cube follows the documented face convention.
  const codedImage = equirect(128, 64, coded);
  const codedEnvironment = await Environment.create(device, codedImage, {size: 32, specularSize: 32, ...small, brdfSize: 32, brdfSamples: 1024});
  {
    const source = await readTexture(device, codedEnvironment.cubeTexture, 0), prefiltered = await readTexture(device, codedEnvironment.specularTexture, 0);
    let mipError = 0, conventionError = 0;
    for (let i = 0; i < source.data.length; i++) mipError = Math.max(mipError, Math.abs(source.data[i] - prefiltered.data[i]));
    for (let face = 0; face < 6; face++) for (let y = 0; y < 32; y += 3) for (let x = 0; x < 32; x += 3) {
      const expected = coded(faceDirection(face, (x + 0.5) / 16 - 1, (y + 0.5) / 16 - 1)), got = source.at(face, x, y);
      for (let k = 0; k < 3; k++) conventionError = Math.max(conventionError, Math.abs(got[k] - expected[k]));
    }
    assert(mipError < 2e-3, `prefiltered mip 0 differs from source by ${mipError}`);
    // GPU SH against a CPU projection of the very same cube texels (exact texel solid angles).
    const area = (x, y) => Math.atan(x * y / Math.sqrt(x * x + y * y + 1)), cpu = new Float64Array(27);
    for (let face = 0; face < 6; face++) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const u0 = x / 16 - 1, v0 = y / 16 - 1, u1 = u0 + 1 / 16, v1 = v0 + 1 / 16, solidAngle = area(u0, v0) - area(u0, v1) - area(u1, v0) + area(u1, v1);
      const basis = shBasis(...faceDirection(face, u0 + 1 / 32, v0 + 1 / 32)), texel = source.at(face, x, y);
      for (let k = 0; k < 9; k++) for (let channel = 0; channel < 3; channel++) cpu[k * 3 + channel] += texel[channel] * solidAngle * basis[k];
    }
    let shError = 0;
    for (let i = 0; i < 27; i++) shError = Math.max(shError, Math.abs(codedEnvironment.sh.radiance[i] - cpu[i]));
    assert(shError < 1e-3 * cpu[0], `GPU SH differs from the CPU projection of the cube by ${shError}`);
    assert(conventionError < 0.03, `cube face convention error ${conventionError}`);
    // Smaller prefiltered size: mip 0 is the source mip of matching size.
    const half = await Environment.create(device, codedImage, {size: 32, specularSize: 16, ...small});
    const sourceMip = await readTexture(device, half.cubeTexture, 1), prefilteredMip = await readTexture(device, half.specularTexture, 0);
    let halfError = 0;
    for (let i = 0; i < sourceMip.data.length; i++) halfError = Math.max(halfError, Math.abs(sourceMip.data[i] - prefilteredMip.data[i]));
    assert(halfError < 2e-3, `prefiltered mip 0 differs from matching source mip by ${halfError}`);
    half.dispose();
    // Rough mips blur toward the mean: the coded field is linear, so the lobe average keeps the mean (1.5) and shrinks the slope.
    const roughest = await readTexture(device, codedEnvironment.specularTexture, codedEnvironment.specularMips - 1);
    // For the linear field 1.5 * (1 + d.x, 1 + d.y, 1 - d.z), a symmetric lobe returns 1.5 * (1 + k N.x, 1 + k N.y, 1 - k N.z) with one k < 1.
    let slopeError = 0, slope = 0;
    for (const [face, x, y] of [[0, 4, 4], [2, 1, 6], [5, 3, 0], [3, 7, 2]]) {
      const n = faceDirection(face, (x + 0.5) / roughest.width * 2 - 1, (y + 0.5) / roughest.height * 2 - 1), got = roughest.at(face, x, y);
      const axis = [0, 1, 2].reduce((best, k) => Math.abs(n[k]) > Math.abs(n[best]) ? k : best, 0);
      const k = (got[axis] / 1.5 - 1) / (axis === 2 ? -n[2] : n[axis]);
      slope = k;
      const predicted = [1 + k * n[0], 1 + k * n[1], 1 - k * n[2]].map(v => v * 1.5);
      for (let c = 0; c < 3; c++) slopeError = Math.max(slopeError, Math.abs(got[c] - predicted[c]));
      assert(k > 0.3 && k < 0.95, `roughest mip slope ${k} at face ${face}`);
    }
    assert(slopeError < 0.06, `roughest mip is not a symmetric lobe average: ${slopeError}`);
    // Six CubeFaces as the source give the same lighting as the equirect.
    const faces = Array.from({length: 6}, (_, face) => {
      const data = new Float32Array(32 * 32 * 4);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) data.set([...coded(faceDirection(face, (x + 0.5) / 16 - 1, (y + 0.5) / 16 - 1)), 1], (y * 32 + x) * 4);
      return data;
    });
    const fromFaces = await Environment.create(device, {size: 32, faces}, {...small});
    assert(!fromFaces.equirectView, 'cube source should not create an equirect');
    let facesError = 0;
    for (let i = 0; i < 27; i++) facesError = Math.max(facesError, Math.abs(fromFaces.sh.radiance[i] - codedEnvironment.sh.radiance[i]));
    assert(facesError < 0.01 * codedEnvironment.sh.radiance[0], `CubeFaces SH differs from the equirect SH by ${facesError}`);
    fromFaces.dispose();
    report.mip0 = {cubeFacesShDifference: facesError, maxDifference: mipError, conventionError, halfSizeDifference: halfError, shVsCubeProjection: shError, roughestSlope: slope, roughestLobeError: slopeError};
    report.checks.push('prefiltered mip 0 matches the source cube (full and half size); cube faces follow the WebGPU convention; GPU SH matches a CPU projection of the cube; CubeFaces input matches the equirect');
  }

  // 4. BRDF LUT against brute-force quadrature, the smooth-surface analytic limit and Karis's published fit.
  {
    const lut = await readLut(device, codedEnvironment.brdfLut), size = lut.width, points = [];
    let quadratureError = 0, karisError = 0, smoothError = 0;
    for (const [x, y] of [[4, 10], [16, 16], [28, 12], [8, 24], [24, 28], [31, 31], [16, 31], [2, 20]]) {
      const nv = (x + 0.5) / size, roughness = (y + 0.5) / size, got = lut.at(0, x, y).slice(0, 2);
      const expected = brdfReference(nv, roughness), karis = karisApproximation(nv, roughness);
      points.push({nv, roughness, got, expected});
      quadratureError = Math.max(quadratureError, Math.abs(got[0] - expected[0]), Math.abs(got[1] - expected[1]));
      // The mobile fit targets dielectrics, so compare the F0 = 0.04 response it was fitted for.
      karisError = Math.max(karisError, Math.abs(0.04 * got[0] + got[1] - 0.04 * karis[0] - karis[1]));
    }
    for (let x = 0; x < size; x += 4) {
      const nv = (x + 0.5) / size, got = lut.at(0, x, 0), fc = (1 - nv) ** 5;
      smoothError = Math.max(smoothError, Math.abs(got[0] - (1 - fc)), Math.abs(got[1] - fc));
    }
    assert(quadratureError < 0.012, `BRDF LUT vs quadrature ${quadratureError}: ${JSON.stringify(points)}`);
    assert(smoothError < 0.01, `BRDF LUT smooth limit error ${smoothError}`);
    assert(karisError < 0.04, `BRDF LUT vs Karis fit at F0 = 0.04: ${karisError}`);
    report.brdf = {quadratureError, smoothLimitError: smoothError, karisFitError: karisError};
    report.checks.push('BRDF LUT matches quadrature, the smooth analytic limit and the Karis mobile fit');
  }

  // 5. Background pass rendered directly: directions, rotation, exposure, blur, HDR and 8-bit outputs, depth.
  {
    const size = 48, camera = new Camera({position: [0, 0, 1], target: [0, 0, 0], fov: 90, near: 0.1, far: 50});
    camera.update(1, true);
    async function render(background, {format = 'rgba16float', depthClear = 0} = {}) {
      const color = device.createTexture({size: [size, size], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
      const depth = device.createTexture({size: [size, size], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT});
      const encoder = device.createCommandEncoder(), colorView = color.createView(), depthView = depth.createView();
      encoder.beginRenderPass({colorAttachments: [{view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0.25, 0, 0.25, 1]}], depthStencilAttachment: {view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: depthClear}}).end();
      background.record({backend: 'webgpu', device, encoder, color: colorView, depth: depthView, format, camera, width: size, height: size, descriptor: {depthStencil: {format: 'depth32float'}}});
      const bpp = format === 'rgba16float' ? 8 : 4, row = align(size * bpp), buffer = device.createBuffer({size: row * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      encoder.copyTextureToBuffer({texture: color}, {buffer, bytesPerRow: row}, [size, size]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap(); buffer.destroy(); color.destroy(); depth.destroy();
      return (x, y) => bpp === 8 ? [...new Uint16Array(bytes.buffer, y * row + x * 8, 4)].map(halfToFloat) : [...bytes.subarray(y * row + x * 4, y * row + x * 4 + 4)];
    }
    const samples = [[3, 3], [24, 24], [44, 7], [10, 40], [40, 40], [24, 2]];
    const check = async (options, expect, label, format = 'rgba16float', tolerance = 0.04) => {
      const background = new EnvironmentBackground(codedEnvironment, options), pixel = await render(background, {format});
      let worst = 0;
      for (const [x, y] of samples) {
        const d = rotateY(directionAt(camera, x, y, size, size), codedEnvironment.rotation + (options.rotation ?? 0)), expected = expect(d), got = pixel(x, y);
        for (let k = 0; k < 3; k++) worst = Math.max(worst, format === 'rgba16float' ? Math.abs(got[k] - expected[k]) / expected[k] : Math.abs(got[k] - tonemap(expected[k])));
      }
      assert(worst < tolerance, `${label}: error ${worst}`);
      background.dispose();
      return worst;
    };
    report.background = {
      equirect: await check({source: 'equirect'}, coded, 'equirect background'),
      cube: await check({source: 'cube'}, coded, 'cube background', 'rgba16float', 0.05),
      rotation: await check({rotation: Math.PI / 2}, coded, 'rotated background'),
      exposure: await check({exposure: 2}, d => coded(d).map(v => v * 2), 'exposure'),
      tonemapped: await check({}, coded, 'tone-mapped rgba8unorm', 'rgba8unorm', 2.5),
    };
    codedEnvironment.rotation = 0.7;
    report.background.environmentRotation = await check({}, coded, 'environment.rotation');
    codedEnvironment.rotation = 0;
    const blurred = new EnvironmentBackground(codedEnvironment, {blur: 1}), sharp = new EnvironmentBackground(codedEnvironment);
    const blurPixel = await render(blurred), sharpPixel = await render(sharp);
    const spread = pixel => {const values = samples.map(([x, y]) => pixel(x, y)[1]); return Math.max(...values) - Math.min(...values);};
    assert(spread(blurPixel) < 0.75 * spread(sharpPixel), `blur did not soften the background: ${spread(blurPixel)} vs ${spread(sharpPixel)}`);
    const covered = await render(sharp, {format: 'rgba8unorm', depthClear: 1});
    for (let y = 0; y < size; y += 5) for (let x = 0; x < size; x += 5) assert(covered(x, y).join() === '64,0,64,255', `background drew over geometry depth at ${x},${y}: ${covered(x, y)}`);
    blurred.dispose(); sharp.dispose();
    report.checks.push('background pass: expected colors per direction (equirect, cube, rotation, exposure, blur), linear HDR and core tone-mapped output, never over non-cleared depth');
  }
  codedEnvironment.dispose();

  // 6. IBL helper WGSL compiles against the documented bindings.
  {
    const module = device.createShaderModule({code: `${IBL_WGSL}
@group(0) @binding(0) var iblSpecular: texture_cube<f32>;
@group(0) @binding(1) var iblSampler: sampler;
@group(0) @binding(2) var<storage, read> iblBrdf: array<u32>;
@group(0) @binding(3) var<uniform> iblSh: array<vec4f, 9>;
@group(0) @binding(4) var<uniform> iblParams: vec4f;
@group(0) @binding(5) var<storage, read_write> out: array<vec4f, 3>;
@compute @workgroup_size(1) fn main() {
  out[0] = vec4f(iblShade(iblSpecular, iblSampler, iblSh, iblParams, vec3f(0.0, 1.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(1.0), 0.0, 1.0), 1.0);
  out[1] = vec4f(iblShade(iblSpecular, iblSampler, iblSh, iblParams, vec3f(0.0, 1.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(1.0), 1.0, 0.0), 1.0);
  out[2] = vec4f(iblIrradiance(iblSh, vec3f(0.0, 1.0, 0.0)), 1.0);
}`});
    const c = [0.5, 1.25, 3], environment = await Environment.create(device, equirect(64, 32, () => c), {size: 16, ...small, brdfSize: 32, brdfSamples: 512});
    const layout = device.createBindGroupLayout({entries: [...iblLayoutEntries(0, GPUShaderStage.COMPUTE), {binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'storage'}}]});
    const pipeline = device.createComputePipeline({layout: device.createPipelineLayout({bindGroupLayouts: [layout]}), compute: {module, entryPoint: 'main'}});
    const out = device.createBuffer({size: 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC}), read = device.createBuffer({size: 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, device.createBindGroup({layout, entries: [...iblBindGroupEntries(environment), {binding: 5, resource: {buffer: out}}]})); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(out, 0, read, 0, 48); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(read.getMappedRange().slice(0)); read.unmap(); read.destroy(); out.destroy();
    // A white furnace: a rough white dielectric and a smooth white metal both return close to the environment radiance.
    for (let k = 0; k < 3; k++) {
      assert(Math.abs(values[8 + k] - c[k]) < 0.01 * c[k], `iblIrradiance ${values[8 + k]} vs ${c[k]}`);
      assert(Math.abs(values[4 + k] - c[k]) < 0.03 * c[k], `smooth metal furnace ${values[4 + k]} vs ${c[k]}`);
      assert(values[k] > 0.85 * c[k] && values[k] < 1.02 * c[k], `rough dielectric furnace ${values[k]} vs ${c[k]}`);
    }
    report.furnace = {roughDielectric: [...values.slice(0, 3)], smoothMetal: [...values.slice(4, 7)]};
    environment.dispose();
    report.checks.push('IBL_WGSL compiles with iblLayoutEntries/iblBindGroupEntries and passes a white furnace test');
  }

  // 7. A real Radiance file through the whole pipeline.
  {
    const image = await loadEnvironmentImage('/tests/fixtures/spot1Lux.hdr');
    const environment = await Environment.create(device, image, {size: 64, specularSize: 32, ...small});
    assert(environment.sh.radiance.every(Number.isFinite) && environment.sh.radiance[0] > 0, 'real HDR SH');
    const cpu = projectEquirectSH(image);
    assert(Math.abs(environment.sh.radiance[0] - cpu[0]) < 0.03 * cpu[0], `real HDR L0 ${environment.sh.radiance[0]} vs CPU ${cpu[0]}`);
    report.realHdr = {width: image.width, height: image.height, gpuL0: environment.sh.radiance[0], cpuL0: cpu[0]};
    environment.dispose();
    report.checks.push('real spot1Lux.hdr processed; GPU L0 matches CPU projection');
  }

  const diagnostics = (await Promise.all(modules.map(module => module.getCompilationInfo()))).flatMap(info => info.messages).filter(message => message.type === 'error');
  const validation = await device.popErrorScope();
  assert(!diagnostics.length && !validation && !errors.length, `WGSL/GPU errors: ${JSON.stringify(diagnostics.map(d => d.message))} ${validation?.message ?? errors.join('; ')}`);
  report.shaderModulesChecked = modules.length;
  device.destroy();

  // 8. Engine integration: background behind a core mesh, plugin lifecycle, steady frames and device restore.
  {
    const canvas = document.querySelector('#scene');
    const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0, 4], target: [0, 0, 0], fov: 60}});
    const runtime = engineRuntime(engine), gpuErrors = [];
    const watch = gpu => {gpu.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message)); gpu.pushErrorScope('validation');};
    watch(runtime.gpu);
    const mesh = engine.createMesh().setGeometry(box(1.2, 1.2, 1.2)).setMaterial(new PbrMaterial({color: '#d0a040', roughness: 0.5}));
    mesh.setRotation([0.4, 0.6, 0]);
    const capture = () => {
      const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
      const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    engine.render(); const plain = capture();
    // MSAA edges mix uncovered clear samples; a white fragment exposes their coverage.
    let sceneSamples;
    const coveragePlugin = {name: 'test:environment-coverage', setup() {}, registerPasses(graph) {
      graph.add({name: 'test:environment-coverage', order: -1, execute(context) {
        sceneSamples = context.descriptor.multisample?.count ?? 1;
        context.shader = context.shader.replace(/let n=normalize\(i.normal\)[\s\S]*$/, 'return vec4f(1);\n}');
      }});
    }};
    engine.use(coveragePlugin); engine.render(); const coverage = capture();
    engine.removePlugin(coveragePlugin.name); engine.render(); const afterCoverage = capture();
    assert(plain.every((value, i) => value === afterCoverage[i]), 'coverage probe changed the plain frame');
    const environment = await Environment.create(engine, codedImage, {size: 32, ...small});
    const background = new EnvironmentBackground(environment);
    engine.use(environment).use(background);
    engine.render(); const withBackground = capture();
    const width = canvas.width, height = canvas.height;
    let meshPixels = 0, edgePixels = 0, backgroundPixels = 0, worst = 0, edgeWorst = 0;
    const background0 = plain.slice(0, 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, covered = Math.round((coverage[i] - background0[0]) / (255 - background0[0]) * sceneSamples);
      assert(covered >= 0 && covered <= sceneSamples, `invalid raster coverage at ${x},${y}`);
      for (let k = 0; k < 3; k++) assert(Math.abs(coverage[i + k] - (background0[k] + (255 - background0[k]) * covered / sceneSamples)) <= 1, `invalid coverage mask at ${x},${y}`);
      if (covered === sceneSamples) {
        meshPixels++;
        assert(plain[i] === withBackground[i] && plain[i + 1] === withBackground[i + 1] && plain[i + 2] === withBackground[i + 2], `background changed a mesh pixel at ${x},${y}`);
      } else if (covered > 0) {
        edgePixels++;
        const expected = coded(directionAt(engine.camera, x, y, width, height)).map(tonemap), uncovered = 1 - covered / sceneSamples;
        for (let k = 0; k < 3; k++) edgeWorst = Math.max(edgeWorst, Math.abs(withBackground[i + k] - (plain[i + k] + uncovered * (expected[k] - background0[k]))));
      } else if ((x + y) % 7 === 0) {
        backgroundPixels++;
        const expected = coded(directionAt(engine.camera, x, y, width, height)).map(tonemap);
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(withBackground[i + k] - expected[k]));
      }
    }
    assert(meshPixels > 200 && backgroundPixels > 200 && worst <= 3, `engine background: ${meshPixels} mesh px, ${backgroundPixels} sky px, worst ${worst}`);
    assert(edgeWorst <= 3 && (sceneSamples === 1 ? edgePixels === 0 : edgePixels > 0), `engine MSAA edges: ${edgePixels} pixels, worst ${edgeWorst}`);
    report.engine = {canvas: [width, height], sceneSamples, meshPixels, edgePixels, backgroundPixelsChecked: backgroundPixels, worstByteError: worst, edgeWorstByteError: edgeWorst};

    // Steady frames allocate nothing and reuse their pass descriptors.
    const methods = ['createBuffer', 'createTexture', 'createBindGroup', 'createSampler', 'createShaderModule', 'createRenderPipeline'];
    const originals = methods.map(name => runtime.gpu[name]);
    let allocations = 0;
    for (let i = 0; i < methods.length; i++) runtime.gpu[methods[i]] = function (...args) {allocations++; return originals[i].apply(this, args);};
    try {for (let i = 0; i < 5; i++) {background.exposure = 1 + i * 0.1; environment.rotation = i * 0.1; engine.render({delta: 1 / 60});}}
    finally {for (let i = 0; i < methods.length; i++) runtime.gpu[methods[i]] = originals[i];}
    assert(allocations === 0, `steady frames created ${allocations} GPU objects`);
    background.exposure = 1; environment.rotation = 0;
    await runtime.gpu.queue.onSubmittedWorkDone();
    const firstValidation = await runtime.gpu.popErrorScope();
    assert(!firstValidation && !gpuErrors.length, `engine validation: ${firstValidation?.message ?? gpuErrors.join('; ')}`);

    // Device restore: the environment rebuilds on the new device and the background draws again.
    const previous = runtime.gpu, version = environment.version;
    let notified = 0; environment.onChange(() => notified++);
    await engine.rebootDevice();
    assert(runtime.gpu !== previous, 'device was not replaced');
    watch(runtime.gpu);
    await environment.restore(engine);
    assert(environment.device === runtime.gpu && environment.version === version + 1 && notified === 1, 'environment was not restored on the new device');
    engine.render(); const restored = capture();
    let restoreWorst = 0;
    for (let i = 0; i < restored.length; i += 4) for (let k = 0; k < 3; k++) restoreWorst = Math.max(restoreWorst, Math.abs(restored[i + k] - withBackground[i + k]));
    assert(restoreWorst <= 2, `background after device restore differs by ${restoreWorst}`);
    await runtime.gpu.queue.onSubmittedWorkDone();
    const secondValidation = await runtime.gpu.popErrorScope();
    assert(!secondValidation && !gpuErrors.length, `engine validation after restore: ${secondValidation?.message ?? gpuErrors.join('; ')}`);
    engine.removePlugin(background.name);
    engine.render(); const removed = capture();
    let removedDiff = 0;
    for (let i = 0; i < removed.length; i += 4) removedDiff = Math.max(removedDiff, Math.abs(removed[i] - plain[i]));
    assert(removedDiff <= 1, 'removing the background plugin did not restore the plain frame');
    engine.dispose();
    assert(environment.disposed && environment.device === null, 'engine.dispose did not dispose the environment plugin');
    report.engine.restoreDifference = restoreWorst;
    report.checks.push('engine: background fills only cleared depth around a core mesh, steady frames allocate nothing, device restore rebuilds, plugin removal and disposal');
  }
  // 9. Scene lighting in a real engine: EnvironmentLighting, Fog and ColorBackground on a core mesh and a blended glTF-pro triangle.
  {
    const canvas = document.querySelector('#scene');
    const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0, 4], target: [0, 0, 0], fov: 60}});
    const runtime = engineRuntime(engine), gpuErrors = [];
    runtime.gpu.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message)); runtime.gpu.pushErrorScope('validation');
    const capture = () => {
      const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
      const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    const mesh = engine.createMesh().setGeometry(box(1.2, 1.2, 1.2)).setMaterial(new PbrMaterial({color: '#d0a040', roughness: 0.6}));
    mesh.setRotation([0.4, 0.6, 0]);
    const fixture = animatedTriangle();
    // Clearcoat selects glTF-pro's physical shader variant (13 material textures), so both variants compile with IBL and fog.
    fixture.doc.materials = [{alphaMode: 'BLEND', pbrMetallicRoughness: {baseColorFactor: [0.2, 0.6, 0.9, 0.7], metallicFactor: 0, roughnessFactor: 0.5}, extensions: {KHR_materials_clearcoat: {clearcoatFactor: 1}}}];
    fixture.doc.extensionsUsed = ['KHR_materials_clearcoat'];
    fixture.doc.nodes = [{mesh: 0, translation: [-0.9, -0.9, 1]}]; delete fixture.doc.skins; delete fixture.doc.animations;
    delete fixture.doc.meshes[0].primitives[0].attributes.JOINTS_0; delete fixture.doc.meshes[0].primitives[0].attributes.WEIGHTS_0;
    const model = parseGLTF(engine, fixture.doc, fixture.buffers);
    engine.render(); const plain = capture();
    const width = canvas.width, height = canvas.height, clear = plain.slice(0, 3);
    const covered = i => Math.abs(plain[i] - clear[0]) + Math.abs(plain[i + 1] - clear[1]) + Math.abs(plain[i + 2] - clear[2]) > 6;
    // ColorBackground: exact sRGB bytes where the scene left depth cleared, scene pixels untouched.
    const background = new ColorBackground({color: '#336699'});
    engine.use(background); engine.render(); const colored = capture();
    let bgPixels = 0, bgWorst = 0, sceneWorst = 0, scenePixels = 0;
    for (let i = 0; i < colored.length; i += 4) {
      const x = (i / 4) % width, y = Math.floor(i / 4 / width), corner = x < 3 && y < 3;
      if (corner) {bgPixels++; bgWorst = Math.max(bgWorst, Math.abs(colored[i] - 51), Math.abs(colored[i + 1] - 102), Math.abs(colored[i + 2] - 153));}
      // The opaque box sits in the middle; the blended triangle (bottom left) legitimately shows the new background through it.
      else if (covered(i) && Math.abs(x - width / 2) < width / 6 && Math.abs(y - height / 2) < height / 6 && covered(i - 4) && covered(i + 4) && covered(i - width * 4) && covered(i + width * 4)) {
        scenePixels++; for (let k = 0; k < 3; k++) sceneWorst = Math.max(sceneWorst, Math.abs(colored[i + k] - plain[i + k]));
      }
    }
    assert(bgWorst <= 1 && sceneWorst <= 1 && scenePixels > 200, `color background: corner error ${bgWorst}, scene error ${sceneWorst} over ${scenePixels} px`);
    // IBL alone (direct light and constant ambient off): a constant environment lights every mesh pixel and changes the frame.
    const saved = engine.lighting.radiance.slice(); engine.lighting.radiance.set([0, 0, 0, 0]);
    engine.render(); const dark = capture();
    const environment = await Environment.create(engine, equirect(64, 32, () => [0.6, 0.6, 0.6]), {size: 32, ...small});
    const lighting = new EnvironmentLighting(environment);
    engine.use(environment).use(lighting); lighting.applyTo(model);
    engine.render(); const lit = capture();
    let litPixels = 0, darkSum = 0, litSum = 0;
    for (let i = 0; i < lit.length; i += 4) if (covered(i)) {litPixels++; darkSum += dark[i] + dark[i + 1] + dark[i + 2]; litSum += lit[i] + lit[i + 1] + lit[i + 2];}
    assert(litPixels > 200 && litSum > darkSum + litPixels * 60, `IBL did not light the scene: ${darkSum} -> ${litSum} over ${litPixels} px`);
    // Full fog in the background color: the whole frame is that color, including the blended glTF triangle.
    const fog = new Fog({color: '#336699', near: 0, far: 0.001});
    engine.use(fog); fog.applyTo(model);
    engine.render(); const fogged = capture();
    let fogWorst = 0;
    for (let i = 0; i < fogged.length; i += 4) fogWorst = Math.max(fogWorst, Math.abs(fogged[i] - 51), Math.abs(fogged[i + 1] - 102), Math.abs(fogged[i + 2] - 153));
    assert(fogWorst <= 1, `full fog differs from its color by ${fogWorst}`);
    fog.far = 1000; fog.near = 999; engine.render(); const thin = capture();
    let thinWorst = 0; for (let i = 0; i < thin.length; i++) thinWorst = Math.max(thinWorst, Math.abs(thin[i] - lit[i]));
    assert(thinWorst <= 1, `fog beyond the scene changed it by ${thinWorst}`);
    await runtime.gpu.queue.onSubmittedWorkDone();
    const validation = await runtime.gpu.popErrorScope();
    assert(!validation && !gpuErrors.length, `scene lighting validation: ${validation?.message ?? gpuErrors.join('; ')}`);
    // Removing every effect restores the plain frame.
    engine.removePlugin(fog.name); engine.removePlugin(lighting.name); engine.removePlugin(background.name);
    engine.lighting.radiance.set(saved); engine.render(); const after = capture();
    let afterWorst = 0; for (let i = 0; i < after.length; i++) afterWorst = Math.max(afterWorst, Math.abs(after[i] - plain[i]));
    assert(afterWorst <= 1, `removing the scene effects left a difference of ${afterWorst}`);
    report.sceneLighting = {colorBackgroundError: bgWorst, scenePixels, litPixels, darkSum, litSum, fogError: fogWorst, thinFogError: thinWorst, removedError: afterWorst};
    model.dispose(); engine.dispose();
    report.checks.push('scene lighting: color background exact on cleared depth, IBL lights core meshes and glTF-pro, full fog covers opaque and blended geometry, removal restores the frame');
  }
  // 10. UltraHDR through the browser's own JPEG decoder: a gain-map JPEG assembled from two canvas-encoded JPEGs.
  {
    const encode = async (fill, width, height) => {
      const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
      context.fillStyle = fill; context.fillRect(0, 0, width, height);
      return new Uint8Array(await (await canvas.convertToBlob({type: 'image/jpeg', quality: 1})).arrayBuffer());
    };
    const withXmp = (jpeg, xmp) => {
      const payload = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0' + xmp), length = payload.length + 2;
      return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 255, ...payload, ...jpeg.subarray(2)]);
    };
    const primary = withXmp(await encode('#808080', 16, 8), '<rdf:Description hdrgm:Version="1.0"/>');
    const gain = withXmp(await encode('#ffffff', 4, 2), '<rdf:Description hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="3" hdrgm:OffsetSDR="0" hdrgm:OffsetHDR="0" hdrgm:HDRCapacityMax="3"/>');
    const file = new Uint8Array([...primary, ...gain]);
    const image = await decodeUltraHDR(file), expected = 8 * ((128 / 255 + 0.055) / 1.055) ** 2.4;
    let worst = 0;
    for (let i = 0; i < image.data.length; i += 4) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(image.data[i + k] - expected) / expected);
    assert(image.width === 16 && image.height === 8 && worst < 0.03, `UltraHDR decode ${image.width}x${image.height}, relative error ${worst}`);
    report.ultraHDR = {expected, relativeError: worst};
    report.checks.push('UltraHDR: browser-decoded primary and upsampled gain map recover 2^GainMapMax times the linear SDR value');
  }
  report.hardware = {vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, fallback: adapter.info?.isFallbackAdapter};
  report.validationErrors = 0;
  return report;
};
