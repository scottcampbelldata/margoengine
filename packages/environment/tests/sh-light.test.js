// CPU checks (mock GPU) for SHLight, the light probe given as nine RGB SH coefficients: the ambient-slot patch shared
// with HemisphereLight, gltf/pbr's sky hook, the uploaded polynomial against Ramamoorthi and Hanrahan's irradiance, and
// the live uniform. Values on a real adapter: examples/package-benchmarks/light-features-gpu.mjs (check 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { lightPBR } from '../../shared/pbr-hooks.js';
import { pbrShader } from '../../gltf/src/shader.ts';
import { SHLight, HemisphereLight, EnvironmentLighting, projectEquirectSH } from '../dist/index.js';
import { LightProbes } from '../dist/probes.js';

const coreShader = readFileSync(new URL('../../core/src/shaders.ts', import.meta.url), 'utf8').split('`')[1];
const fragment = (shader) => shader.slice(shader.lastIndexOf('@fragment fn fragment'));
const linearLine = (shader) => /let linear=[^;]+;/.exec(fragment(shader))[0];
const fakeEngine = (device) => ({
  backend: 'webgpu',
  gpu: device,
  onError() {},
  sceneOf() {
    return this;
  },
  removePlugin() {},
});
const fakeEnvironment = (device) => ({
  device,
  disposed: false,
  version: 0,
  specularView: {},
  sampler: {},
  brdfLut: {},
  shBuffer: {},
  paramsBuffer: {},
  restore: () => Promise.resolve(),
});
const hexFloats = (hex) => {
  const b = Buffer.from(hex, 'hex');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};
// The shader's margoSkyLight on the uploaded nine vec4 (the WGSL in src/sh-light.ts, term for term).
function shaderValue(values, n) {
  const l = Math.hypot(...n),
    [x, y, z] = n.map((v) => v / l),
    terms = [1, y, z, x, x * y, y * z, 3 * z * z - 1, x * z, x * x - y * y];
  return [0, 1, 2].map((c) =>
    Math.max(
      0,
      terms.reduce((sum, t, k) => sum + values[k * 4 + c] * t, 0),
    ),
  );
}
const directions = [];
for (let i = 0; i < 64; i++) {
  const y = 1 - (2 * (i + 0.5)) / 64,
    r = Math.sqrt(1 - y * y),
    phi = i * 2.399963229728653;
  directions.push([r * Math.cos(phi), y, r * Math.sin(phi)]);
}
const close = (a, b, eps, what) =>
  a.forEach((v, k) => assert.ok(Math.abs(v - b[k]) <= eps, `${what}: ${a} against ${b}`));

test('SHLight takes the ambient slot like HemisphereLight: core, terrain, IBL in either order, probes fallback', () => {
  const gpu = mockGPU(),
    engine = fakeEngine(gpu.device),
    light = new SHLight({ coefficients: Array(9).fill([0.5, 0.5, 0.5]) }),
    ibl = new EnvironmentLighting(fakeEnvironment(gpu.device)),
    probes = new LightProbes({ volume: { min: [-2, 0, -2], max: [2, 3, 2], counts: [2, 2, 2] } });
  for (const effect of [light, ibl, probes]) effect.setup(engine);
  const alone = light.shader(coreShader, 0);
  assert.match(alone, /@group\(0\) @binding\(144\) var<uniform> margoSkyLightData:MargoSkyLight;/);
  assert.match(alone, /struct MargoSkyLight \{c:array<vec4f,9>\}/);
  assert.equal(
    linearLine(alone),
    'let linear=direct*frame.radiance.xyz*frame.light.w+i.color*(1.0-i.material.y)*margoSkyLight(n);',
  );
  for (const code of [light.shader(ibl.shader(coreShader, 0), 0), ibl.shader(light.shader(coreShader, 0), 0)])
    assert.ok(linearLine(code).includes('*margoSkyLight(n)') && linearLine(code).endsWith('+margoAmbient;'));
  for (const code of [light.shader(probes.shader(coreShader, 0), 0), probes.shader(light.shader(coreShader, 0), 0)])
    assert.match(fragment(code), /probeShade\([^;]*\*margoSkyLight\(n\),vec3f\(0\.04\),1\.0\)/);
  // One ambient light per engine, whichever kind came first.
  const hemisphere = new HemisphereLight();
  hemisphere.setup(engine);
  assert.throws(() => light.shader(alone, 0), /one per engine/);
  assert.throws(() => hemisphere.shader(alone, 0), /one per engine/);
  assert.throws(() => light.shader(hemisphere.shader(coreShader, 0), 0), /SHLight/);
  // gltf/pbr: the sky hook, no texture or sampler.
  const hook = light.pbr(2);
  assert.doesNotMatch(hook.declarations, /texture_|sampler/);
  assert.ok(lightPBR(pbrShader, hook).includes('fn margoSkyHook(n:vec3f)->vec3f {return margoSkyLight(n);}'));
});

test('a constant radiance L lights every normal with L, like AmbientLight of colour L', () => {
  const L = [0.3, 0.6, 0.9],
    // Projection of a constant: c0 = L x 4 pi x Y00, every other coefficient 0.
    c0 = L.map((v) => v * 4 * Math.PI * 0.282094792),
    light = new SHLight({ coefficients: [c0, ...Array(8).fill([0, 0, 0])] });
  for (const n of directions) {
    close(light.irradiance(n), L, 1e-6, 'irradiance()');
    close(shaderValue(light['values'], n), L, 1e-6, 'shader');
  }
});

