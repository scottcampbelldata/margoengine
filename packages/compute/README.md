# @margoengine/compute

Install `npm i margoengine` and import `margoengine/compute` (or this package alone: `npm i @margoengine/compute`,
imported as `@margoengine/compute`; the two are the same module).

GPU compute without the WebGPU boilerplate, for data science and for engine work. It feels like NumPy: N-dimensional
typed arrays with views and broadcasting, element-wise expressions that fuse into a single kernel, reductions and
statistics along axes, scans, sorting, selection and histograms. It also runs your own WGSL kernels, with bindings
read from the source. Optional entries add matrix products (`/linalg`), Fourier transforms (`/fft`), convolution
(`/signal`), reproducible random numbers (`/random`), sparse matrices and solvers (`/sparse`), gradients
(`/autodiff`), data larger than GPU memory (`/stream`) and kernels inside an engine's frame (`/frame`).

The package is optional and tree-shakable, adds nothing to core, and needs no engine: without one it opens a
headless device of its own. Without WebGPU (Node, an older browser, a blocklisted GPU) the same code runs on the CPU.


```ts
import { createCompute } from '@margoengine/compute';

using gpu = await createCompute(); // disposed (arrays and device freed) at the end of the block
const x = gpu.array(new Float32Array([3, 1, 4, 1, 5, 9, 2, 6]));
const sorted = await gpu.sort(x).read(); // Float32Array [1, 1, 2, 3, 4, 5, 6, 9]
const mean = await x.mean().item(); // 3.875
const z = x.sub(x.mean()).div(x.std()); // one fused kernel; nothing runs until it is read
console.log(sorted, mean, await z.read());
```

## Arrays

`gpu.array(data, { dtype, shape })` uploads a TypedArray or a plain array. The dtype comes from the TypedArray:
floats give `f32` (Float64Array is converted), signed integers give `i32`, unsigned integers give `u32`, and
Float16Array gives `f16` on GPUs with `shader-f16` (check `gpu.f16`). Plain arrays default to `f32`. The second
argument may be just the dtype. Creation helpers: `zeros`, `ones`, `full`, `arange`, `linspace`, `eye`.

`read()` resolves the elements in C order (`{ offset, length, signal }` reads part of them), and `item()` resolves the
one value of a single-element array. Disposing an array frees its GPU memory; disposing the context frees every array
it made.

```ts
import { createCompute } from '@margoengine/compute';

using gpu = await createCompute();
const m = gpu.array([1, 2, 3, 4, 5, 6], { shape: [2, 3] });
const counts = gpu.zeros(10, 'u32');
const steps = gpu.arange(0, 1, 0.25); // f32 [0, 0.25, 0.5, 0.75]
console.log(m.shape, counts.size, await steps.read());
```

Views cost no copy: `reshape(2, -1)`, `transpose()` or `.T`, `slice(...)` (an index, `[start, stop, step]` with
negative steps, or `null` for a whole dimension), `expandDims`, `squeeze` and `broadcastTo`. A view reads through
its strides, inside the same fused kernel.

```ts
import { createCompute } from '@margoengine/compute';

using gpu = await createCompute();
const m = gpu.array(Float32Array.from({ length: 12 }, (_, k) => k), { shape: [3, 4] });
console.log(await m.T.read()); // the transpose, read in its own C order
console.log(await m.slice(null, [1, 3]).read()); // columns 1 and 2: [1, 2, 5, 6, 9, 10]
console.log(await m.slice([null, null, -1]).read()); // the rows reversed
```

## Fused expressions

Element-wise methods return lazy `Expr`essions, which follow NumPy's broadcasting and type promotion. Nothing runs
until you `read()` or `eval()` the expression or hand it to a reduction, and then the whole tree compiles into one
kernel, so no intermediate array is ever written. Constants travel in a uniform, so changing one does not recompile.

The element-wise methods:

- **Arithmetic:** `add`, `sub`, `mul`, `div` (true division; integers give f32), `floorDiv`, `mod` (NumPy sign
  rules), `pow`, `minimum`, `maximum`, `clip`, `abs`, `neg`, `sign`, `square`.
- **Maths:** `sqrt`, `rsqrt`, `reciprocal`, `exp`, `exp2`, `expm1`, `log`, `log2`, `log1p`, the trigonometric and
  hyperbolic functions, `atan2`, `hypot`, `degrees`, `radians`.
