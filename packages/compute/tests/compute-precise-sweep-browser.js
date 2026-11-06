// The precise trig functions over every binade they reduce and precisePow at extreme exponents, on the real GPU,
// against double precision (bug 29): preciseSin, preciseCos and preciseTan on 4,096 random mantissas per binade from
// 2^-12 to 2^127 plus each binade's ends (573,720 inputs), precisePow on 400,000 pairs: results across the f32 range,
// x near 1 with |y| up to 2^30, negative x with whole y, large results from x up to 1.41, and tiny to huge |y|. Each
// line says how many inputs are over
// the function's bound in ulp (the bounds of tests/precise-math-reference.js); window.runPreciseSweep throws when any is.
import { preciseMathWgsl } from '../../shared/precise-math.js';
import { ulpOf } from '../../../tests/precise-math-reference.js';

const F = Math.fround;
const bits = new Uint32Array(1),
  float = new Float32Array(bits.buffer);
const fromBits = (u) => {
  bits[0] = u >>> 0;
  return float[0];
};

function trigInputs(perBinade, random) {
  const a = [];
  for (let e = 115; e <= 254; e++) {
    a.push(fromBits(e << 23), fromBits((e << 23) | 0x7fffff));
    for (let i = 0; i < perBinade; i++) a.push(fromBits((e << 23) | ((random() * 0x800000) >>> 0)));
  }
  return a;
}

function powInputs(n, random) {
  const x = [],
    y = [];
  for (let i = 0; i < n; i++) {
    let a, b;
    switch (i % 5) {
      case 0: // y log2 x from -150 to 128: every result size
        a = F(2 ** (random() * 252 - 126) * (1 + random()));
        b = (random() * 278 - 150) / Math.log2(a);
        break;
      case 1: // x within 2^-23 to 1/2 of 1, |y| up to 2^30
        a = F(1 + (random() * 2 - 1) * 2 ** -(1 + random() * 22));
        b = (random() * 2 - 1) * 2 ** (random() * 30);
        break;
      case 2: // negative x, whole y
        a = F(-(random() * 100));
        b = Math.round(random() * 60 - 30);
        break;
      case 3: // x from 1 to the top of pow's log reduction, the result near the top of the range: y multiplies any error in the log
        a = F(1 + random() * 0.4142);
        b = (100 + random() * 28) / Math.log2(a);
        break;
      default: // any x, |y| from 2^-20 to 2^20
        a = F(2 ** (random() * 252 - 126));
        b = (random() * 2 - 1) * 2 ** (random() * 40 - 20);
    }
    x.push(a);
    y.push(F(b));
  }
  return [x, y];
}

async function run(device, name, args, xs, ys) {
  const count = xs.length,
    make = (data) => {
      const buffer = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
      new Float32Array(buffer.getMappedRange()).set(data);
      buffer.unmap();
      return buffer;
    };
  const A = make(xs),
    B = make(ys ?? xs),
    O = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    R = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const code = `${preciseMathWgsl([name])}
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> O: array<f32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = g.x + g.y * n.x * 256u;
  if (i >= arrayLength(&O)) { return; }
  let a = A[i]; let b = B[i];
  O[i] = ${name}(${args});
}`;
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [A, B, O].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass(),
    groups = Math.ceil(count / 256);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.min(groups, 4096), Math.ceil(groups / 4096));
  pass.end();
  encoder.copyBufferToBuffer(O, 0, R, 0, count * 4);
  device.queue.submit([encoder.finish()]);
  await R.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(R.getMappedRange().slice(0));
  R.unmap();
  for (const buffer of [A, B, O, R]) buffer.destroy();
  return out;
}

/** Runs the sweep; returns { lines, adapter } and throws, after all four, when any input is over its bound. */
window.runPreciseSweep = async (perBinade = 4096, powCount = 400000) => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
    device = await adapter.requestDevice();
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const lines = [],
    failed = [];
  const report = (name, xs, ys, out, ref, bound) => {
    let worst = 0,
      at = null,
      over = 0,
      counted = 0;
    for (let i = 0; i < out.length; i++) {
      const want = ys ? ref(xs[i], ys[i]) : ref(xs[i]);
      // Results that overflow f32 or are subnormal (a GPU may flush them) are not counted.
      if (!Number.isFinite(want) || Math.abs(want) >= 2 ** 128 || Math.abs(want) < 2 ** -126) continue;
      counted++;
      const ulp = Number.isNaN(out[i]) ? Number.POSITIVE_INFINITY : Math.abs(out[i] - want) / ulpOf(want),
        b = ys ? bound(xs[i], ys[i]) : bound;
      if (ulp > b) over++;
      if (ulp / b > worst) {
        worst = ulp / b;
        at = { x: xs[i], ...(ys ? { y: ys[i] } : {}), got: out[i], want, ulp, bound: b };
      }
    }
    lines.push(
      `${name}: ${over} over bound of ${counted} inputs, worst ${worst.toFixed(3)} of bound ${JSON.stringify(at)}`,
    );
    if (over) failed.push(name);
  };
  const xs = trigInputs(perBinade, random);
  for (const [name, ref, bound] of [
    ['preciseSin', Math.sin, 1],
    ['preciseCos', Math.cos, 1],
    ['preciseTan', Math.tan, 2.5],
  ])
    report(name, xs, null, await run(device, name, 'a', xs), ref, bound);
  const [px, py] = powInputs(powCount, random);
  report(
    'precisePow',
    px,
    py,
    await run(device, 'precisePow', 'a, b', px, py),
    (x, y) => x ** y,
    (x, y) => (Math.abs(y * Math.log2(Math.abs(x))) < 16 ? 2 : 5),
  );
  const info = adapter.info ?? {};
  device.destroy();
  if (failed.length) throw new Error(`over bound: ${failed.join(', ')}\n${lines.join('\n')}`);
  return { lines, adapter: { vendor: info.vendor, architecture: info.architecture } };
};
