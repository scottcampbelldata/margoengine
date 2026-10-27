// The precise WGSL maths (packages/shared/precise-math.js) on the real GPU: every function over the dense input sets
// of tests/precise-math-reference.js, against the exact value (each within its bound in ulp) and against the host
// reference that mirrors the shader operation for operation (the same f32 values unless the GPU fused a multiply-add;
// reported as the share that match bit for bit). The builtins are measured on the same inputs for the record.
import { preciseMathWgsl } from '../../shared/precise-math.js';
import { preciseCases, preciseReference, ulpOf, worstError } from '../../../tests/precise-math-reference.js';

const NAMES = {
  sin: 'preciseSin',
  cos: 'preciseCos',
  tan: 'preciseTan',
  asin: 'preciseAsin',
  acos: 'preciseAcos',
  atan: 'preciseAtan',
  atan2: 'preciseAtan2',
  exp: 'preciseExp',
  exp2: 'preciseExp2',
  expm1: 'preciseExpm1',
  log: 'preciseLog',
  log2: 'preciseLog2',
  log1p: 'preciseLog1p',
  sinh: 'preciseSinh',
  cosh: 'preciseCosh',
  tanh: 'preciseTanh',
  pow: 'precisePow',
};
const BUILTIN = { atan2: 'atan2', pow: 'pow', log1p: null, expm1: null };

async function run(device, code, inputs, count) {
  const make = (data) => {
    const buffer = device.createBuffer({
      size: Math.max(16, data.byteLength),
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  };
  const a = make(inputs[0]),
    b = make(inputs[1] ?? inputs[0]),
    out = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    read = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ code });
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [a, b, out].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(count / 256));
  pass.end();
  encoder.copyBufferToBuffer(out, 0, read, 0, count * 4);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(read.getMappedRange().slice(0));
  read.unmap();
  for (const buffer of [a, b, out, read]) buffer.destroy();
  return result;
}

const kernel = (helpers, call) => `${helpers}
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> O: array<f32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= arrayLength(&O)) { return; }
  let a = A[i]; let b = B[i];
  O[i] = ${call};
}`;

/** Runs every precise function on the GPU; returns { checks, results } and throws when one is out of its bound. */
window.runPreciseTests = async (n = 1 << 14) => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
    device = await adapter.requestDevice();
  const cases = preciseCases(n),
    reference = preciseReference(),
    fused = preciseReference({ fused: true }),
    checks = [],
    results = {};
  for (const [name, c] of Object.entries(cases)) {
    const two = c.sets[0].length === 2,
      flat = [0, 1].slice(0, two ? 2 : 1).map((k) => Float32Array.from(c.sets.flatMap((set) => set[k]))),
      count = flat[0].length,
      args = two ? 'a, b' : 'a';
    const gpu = await run(device, kernel(preciseMathWgsl([NAMES[name]]), `${NAMES[name]}(${args})`), flat, count);
    const builtin =
      BUILTIN[name] === null ? null : await run(device, kernel('', `${BUILTIN[name] ?? name}(${args})`), flat, count);
    // The GPU's answer by position (the sets are flattened in order).
    const at =
      (values) =>
      (...args) =>
        values[args[args.length - 1]];
    const gpuError = worstError(at(gpu), c),
      builtinError = builtin ? worstError(at(builtin), c) : null;
    let exact = 0,
      exactFused = 0,
      maxFromReference = 0;
    for (let i = 0; i < count; i++) {
      const x = [flat[0][i], flat[1]?.[i]].slice(0, two ? 2 : 1),
        want = reference[name](...x),
        g = gpu[i];
      if (Object.is(g, want) || (Number.isNaN(g) && Number.isNaN(want))) exact++;
      else if (Object.is(g, fused[name](...x))) exactFused++;
      // Subnormal results are skipped: a GPU may flush them to zero.
      else if (Number.isFinite(want) && Math.abs(want) >= 2 ** -126)
        maxFromReference = Math.max(maxFromReference, Math.abs(g - want) / ulpOf(want));
    }
    results[name] = {
      count,
      maxUlp: Number(gpuError.ulp.toFixed(3)),
      bound: typeof c.bound === 'number' ? c.bound : 'by |y log2 x|',
      sameAsReference: exact / count,
      sameAsFusedReference: exactFused / count,
      maxUlpFromReference: Number(maxFromReference.toFixed(3)),
      builtinMaxUlp: builtinError ? Number(builtinError.ulp.toFixed(1)) : null,
    };
    if (!(gpuError.ratio <= 1))
      throw new Error(
        `${NAMES[name]}: ${gpuError.ulp} ulp off at ${JSON.stringify(gpuError.at)} (bound ${gpuError.at.bound})`,
      );
    // A difference from the mirror beyond rounding means the shader and tests/precise-math-reference.js drifted apart.
    if (!(maxFromReference <= 2))
      throw new Error(`${NAMES[name]}: ${maxFromReference} ulp from the host reference; keep the two in step`);
    checks.push(
      `${NAMES[name]} within ${results[name].maxUlp} ulp (bound ${results[name].bound}) on ${count} inputs, ${(100 * exact) / count}% bit for bit as the host reference`,
    );
  }
  device.destroy();
  return { checks, results };
};