- **Rounding:** `floor`, `ceil`, `round` (ties to even), `trunc`.
- **Comparison and logic** (all give u32 0/1): `lt`, `le`, `gt`, `ge`, `eq`, `ne`, `and`, `or`, `xor`, `not`,
  `isnan`, `isinf`, `isfinite`.
- **Integer bits:** `bitAnd`, `bitOr`, `bitXor`, `bitNot`, `shiftLeft`, `shiftRight`, `popcount`.
- **Conversion:** `astype(dtype)`, `bitcast(dtype)`.

`gpu.where(cond, a, b)` selects element-wise. `gpu.map(x, 'WGSL expression')` covers anything the methods do not.

```ts
import { createCompute } from '@margoengine/compute';

using gpu = await createCompute();
const x = gpu.array(new Float32Array([-2, -1, 0, 1, 2]));
const relu = gpu.where(x.gt(0), x, 0); // [0, 0, 0, 1, 2]
const table = gpu.arange(1, 4, 1, 'f32').reshape(3, 1).mul(gpu.arange(1, 4, 1, 'f32')); // 3 x 3 broadcast
const custom = gpu.map(x, 'x * x * sign(x)');
console.log(await relu.read(), await table.read(), await custom.read());
```

## Reductions and statistics

The reductions are `sum`, `prod`, `min`, `max`, `mean`, `var` and `std` (both take `ddof`), `argmin`, `argmax`, `all`,
`any`, `countNonzero`, and the NaN-ignoring `nansum`, `nanmean`, `nanmin` and `nanmax`. Each runs over every element,
or along `axis` (a number or a list), with `keepdims`. Each is available as a method or on the context. Results are
arrays: shape `[]` for a full reduction, read with `item()`. The first pass reads the expression it is given, so
`x.sub(m).square().sum()` is one pass over `x`. `gpu.reduce(x, { combine: 'max(a, b)', identity: '0u' })` takes
any associative WGSL operator.

```ts
import { createCompute } from '@margoengine/compute';

using gpu = await createCompute();
const data = gpu.array(new Float32Array([1, 9, 3, 7, 2, 8]), { shape: [2, 3] });
console.log(await data.sum({ axis: 0 }).read()); // [3, 17, 11]
console.log(await data.argmax({ axis: 1 }).read()); // [1, 2]
console.log(await data.std({ ddof: 1 }).item());
console.log(await gpu.nanmean(gpu.array([1, NaN, 3])).item()); // 2
```

## Scan, sort and selection

| Call | What it does |
| --- | --- |
| `gpu.cumsum(x, { axis })`, `cumprod`, `scan(x, { op, exclusive, axis })` | prefix scans, flat or along an axis |
| `gpu.segmentedScan(values, flags)` | a scan that restarts where a flag is set |
| `await gpu.reduceByKey(keys, values, { op })` | group-by over runs of equal keys |
| `gpu.sort(x, { descending, bits })`, `argsort`, `sortByKey(keys, values)` | stable GPU radix sort of any type |
| `gpu.topk(x, k)`, `quantile(x, q)`, `median(x)`, `await gpu.unique(x, { counts })` | order statistics |
| `gpu.take(x, indices, { axis, mode })` | gather (NumPy `take`; negative indices count from the end) |
| `gpu.scatter(target, indices, values, { op })` | write in place; `add`, `min`, `max` combine duplicates atomically, f32 included |
| `gpu.bincount(indices, { length, weights })` | counts or weight sums per value |
| `gpu.compact(x, mask)` | packed survivors plus a GPU-side count, with no readback |
| `await gpu.filter(x, mask)`, `await gpu.nonzero(mask)` | exactly sized results |
| `gpu.histogram(x, { bins, range })` | NumPy bins; the range is found on the GPU when not given |

```ts
import { createCompute } from '@margoengine/compute';

using gpu = await createCompute();
const scores = gpu.array(new Float32Array([0.2, 0.9, 0.4, 0.7]));
const order = gpu.argsort(scores, { descending: true }); // [1, 3, 2, 0]
const best = gpu.topk(scores, 2); // values [0.9, 0.7], indices [1, 3]
const passed = await gpu.filter(scores, scores.gt(0.5)); // [0.9, 0.7]
const hist = gpu.histogram(scores, { bins: 4, range: [0, 1] });
console.log(await order.read(), await best.indices.read(), await passed.read(), await hist.counts.read());
```

