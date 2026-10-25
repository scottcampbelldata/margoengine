// Margo's implementation of the data scenes in ./catalog.js: GPU compute tasks (@margoengine/compute) and figures
// (@margoengine/sciviz). Inputs are uploaded in create(), outside the timing; each task call queues one job and waits
// until the GPU has finished it, without reading the result back.
import { app, engineFor } from './margo.js';

const compute = () => import('@margoengine/compute');

/**
 * A compute task scene. `setup(gpu, data, params)` uploads the inputs and returns `{ run, check }`: `run()` queues one
 * job and returns (or resolves, for a solver) what it made, disposed after the GPU finishes; `check(result)` reads a little of the last result
 * back so engines can be compared on doing the same job.
 */
const task = (setup) => async (_canvas, data, marks, params) => {
  const s = performance.now(),
    { createCompute } = await compute(),
    gpu = await createCompute({ backend: params.backend });
  marks.createMs = +(performance.now() - s).toFixed(1);
  const b = performance.now(),
    job = await setup(gpu, data, params);
  await gpu.done();
  marks.buildMs = +(performance.now() - b).toFixed(1);
  let last = null;
  const free = (r) => {
    for (const a of r && typeof r.dispose === 'function' ? [r] : Object.values(r ?? {})) a?.dispose?.();
  };
  return {
    async task() {
      const result = await job.run();
      await gpu.done();
      free(last);
      last = result;
    },
    // The sum of the job's pass times from timestamp queries (gpu.profile), per call; none on the CPU backend.
    gpuTimes:
      gpu.backend === 'cpu'
        ? undefined
        : async (calls) => {
            const times = [];
            for (let k = 0; k < calls; k++) {
              let result = null;
              const passes = await gpu.profile(async () => {
                result = await job.run();
              });
              await gpu.done();
              free(result);
              if (passes.length) times.push(passes.reduce((sum, p) => sum + p.ms, 0));
            }
            return times;
          },
    output: async () => ({ n: params.n, check: await job.check(last) }),
    info: () => ({ note: `backend ${gpu.backend}` }),
  };
};

const round = (x) => +x.toPrecision(6);

export const builders = {
  'compute-sort': task(async (gpu, { values }) => {
    const x = gpu.array(values);
    return {
      run: () => gpu.sort(x),
      check: async (r) => {
        const v = await r.read();
        let ordered = true;
        for (let i = 1; i < v.length && ordered; i++) ordered = v[i - 1] <= v[i];
        return { ordered, first: round(v[0]), last: round(v[v.length - 1]) };
      },
    };
  }),
  'compute-scan': task(async (gpu, { values }) => {
    const x = gpu.array(values);
    return { run: () => gpu.cumsum(x), check: async (r) => ({ last: round((await r.read())[values.length - 1]) }) };
  }),
  'compute-reduce': task(async (gpu, { values }) => {
    const x = gpu.array(values);
    return { run: () => x.sum(), check: async (r) => ({ sum: round(await r.item()) }) };
  }),
  'compute-histogram': task(async (gpu, { values, bins, range }) => {
    const x = gpu.array(values);
    return {
      run: () => gpu.histogram(x, { bins, range }),
      check: async (r) => ({ counted: (await r.counts.read()).reduce((a, b) => a + b, 0) }),
    };
  }),
  'compute-random': task(async (gpu, { seed }, { n }) => {
    const { Random } = await import('@margoengine/compute/random'),
      rng = new Random(gpu, { seed });
    return { run: () => rng.normal(n), check: async (r) => ({ mean: round(await r.mean().item()) }) };
  }),
  'compute-matmul': task(async (gpu, { a, b }, { n }) => {
    const { matmul } = await import('@margoengine/compute/linalg'),
      A = gpu.array(a, { shape: [n, n] }),
      B = gpu.array(b, { shape: [n, n] });
    return { run: () => matmul(A, B), check: async (r) => ({ sum: round(await r.sum().item()) }) };
  }),
  'compute-fft': task(async (gpu, { values }) => {
    const { fft } = await import('@margoengine/compute/fft'),
      x = gpu.array(values);
    return { run: () => fft(x), check: async (r) => ({ dc: round((await r.re.read({ length: 1 }))[0]) }) };
  }),
  'compute-spmv': task(async (gpu, { rows, cols, values, size }) => {
    const { coo } = await import('@margoengine/compute/sparse'),
      A = coo(gpu, { rows, cols, values, shape: [size, size] }),
      x = gpu.ones(size);
    return { run: () => A.matvec(x), check: async (r) => ({ sum: round(await r.sum().item()) }) };
  }),
  'compute-cg': task(async (gpu, { rows, cols, values, size }) => {
    const { coo, cg } = await import('@margoengine/compute/sparse'),
      A = coo(gpu, { rows, cols, values, shape: [size, size] }),
      b = gpu.ones(size);
    return {
      run: () => cg(A, b, { tol: 0, maxIterations: 100, checkEvery: 100 }),
      check: async (r) => ({ iterations: r.iterations, residual: round(r.residual) }),
    };
  }),

  'viz-scatter': figure(async (fig, { x, y, z }) => {
    await fig.scatter({ x, y, z, color: z }, { colormap: 'viridis' });
  }),
  'viz-surface': figure(async (fig, { z }, { n }) => {
    fig.surface(z, { nx: n, colormap: 'aurora', contours: 12 });
  }),
  'viz-volume': figure(async (fig, { values }, { n }) => {
    fig.volume(values, {
      dims: [n, n, n],
      range: [0, 1],
      colormap: 'ember',
      opacity: [
        [0, 0],
        [0.3, 0.05],
        [1, 0.9],
      ],
    });
  }),
};

/** A figure scene: an engine with the catalog camera, a sciviz figure with axes, and the layer `add` makes. */
function figure(add) {
  return async (canvas, data, marks, params) => {
    const engine = await engineFor(canvas, data.camera, undefined, marks),
      s = performance.now(),
      { Figure } = await import('@margoengine/sciviz'),
      fig = Figure.attach(engine, { pointBudget: Math.max(2_000_000, params.n) });
    engine.scene.background = fig.theme.background;
    await add(fig, data, params);
    await fig.ready();
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note: 'sciviz figure (layer passes not counted)' });
  };
}
