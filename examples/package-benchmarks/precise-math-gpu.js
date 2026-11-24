// The page of precise-math-gpu.mjs. Every compute pass gets GPU timestamps by wrapping beginComputePass, so what is
// timed is the package's own dispatch, with its own shader, and nothing in the package changes.
import { engineRuntime } from '/packages/core/dist/extension.js';
import { Engine } from '/packages/core/dist/index.js';
import { createCompute } from '/packages/compute/dist/index.js';
import { VoxelPathTracer } from '/packages/voxel-pathtracer/dist/index.js';

const SLOTS = 2048; // a query set holds at most 4,096 timestamps
let timer;

/** Times every compute pass of `device` from here on. */
function timePasses(device) {
  const querySet = device.createQuerySet({ type: 'timestamp', count: SLOTS * 2 }),
    resolve = device.createBuffer({ size: SLOTS * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
    read = device.createBuffer({ size: SLOTS * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  timer = { querySet, next: 0 };
  return async () => {
    const used = timer.next;
    if (used >= SLOTS) throw new Error('more compute passes than timestamp slots');
    timer.next = 0;
    if (!used) return [];
    const encoder = device.createCommandEncoder();
    encoder.resolveQuerySet(querySet, 0, used * 2, resolve, 0);
    encoder.copyBufferToBuffer(resolve, 0, read, 0, used * 16);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const ticks = new BigUint64Array(read.getMappedRange().slice(0, used * 16));
    read.unmap();
    const ms = [];
    for (let i = 0; i < used; i++) ms.push(Number(ticks[2 * i + 1] - ticks[2 * i]) / 1e6);
    return ms;
  };
}

const begin = GPUCommandEncoder.prototype.beginComputePass;
GPUCommandEncoder.prototype.beginComputePass = function (descriptor = {}) {
  if (!timer || timer.next >= SLOTS) {
    if (timer) timer.next = SLOTS;
    return begin.call(this, descriptor);
  }
  const i = timer.next++;
  return begin.call(this, {
    ...descriptor,
    timestampWrites: { querySet: timer.querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 },
  });
};

const uniform = (n, low, high, seed) => {
  const out = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = low + ((s >>> 0) / 4294967296) * (high - low);
  }
  return out;
};

// Inputs inside each function's domain, wide enough to take every branch a real caller takes.
const FUNCTIONS = {
  sin: [-100, 100],
  'sin (huge)': [1e6, 1e9, 'sin'],
  cos: [-100, 100],
  tan: [-1.5, 1.5],
  asin: [-1, 1],
  acos: [-1, 1],
  atan: [-50, 50],
  atan2: [-50, 50],
  exp: [-20, 20],
  exp2: [-20, 20],
  expm1: [-2, 2],
  log: [1e-6, 1000],
  log2: [1e-6, 1000],
  log1p: [-0.9, 10],
  sinh: [-8, 8],
  cosh: [-8, 8],
  tanh: [-8, 8],
  pow: [0.01, 10],
};

window.computeCost = async ({ count, trials }) => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
    device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] }),
    passes = timePasses(device),
    precise = await createCompute({ device }),
    fast = await createCompute({ device, fastMath: true }),
    rows = {};
  const run = async (context, name, a, b) => {
    const op = FUNCTIONS[name][2] ?? name,
      x = context.array(a),
      y = context.array(b);
    const call = () => (op === 'pow' || op === 'atan2' ? x[op](y) : x[op]());
    let last;
    await call().read(); // compiles the pipeline
    await passes();
    const times = [];
    for (let t = 0; t < trials; t++) {
      last = await call().read();
      const ms = await passes();
      times.push(ms.reduce((sum, v) => sum + v, 0));
    }
    x.dispose?.();
    y.dispose?.();
    return { times, last };
  };
  for (const [name, [low, high]] of Object.entries(FUNCTIONS)) {
    const a = uniform(count, low, high, 12345),
      b = uniform(count, -4, 4, 54321),
      p = await run(precise, name, a, b),
      f = await run(fast, name, a, b);
    let differ = 0;
    for (let i = 0; i < count; i++) if (p.last[i] !== f.last[i] && (p.last[i] === p.last[i] || f.last[i] === f.last[i])) differ++;
    rows[name] = { precise: p.times, fast: f.times, differ: differ / count };
  }
  return { adapter: adapter.info?.description ?? adapter.info?.vendor ?? '', rows };
};