## Your own kernels

`gpu.kernel(wgsl)` reads the module's `@group @binding` declarations. `run` then binds resources by name: GpuArrays,
GPU buffers, textures, samplers, or plain objects for uniform structs, laid out by WGSL's alignment rules. `count`
threads round up to whole workgroups; `workgroups` or `indirect` (a GPU array of counts) dispatch directly.
`kernel.bind(resources)` keeps the bind groups for runs every frame: `set(name, value)` rewrites a uniform in place.

```ts
import { createCompute } from '@margoengine/compute';

using gpu = await createCompute();
const n = 1024;
const src = gpu.arange(0, n, 1, 'f32');
const dst = gpu.zeros(n);
const saxpy = gpu.kernel(/* wgsl */ `
  struct Params { a: f32, count: u32 }
  @group(0) @binding(0) var<storage, read> x: array<f32>;
  @group(0) @binding(1) var<storage, read_write> y: array<f32>;
  @group(0) @binding(2) var<uniform> params: Params;
  @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < params.count) { y[id.x] = params.a * x[id.x] + y[id.x]; }
  }`);
saxpy.run({ x: src, y: dst, params: { a: 2, count: n } }, { count: n });
console.log(await dst.read({ length: 4 })); // [0, 2, 4, 6]
```

## Linear algebra, FFT, convolution and random numbers

`@margoengine/compute/linalg` provides:

- `matmul(a, b)` with NumPy's rules (batched, broadcasting; transposed views are read without copies);
- `dot`, `outer` and `norm`.

`@margoengine/compute/fft` provides:

- `fft` and `ifft` for any length (Stockham for powers of two, Bluestein otherwise), along any axis, on
  `{ re, im }` arrays;
- `fft2`, `ifft2` and `fftfreq`.

`@margoengine/compute/signal` provides:

- `convolve` and `correlate` with NumPy's modes;
- `convolve2d` with SciPy's zero fill.

Each picks the direct or the FFT method by kernel size.

`@margoengine/compute/random` provides `new Random(gpu, { seed, stream })`, a Philox4x32-10 generator with
`uniform`, `normal`, `integers`, `bits`, `permutation` and `choice`. Its output is bit-identical on every device.

```ts
import { createCompute } from '@margoengine/compute';
import { matmul } from '@margoengine/compute/linalg';
import { fft } from '@margoengine/compute/fft';
import { convolve } from '@margoengine/compute/signal';
import { Random } from '@margoengine/compute/random';

using gpu = await createCompute();
const rng = new Random(gpu, { seed: 42 });
const x = rng.normal([256, 64]);
const gram = matmul(x.T, x); // 64 x 64
const { re, im } = fft(rng.uniform(1000)); // any length
const power = re.square().add(im.square());
const smooth = convolve(rng.normal(10000), gpu.array([0.25, 0.5, 0.25]), { mode: 'same' });
console.log(gram.shape, await power.max().item(), smooth.size);
```

## Sparse matrices and solvers

`@margoengine/compute/sparse` holds sparse matrices in compressed sparse row (CSR) form on the GPU, as SciPy does:

- `coo(gpu, { rows, cols, values, shape })` from coordinates in any order (duplicates are summed);
- `csr(gpu, { rowPtr, colIdx, values, shape })` from CSR arrays;
- `diags(gpu, values, offsets, shape)` for constant diagonals;
- `A.matvec(x)` or `spmv(A, x)`, `A.transpose()`, `A.diagonal()`, `A.toDense()`.

`cg(A, b)` (conjugate gradient, for symmetric positive definite A) and `bicgstab(A, b)` (any square A) solve A x = b
on the GPU. Their scalars stay in GPU memory between iterations, so the only read-back is the residual every
`checkEvery` iterations, so a converged solve reports a multiple of `checkEvery` iterations (or `maxIterations`).
Both resolve `{ x, iterations, residual, converged }` and do not reject when they run out of iterations. Arithmetic
is f32: a badly conditioned system may stop short of `tol` (`converged: false`), and a breakdown returns the last x
whose residual was finite.

