// Owner/lifetime fixture for @margoengine/compute. A compute context is the owner of every array, staging buffer and
// pipeline made through it: created on the engine's device (`createCompute({ engine })`), it must free all of them at
// `dispose()` and leave the engine's device, and the buffers other owners made on it, alone. Each entry is one public
// entry of the package doing real work on a context it owns (arrays, element-wise expressions, kernels, sorts, matmul,
// FFT, convolution, random streams, autodiff, sparse and graph matrices, shapes, neural-network layers, distance
// fields, quantized weights); nothing reads results back, so the fixture checks lifetimes, and the package's browser
// suites check the values. ComputeFrame is the one real engine plugin, with a per-frame job. Entries made on a
// disposed context must refuse (a use after dispose). The WebAssembly CPU context holds no GPU object, only a module
// instance, and is its own entry. Not entries: `/autotune` times kernels on a device and only reads (its result owns
// nothing); `/subgroups` and `/decomp` and `/onnx` hold nothing beyond the arrays of a context.
import { createCompute } from '../dist/index.js';
import { ownedByEngine, lifetimeFault } from '../../../tests/support/owner-shell.js';

const saxpy = /* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < arrayLength(&dst)) { dst[id.x] = 2.0 * src[id.x] + 1.0; }
}`;

export async function fixtures(load = (entry) => import(entry)) {
  const { matmul } = await load('../dist/linalg.js');
  const { fft } = await load('../dist/fft.js');
  const { convolve } = await load('../dist/signal.js');
  const { Random } = await load('../dist/random.js');
  const { valueAndGrad } = await load('../dist/autodiff.js');
  const { diags, spmv } = await load('../dist/sparse.js');
  const { graph } = await load('../dist/graph.js');
  const { concatenate, flip } = await load('../dist/shape.js');
  const { Linear, ReLU, Sequential, tensor } = await load('../dist/nn.js');
  const { distanceTransform } = await load('../dist/distance.js');
  const { createCpuWasm } = await load('../dist/cpu-wasm.js');
  const { ComputeFrame } = await load('../dist/frame.js');

  // One context per create, on the engine's device; its disposal is the owner's release, twice-safe.
  const onContext = (name, work) => ({
    name,
    async create({ engine, scene }) {
      const gpu = await createCompute({ engine });
      await work(gpu);
      return ownedByEngine(scene, name, () => gpu.dispose(), {
        check({ phase }) {
          if (phase !== 'disposed') return;
          let refused = false;
          try {
            gpu.array([1, 2, 3]);
          } catch {
            refused = true;
          }
          if (!refused) lifetimeFault('a disposed context refuses new arrays');
        },
      });
    },
  });
  return [
    onContext('createCompute', (gpu) => {
      const x = gpu.array(new Float32Array([3, 1, 4, 1, 5, 9, 2, 6])),
        y = gpu.arange(0, 8, 1, 'f32');
      const mixed = gpu.where(x.gt(2), x.add(y), y.mul(2)).sum();
      gpu.sort(x);
      gpu.argsort(x, { descending: true });
      gpu.cumsum(x);
      gpu.histogram(x, { bins: 4, range: [0, 10] });
      if (!mixed || x.disposed) lifetimeFault('arrays and expressions come back live');
    }),
    onContext('kernel', (gpu) => {
      const src = gpu.arange(0, 256, 1, 'f32'),
        dst = gpu.zeros(256);
      gpu.kernel(saxpy).bind({ src, dst }).run({ count: 256 });
    }),
    onContext('linalg', (gpu) => {
      matmul(
        gpu.array(new Float32Array(12).fill(1), { shape: [3, 4] }),
        gpu.array(new Float32Array(8).fill(2), { shape: [4, 2] }),
      );
    }),
    onContext('fft', (gpu) => {
      fft(gpu.array(new Float32Array(16).fill(1)));
    }),
    onContext('signal', (gpu) => {
      convolve(gpu.array(new Float32Array(64).fill(1)), gpu.array([0.25, 0.5, 0.25]), { mode: 'same' });
    }),
    onContext('random', (gpu) => {
      const rng = new Random(gpu, { seed: 7 });
      rng.normal(64);
      rng.uniform(64);
    }),
    onContext('autodiff', (gpu) => {
      const w = gpu.array([0.5], { shape: [] }),
        x = gpu.array([0, 1, 2, 3]);
      valueAndGrad(x.mul(w).square().sum(), [w]);
    }),
    onContext('sparse', (gpu) => {
      const matrix = diags(gpu, [-1, 2, -1], [-1, 0, 1], [4, 4]);
      spmv(matrix, gpu.ones(4));
      matrix.dispose();
    }),
    onContext('graph', (gpu) => {
      graph(gpu, { vertices: 3, sources: [0, 1], targets: [1, 2] }).dispose();
    }),
    onContext('shape', (gpu) => {
      const a = gpu.array([1, 2, 3]);
      flip(concatenate([a, a]));
    }),
    onContext('nn', (gpu) => {
      const model = new Sequential(new Linear(gpu, 4, 3), new ReLU());
      model.forward(tensor(gpu.ones([2, 4])));
    }),
    onContext('distance', (gpu) => {
      distanceTransform(
        gpu.array(
          Uint32Array.from({ length: 64 }, (_, i) => +(i === 27)),
          { shape: [8, 8] },
        ),
      );
    }),
    {
      // A WebAssembly instance and its linear memory, no GPU object; disposal drops the context's arrays.
      name: 'createCpuWasm',
      async create({ scene }) {
        const cpu = await createCpuWasm();
        cpu.array([1, 2, 3]);
        return ownedByEngine(scene, 'createCpuWasm', () => cpu.dispose());
      },
    },
    {
      // A frame owns its context and its jobs; the engine's device and a job's resources made elsewhere stay.
      name: 'ComputeFrame',
      create({ engine, scene }) {
        const frame = ComputeFrame.attach(engine);
        const src = frame.gpu.arange(0, 64, 1, 'f32'),
          dst = frame.gpu.zeros(64);
        const remove = frame.add(frame.gpu.kernel(saxpy).bind({ src, dst }), { count: 64 });
        return {
          plugin: frame,
          dispose() {
            frame.dispose();
            remove();
          },
          check({ phase }) {
            if (phase === 'disposed' && frame.jobs.length) lifetimeFault('a disposed frame keeps no jobs');
          },
        };
      },
    },
  ];
}