// The builtin arm of the tracer: the ray generation's calls only (nothing else in TRACE calls these).
window.tracerCost = async ({ builtin, width, height, samples, trials, bounces }) => {
  if (builtin) {
    const create = GPUDevice.prototype.createShaderModule;
    let swapped = 0;
    GPUDevice.prototype.createShaderModule = function (descriptor) {
      const code = descriptor.code.replace(/(?<!fn )precise(Sin|Cos|Asin|Atan)\(/g, (_, f) => {
        swapped++;
        return `${f.toLowerCase()}(`;
      });
      return create.call(this, { ...descriptor, code });
    };
    window.swapped = () => swapped;
  }
  const canvas = document.querySelector('canvas'),
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      features: ['timestamp-query'],
      camera: { position: [0, 12, 0], target: [0, 12, -1], near: 0.1, far: 2000 },
    }),
    device = engineRuntime(engine).gpu,
    passes = timePasses(device);
  // A town of solid blocks around the eye, so every ray hits something within a few steps.
  const size = 96,
    voxels = new Uint8Array(size * size * size);
  for (let y = 0; y < size; y++)
    for (let z = 0; z < size; z++)
      for (let x = 0; x < size; x++) {
        const tall = 8 + (((x >> 4) * 7 + (z >> 4) * 13) % 5) * 12,
          street = (x & 15) < 3 || (z & 15) < 3;
        if (y < 4 || (!street && y < tall)) voxels[x + size * (z + size * y)] = 1 + ((x >> 3) + (z >> 3)) % 3;
      }
  const scene = {
    revision: 1,
    models: [{ id: 'town', revision: 1, size: [size, size, size], voxels }],
    instances: [{ id: 'town', modelId: 'town', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -48, 0, -48, 1] }],
    materials: [
      { id: 1, color: [0.8, 0.5, 0.3], type: 'diffuse' },
      { id: 2, color: [0.4, 0.6, 0.7], type: 'diffuse' },
      { id: 3, color: [0.7, 0.7, 0.6], type: 'diffuse' },
    ],
  };
  const tracer = VoxelPathTracer.attach(engine, { scene, maxBounces: bounces });
  await tracer.ready;
  const lenses = {
    camera: { projection: 'camera' },
    panorama: { projection: 'panorama' },
    'fisheye equidistant': { projection: 'fisheye', fisheye: { mapping: 'equidistant', fov: 180 } },
    'fisheye equisolid': { projection: 'fisheye', fisheye: { mapping: 'equisolid', fov: 180 } },
    'fisheye stereographic': { projection: 'fisheye', fisheye: { mapping: 'stereographic', fov: 180 } },
  };
  const rows = {};
  for (const [name, options] of Object.entries(lenses)) {
    tracer.setOptions(options);
    // Compiles, then brings the clocks up: the first lens of a page ran twice as slow without this.
    for (let warm = 0; warm < 3; warm++) await tracer.renderImage({ width, height, samples });
    await tracer.whenIdle();
    await passes();
    const times = [];
    let mean = 0;
    for (let t = 0; t < trials; t++) {
      const image = await tracer.renderImage({ width, height, samples });
      await tracer.whenIdle();
      const ms = await passes();
      times.push(ms.reduce((sum, v) => sum + v, 0) / samples);
      mean = 0;
      for (let i = 0; i < image.color.length; i += 97) mean += image.color[i];
      mean /= image.color.length / 97;
    }
    rows[name] = { times, mean };
  }
  tracer.dispose();
  const swapped = window.swapped?.() ?? 0;
  engine.dispose();
  return { rows, swapped };
};

window.ready = true;