| Option | Default | Meaning |
| --- | --- | --- |
| `tol` | `1e-5` | stop when the residual is at most `tol` times the norm of b (f32 arithmetic) |
| `atol` | `0` | or at most `atol` |
| `maxIterations` | 10 times the rows | most iterations |
| `preconditioner` | `'jacobi'` | `'jacobi'` (divide by the diagonal) or `'none'` |
| `checkEvery` | `32` | iterations between residual read-backs |
| `x0` | zeros | starting guess |
| `signal` | none | abandon the solve |

```ts
import { createCompute } from '@margoengine/compute';
import { cg, diags } from '@margoengine/compute/sparse';

using gpu = await createCompute();
const n = 1000;
using A = diags(gpu, [-1, 4, -1], [-1, 0, 1], [n, n]); // a diagonally dominant tridiagonal system
const b = gpu.ones(n);
const { x, iterations, converged } = await cg(A, b, { tol: 1e-6 });
console.log(converged, iterations, await x.max().item());
```

## Gradients

`@margoengine/compute/autodiff` differentiates element-wise expressions in reverse mode. `grad(output, [a, b])`
returns the gradient of `sum(output)` with respect to each array, with the arrays' shapes. `valueAndGrad` also
returns the sum. `{ seed }` weights the elements, giving `sum(output * seed)`.

- Gradients are lazy expressions over the same tree. Each one runs as one fused kernel that recomputes the forward
  values it needs.
- They flow through arithmetic, maths functions, `where`, `minimum`, `maximum` and `clip`, and through broadcasting
  (summed over the broadcast axes).
- They flow through views: a transpose or slice adds into the array it reads.
- Rounding, comparisons and bit operations have no gradient. `grad` by an integer array throws a TypeError.
- Matrix products and reductions inside the expression are not differentiated: they are already arrays when the
  expression reads them.

```ts
import { createCompute } from '@margoengine/compute';
import { valueAndGrad } from '@margoengine/compute/autodiff';

using gpu = await createCompute();
const x = gpu.array([0, 1, 2, 3]),
  y = gpu.array([1, 3, 5, 7]);
const w = gpu.array([0], { shape: [] }),
  b = gpu.array([0], { shape: [] });
for (let step = 0; step < 200; step++) {
  const { value, grads } = valueAndGrad(w.mul(x).add(b).sub(y).square(), [w, b]);
  // Gradient descent step: w -= 0.02 * dw (written back into w's buffer).
  w.write(await w.sub(grads[0].mul(0.02)).read());
  b.write(await b.sub(grads[1].mul(0.02)).read());
  for (const a of [value, ...grads]) a.dispose();
}
console.log(await w.item(), await b.item()); // close to 2 and 1
```

## Streams and frames

`@margoengine/compute/stream` works through data larger than GPU memory, chunk by chunk. It reads the next chunk
while the GPU works on the current one. It provides:

- `stream(gpu, source, work)`;
- `reduceStream`;
- `statsStream` (count, mean, variance, min and max in one pass);
- `histogramStream`;
- `chunks(array, size)`.

A source is any iterable or async iterable of TypedArrays.

`@margoengine/compute/frame` runs kernels every frame inside an engine's frame graph:

- `ComputeFrame.attach(engine)` attaches it; `frame.gpu` is a context on the engine's device;
- `frame.add(bound, run)` adds a job;
- jobs encode into the frame's own command encoder before the scene draws, so their buffers feed the same frame;
- `gpu.drawable(shape)` makes arrays the engine can draw from;
- `gpu.indirectArgs()` makes arrays that GPU culling can size dispatches with.

```ts
import { createCompute } from '@margoengine/compute';
import { chunks, statsStream } from '@margoengine/compute/stream';

using gpu = await createCompute();
const big = new Float32Array(10_000_000).map(() => Math.random());
const stats = await statsStream(gpu, chunks(big, 1 << 22));
console.log(stats.count, stats.mean, stats.variance);
```

```ts
import { Engine } from '@margoengine/core';
import { ComputeFrame } from '@margoengine/compute/frame';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const frame = ComputeFrame.attach(engine);
const positions = frame.gpu.drawable(4096 * 4);
const step = frame.gpu
  .kernel(/* wgsl */ `
    struct P { dt: f32 }
    @group(0) @binding(0) var<storage, read_write> positions: array<vec4f>;
    @group(0) @binding(1) var<uniform> p: P;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
      if (id.x < arrayLength(&positions)) { positions[id.x].y += p.dt; }
    }`)
  .bind({ positions, p: { dt: 0 } });
frame.add(step, (dt) => (step.set('p', { dt }), { count: 4096 }));
engine.start();
```

