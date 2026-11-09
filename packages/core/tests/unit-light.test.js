// Regression: shaders must not normalize the uniform-only light direction. ANGLE D3D11 on NVIDIA evaluated core's
// `normalize(frame.light.xyz)` on two paths whose results differed by an ulp, depending on GPU load, so identical
// frames shaded differently (packages/environment/tests/capture-stability-browser.mjs --compat --gpu-load). Core
// now uploads the unit direction, normalized once on the CPU, and every shader reads it as is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineKernel } from '../dist/index.js';
import { wgsl } from '../src/shaders.ts';
import { unitLight } from '../../shared/unit-light.js';

function fakeGPU(t) {
  const keys = ['navigator', 'GPUBufferUsage', 'GPUTextureUsage'],
    saved = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])),
    frames = [];
  const context = { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) };
  const canvas = { width: 64, height: 64, clientWidth: 64, clientHeight: 64, getContext: () => context };
  const resource = (descriptor) => Object.assign({ destroy() {} }, descriptor);
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, end() {} };
  const device = {
    features: new Set(),
    limits: { maxBufferSize: 2 ** 30 },
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {},
    queue: {
      writeBuffer(buffer, _offset, data) {
        if (buffer.size === 128) frames.push(Float32Array.from(data));
      },
      submit() {},
    },
    createShaderModule: (d) => d,
    createBindGroup: () => ({}),
    createBuffer: resource,
    createTexture: (d) => Object.assign(resource(d), { createView: () => ({}) }),
    createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: '',
      gpu: {
        requestAdapter: async () => ({ features: new Set(), requestDevice: async () => device }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
  });
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4, STORAGE: 8, INDEX: 16, INDIRECT: 32, COPY_SRC: 64, MAP_READ: 128 };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, COPY_SRC: 2 };
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  return { canvas, frames };
}

test('core uploads the light direction as a float32 unit vector and keeps the intensity', async (t) => {
  const { canvas, frames } = fakeGPU(t);
  const engine = await EngineKernel.create(canvas, { capacity: 4, backend: 'webgpu' });
  try {
    for (const direction of [
      [0.4, 0.7, 0.6, 2.5],
      [3, 5, 4, 3],
      [0, -1e-30, 0, 0],
      [3e38, 3e38, -3e38, 1],
    ]) {
      engine.lighting.direction.set(direction);
      engine.render();
      const light = frames.at(-1).subarray(20, 24),
        d = engine.lighting.direction,
        k = Math.hypot(d[0], d[1], d[2]);
      assert.deepEqual(
        Array.from(light),
        [Math.fround(d[0] / k), Math.fround(d[1] / k), Math.fround(d[2] / k), d[3]],
        `unit direction for ${direction}`,
      );
    }
    assert.deepEqual(Array.from(engine.lighting.direction), [3e38, 3e38, -3e38, 1].map(Math.fround), 'input untouched');
  } finally {
    engine.dispose();
  }
});

test('the shared writer matches core and leaves other slots alone', () => {
  const out = new Float32Array(8).fill(7);
  unitLight(out, 2, [0, 3, 4, 9]);
  assert.deepEqual(Array.from(out), [7, 7, 0, 0.6, 0.8, 9, 7, 7].map(Math.fround));
});

test('no shader normalizes a uniform-only light direction and every writer uploads the unit direction', () => {
  assert.match(wgsl, /let l=frame\.light\.xyz;/);
  const root = fileURLToPath(new URL('../../', import.meta.url)),
    offenders = [],
    // A shader normalizing a light uniform as is: the light or sun of a frame, or a light record's direction.
    normalized = /(?:normalize|length)\(\s*[A-Za-z_]\w*\.(?:light|sun|direction)\.xyz\s*\)/g,
    // A frame write of the engine light as given, not through unitLight (core's renderer normalizes its own copy).
    raw = /\.set\([^,()]*lighting\.direction\s*,/g;
  const scan = (path) => {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(normalized)) offenders.push(`${path}: ${m[0]}`);
    if (!path.replaceAll('\\', '/').endsWith('core/src/renderer.ts'))
      for (const m of text.matchAll(raw)) offenders.push(`${path}: ${m[0]}`);
  };
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|js|wgsl)$/.test(name) && !name.endsWith('.d.ts')) scan(path);
    }
  };
  for (const name of readdirSync(root)) {
    const src = join(root, name, 'src');
    if (existsSync(src) && statSync(src).isDirectory()) walk(src);
  }
  for (const name of readdirSync(join(root, 'shared'))) if (name.endsWith('.js')) scan(join(root, 'shared', name));
  assert.deepEqual(offenders, []);
});
