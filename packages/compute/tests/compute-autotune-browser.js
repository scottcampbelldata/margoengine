import { speedEnabled } from './speed-phase.mjs';
// Real-GPU checks of @margoengine/compute/autotune: every candidate compiles and gives the right answer, the chosen size
// is the one measured fastest, and the result comes back from the cache and a store. tests/autotune.test.js covers the
// choosing with a scripted GPU.
import { createCompute } from '@margoengine/compute';
import { autotune, tuneCompute } from '@margoengine/compute/autotune';

const checks = [];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const check = async (name, run) => {
  try {
    await run();
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
  checks.push(name);
};

window.runAutotuneTests = async () => {
  const gpu = await createCompute({ backend: 'webgpu' });
  const n = 2_000_000, // 62,500 workgroups at the smallest size, under the 65,535 of one dimension.
    x = gpu.arange(0, n, 1, 'f32'),
    y = gpu.zeros(n),
    source = (size) => /* wgsl */ `
      @group(0) @binding(0) var<storage, read> x: array<f32>;
      @group(0) @binding(1) var<storage, read_write> y: array<f32>;
      @compute @workgroup_size(${size}) fn main(@builtin(global_invocation_id) id: vec3u) {
        if (id.x < ${n}u) { y[id.x] = 2.0 * x[id.x] + 1.0; }
      }`,
    run = (kernel) => kernel.run({ x, y }, { count: n }),
    entries = new Map(),
    store = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => void entries.set(key, value) };
  let measured = [];
  try {
    await check('every permitted SAXPY candidate computes all original 2M values', async () => {
      for (const threads of [64, 128, 256, 512, 1024]) {
        if (
          threads > gpu.device.limits.maxComputeInvocationsPerWorkgroup ||
          threads > gpu.device.limits.maxComputeWorkgroupSizeX
        )
          continue;
        y.write(new Float32Array(n));
        run(gpu.kernel(source(threads)));
        const out = await y.read();
        assert(
          out.every((v, i) => v === 2 * i + 1),
          `SAXPY at ${threads}`,
        );
      }
    });
    await check('every original two-dimensional candidate computes the complete grid', async () => {
      const side = 512,
        grid = gpu.zeros(side * side);
      try {
        for (const size of [
          [8, 8],
          [16, 16],
          [32, 8],
          [64, 1],
        ]) {
          grid.write(new Float32Array(side * side));
          const kernel = gpu.kernel(`
            @group(0) @binding(0) var<storage, read_write> grid: array<f32>;
            @compute @workgroup_size(${size}) fn main(@builtin(global_invocation_id) id: vec3u) {
              grid[id.y * ${side}u + id.x] = f32(id.x + id.y);
            }`);
          kernel.run({ grid }, { workgroups: [side / size[0], side / size[1], 1] });
          const out = await grid.read();
          assert(
            out.every((v, i) => v === (i % side) + Math.floor(i / side)),
            `grid at ${size}`,
          );
        }
      } finally {
        grid.dispose();
      }
    });
    if (speedEnabled()) {
      await check('autotune measures every size this GPU allows and picks the fastest', async () => {
        const { workgroupSize, kernel, timings, cached } = await autotune(gpu, { name: 'saxpy', source, run, store });
        measured = timings.map((t) => ({ size: t.workgroupSize[0], ms: t.ms }));
        assert(!cached, 'cached on the first call');
        const adapter = await navigator.gpu.requestAdapter(),
          widest = Math.min(1024, adapter.limits.maxComputeInvocationsPerWorkgroup);
        assert(Math.max(...timings.map((t) => t.workgroupSize[0])) === widest, `${timings.length} sizes`);
        assert(
          timings.every((t) => t.ms > 0 && Number.isFinite(t.ms)),
          JSON.stringify(timings),
        );
        const best = Math.min(...timings.map((t) => t.ms));
        assert(timings.find((t) => t.workgroupSize === workgroupSize).ms === best, 'not the fastest');
        assert(kernel.workgroupSize[0] === workgroupSize[0], 'kernel compiled at another size');
        y.write(new Float32Array(n));
        run(kernel);
        const out = await y.read({ length: 4 });
        assert(out[3] === 7, `result ${out[3]}`);
      });
      await check('the second call and a new context with the store run nothing', async () => {
        let runs = 0;
        const counting = (kernel) => (runs++, run(kernel));
        const again = await autotune(gpu, { name: 'saxpy', source, run: counting, store });
        assert(again.cached && runs === 0, 'measured again');
        const other = await createCompute({ backend: 'webgpu' });
        try {
          const next = await autotune(other, { name: 'saxpy', source, run: counting, store });
          assert(next.cached && runs === 0, 'a store did not carry it over');
          assert(next.workgroupSize.join() === again.workgroupSize.join(), 'a different size');
        } finally {
          other.dispose();
        }
      });
      await check('two-dimensional candidates run', async () => {
        const side = 512,
          grid = gpu.zeros(side * side),
          kernelOf = (size) => /* wgsl */ `
            @group(0) @binding(0) var<storage, read_write> grid: array<f32>;
            @compute @workgroup_size(${size}) fn main(@builtin(global_invocation_id) id: vec3u) {
              grid[id.y * ${side}u + id.x] = f32(id.x + id.y);
            }`;
        const { workgroupSize, kernel } = await autotune(gpu, {
          name: 'grid',
          source: kernelOf,
          candidates: [
            [8, 8],
            [16, 16],
            [32, 8],
            [64, 1],
          ],
          trials: 3,
          run: (k, [wx, wy]) => k.run({ grid }, { workgroups: [side / wx, side / wy, 1] }),
        });
        kernel.run({ grid }, { workgroups: [side / workgroupSize[0], side / workgroupSize[1], 1] });
        const out = await grid.read();
        assert(out[side * 3 + 5] === 8 && out[side * side - 1] === 2 * side - 2, 'wrong grid');
        grid.dispose();
      });
    }
    let own;
    await check("every size of the context's own kernels gives the same integers and order", async () => {
      const count = 300_001,
        data = Int32Array.from({ length: count }, (_, i) => (Math.imul(i, 2654435761) >> 12) % 1000),
        keys = Uint32Array.from({ length: count }, (_, i) => Math.imul(i, 2654435761) >>> 0),
        sorted = keys.slice().sort(),
        running = data.reduce((list, v, i) => ((list[i] = (list[i - 1] ?? 0) + v), list), new Int32Array(count)),
        total = running[count - 1];
      for (const threads of [64, 128, 256, 512, 1024]) {
        const other = await createCompute({
          backend: 'webgpu',
          tuned: { reduce: threads, scan: threads, sort: threads },
        });
        try {
          assert((await other.array(data).sum().item()) === total, `reduce at ${threads}`);
          const scanned = await other.cumsum(other.array(data)).read();
          assert(
            scanned.every((v, i) => v === running[i]),
            `scan at ${threads}`,
          );
          const order = await other.sort(other.array(keys)).read();
          assert(
            order.every((v, i) => v === sorted[i]),
            `sort at ${threads}`,
          );
          const paired = other.sortByKey(other.array(keys), other.arange(0, count, 1, 'u32')),
            ids = await paired.values.read();
          assert(
            ids.every((id, i) => keys[id] === sorted[i]),
            `sortByKey at ${threads}`,
          );
        } finally {
          other.dispose();
        }
      }
    });
    if (speedEnabled()) {
      await check('tuneCompute measures the kernels on this GPU and uses the winners', async () => {
        const other = await createCompute({ backend: 'webgpu' });
        try {
          const result = await tuneCompute(other, { count: 1 << 24 });
          own = { tuned: result.tuned, timings: result.timings };
          for (const name of ['reduce', 'scan', 'sort']) {
            const times = result.timings[name],
              best = Math.min(...times.map((t) => t.ms));
            assert(times.length >= 3 && best > 0, name);
            assert(
              times.find((t) => t.workgroupSize[0] === result.tuned[name]).ms === best,
              `${name} is not the fastest`,
            );
          }
          assert(other.tuned === result.tuned || other.tuned.sort === result.tuned.sort, 'table not in use');
          assert((await other.array(new Uint32Array(5000).fill(3)).sum().item()) === 15000, 'sum after tuning');
        } finally {
          other.dispose();
        }
      });
    }
    return { checks, measured, own };
  } finally {
    gpu.dispose();
  }
};