test('irradiance matches the cosine integral of the projected radiance (Ramamoorthi and Hanrahan 2001)', () => {
  // A sky gradient with a warm sun side, L(d) = a + b d.y + s max(0, d.x)^2, projected by projectEquirectSH.
  const width = 128,
    height = 64,
    data = new Float32Array(width * height * 4),
    radiance = ([x, y]) => [0.2 + 0.5 * y + 0.8 * Math.max(0, x) ** 2, 0.25 + 0.5 * y, 0.3 + 0.6 * y].map((v) => v + 1);
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const theta = (Math.PI * (row + 0.5)) / height,
        phi = 2 * Math.PI * ((col + 0.5) / width - 0.5),
        d = [Math.sin(theta) * Math.sin(phi), Math.cos(theta), -Math.sin(theta) * Math.cos(phi)];
      data.set([...radiance(d), 1], (row * width + col) * 4);
    }
  const light = new SHLight({ coefficients: projectEquirectSH({ width, height, data }), intensity: 1 });
  // Brute force E(n) / pi = (1/pi) int L(w) max(0, n.w) dw over a fine sphere grid.
  const exact = (n) => {
    const out = [0, 0, 0],
      rows = 256,
      cols = 512;
    for (let r = 0; r < rows; r++) {
      const t0 = (Math.PI * r) / rows,
        t1 = (Math.PI * (r + 1)) / rows,
        t = (t0 + t1) / 2,
        dw = ((2 * Math.PI) / cols) * (Math.cos(t0) - Math.cos(t1));
      for (let c = 0; c < cols; c++) {
        const p = (2 * Math.PI * (c + 0.5)) / cols,
          w = [Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)],
          cos = n[0] * w[0] + n[1] * w[1] + n[2] * w[2];
        if (cos > 0) radiance(w).forEach((v, k) => (out[k] += (v * cos * dw) / Math.PI));
      }
    }
    return out;
  };
  for (const n of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], directions[17], directions[40]]) {
    const want = exact(n),
      got = light.irradiance(n);
    // L2 SH keeps 99% of the Lambert-convolved energy of smooth light (Ramamoorthi and Hanrahan: error under 3%).
    want.forEach((v, k) => assert.ok(Math.abs(got[k] - v) <= 0.03 * v, `n ${n} channel ${k}: ${got[k]} vs ${v}`));
    close(shaderValue(light['values'], n), got, 1e-5, 'shader polynomial');
  }
});

test('the nine terms follow the documented order: y, z, x, xy, yz, 3z^2-1, xz, x^2-y^2', () => {
  // A single coefficient per band lights the matching lobe: (1,-1) is +y, (1,0) +z, (1,1) +x.
  for (const [k, n] of [
    [1, [0, 1, 0]],
    [2, [0, 0, 1]],
    [3, [1, 0, 0]],
  ]) {
    const c = Array.from({ length: 9 }, (_, i) => (i === 0 ? [3, 3, 3] : i === k ? [1, 1, 1] : [0, 0, 0])),
      light = new SHLight({ coefficients: c }),
      up = light.irradiance(n)[0],
      down = light.irradiance(n.map((v) => -v))[0];
    assert.ok(up > down, `coefficient ${k} brightens ${n}`);
    close(shaderValue(light['values'], n), light.irradiance(n), 1e-6, `shader term ${k}`);
  }
  const quad = new SHLight({ coefficients: [...Array(27).keys()].map((i) => Math.sin(i + 1)) });
  for (const n of directions) close(shaderValue(quad['values'], n), quad.irradiance(n), 1e-5, 'all terms');
});

test('SHLight uploads once per change, live, and validates its input', () => {
  assert.throws(() => new SHLight({ intensity: -1 }), RangeError);
  assert.throws(() => new SHLight({ coefficients: [1, 2, 3] }), /9 \[r, g, b\] triples or 27 numbers/);
  assert.throws(() => new SHLight({ coefficients: Array(27).fill(Number.NaN) }), /finite/);
  const gpu = mockGPU(),
    flat = Array.from({ length: 27 }, (_, i) => (i < 3 ? 2 : 0)),
    light = new SHLight({ coefficients: flat, intensity: 2 });
  light.setup(fakeEngine(gpu.device));
  const run = passes(light),
    frame = context(gpu, { shader: coreShader, format: 'bgra8unorm' });
  const upload = (n) =>
    gpu
      .record(() => {
        for (let i = 0; i < n; i++) {
          frame.begin(i);
          run(frame.c);
        }
      })
      .filter((e) => e[0] === 'writeBuffer')
      .map((e) => [...hexFloats(e[3])]);
  const first = upload(3);
  assert.equal(first.length, 1, 'one upload for three frames');
  assert.equal(first[0].length, 36);
  close(first[0].slice(0, 3), [2 * 2 * 0.282094792, 2 * 2 * 0.282094792, 2 * 2 * 0.282094792], 1e-6, 'c0');
  light.coefficients = Array(9).fill([0, 0, 0]);
  assert.deepEqual(upload(1), [Array(36).fill(0)]);
  assert.deepEqual(upload(2), [], 'nothing changed');
  assert.equal(light.coefficients.length, 27);
  assert.equal(light.name, 'environment:sh');
  light.dispose();
});