## CPU fallback

`createCompute()` uses WebGPU when the runtime has a usable adapter and otherwise falls back to the CPU, so code
written for the GPU also runs in Node and on machines without WebGPU. `gpu.backend` says which you got
(`'webgpu'` or `'cpu'`). `createCompute({ backend: 'cpu' })` always picks the CPU and `{ backend: 'webgpu' }` never
does (it rejects instead). The CPU code loads with `import()` only when it is used.

The CPU backend has the same API and the same results as the GPU path:

- Arrays, views, broadcasting and fused expressions run through an interpreter of the same expression tree. Every
  value is rounded to its element type as on the GPU (f32 rounding, 32-bit integer wrap).
- Reductions, scans and sorts give the same orders, counts and integer results. Float sums are accumulated in double
  precision, so they agree with the GPU to f32 rounding.
- `/linalg`, `/fft`, `/signal`, `/random` and `/stream` work unchanged. `Random` draws the same Philox stream, word
  for word.
- What needs a GPU throws a MargoError with code `unsupported`: your own WGSL (`gpu.kernel`, `gpu.map`, custom
  `{ combine, identity }` operators), `f16` arrays and `/frame`.

The browser test compares the two backends on the same inputs. The CPU runs on the calling thread and is much slower
than a GPU: the `compute` benchmark suite times both ([docs/benchmarking.md](../../docs/benchmarking.md#gpu-compute)).

```ts
import { createCompute } from '@margoengine/compute';

using gpu = await createCompute(); // WebGPU when available, otherwise the CPU
const x = gpu.array(new Float32Array([4, 1, 3, 2]));
console.log(gpu.backend, await gpu.sort(x).read(), await x.mean().item()); // 'cpu' in Node: [1, 2, 3, 4] 2.5
```

## Errors, waiting and profiling

Operations queue GPU work and return at once. Anything that waits (`read`, `item`, `done`, `profile`, `filter`) takes
an `AbortSignal`. When queued work failed on the GPU (a WGSL error in a kernel or expression, or out of memory), it
rejects with a `MargoError` whose `code` is `failed` and whose message includes the GPU's diagnostic. Argument
mistakes throw `TypeError` or `RangeError` at once, naming the fix, and every message links to
[margoengine.com/errors](https://margoengine.com/errors#compute).

`await gpu.profile(() => work())` resolves the GPU time of every pass, from timestamp queries.

## Options and defaults

| Option | Default | Meaning |
| --- | --- | --- |
| `createCompute({ engine })` | none | share the engine's WebGPU device |
| `createCompute({ device })` | none | share a GPUDevice you made |
| `createCompute({ backend })` | `'auto'` | `'auto'`, `'webgpu'` or `'cpu'` (see [CPU fallback](#cpu-fallback)) |
| `createCompute({ powerPreference })` | `'high-performance'` | adapter choice for a device of its own |
| `createCompute({ signal })` | none | abandon device creation |
| `array(data, { dtype })` | from the TypedArray, else `'f32'` | element type |
| `array(data, { shape })` | `[data.length]` | dimensions |
| reductions `{ axis, keepdims }` | every axis, `false` | where to reduce |
| `var` / `std` `{ ddof }` | `0` | delta degrees of freedom |
| `scan({ op, exclusive, axis })` | `'sum'`, `false`, flat | scan kind |
| `sort({ descending, bits })` | `false`, `32` | order; low key bits for small u32 keys |
| `take({ axis, mode })` | flat, `'clip'` | gather axis; out-of-range handling |
| `scatter({ op })` | `'set'` | `'add'`, `'min'` or `'max'` combine duplicates |
| `histogram({ bins, range })` | `64`, data range | binning |
| `convolve({ mode, method })` | `'full'`, `'auto'` | NumPy mode; direct or FFT |
| `new Random(gpu, { seed, stream })` | random seed, `0` | reproducibility |
| `ComputeFrame.attach(engine, { order })` | `-1000` | frame-graph order of the jobs |

Integer sums wrap at 32 bits. GPU float arithmetic is f32 (f16 for `f16` arrays). Results agree with NumPy's float64
to f32 rounding, not bit for bit.
