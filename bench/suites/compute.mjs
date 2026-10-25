// GPU compute throughput (@margoengine/compute): sort, prefix sum, sum, histogram, random normals, matrix product and
// FFT at several sizes, as task scenes (bench/scenes/catalog.js computeScenes; Margo's in bench/scenes/margo-data.js).
// taskMs is one job from queue to GPU finish with the inputs already in GPU memory (wall clock, so it includes the
// browser's wait for the GPU to report back); taskGpuMs is the sum of the job's GPU pass times from timestamp queries.
// `rate` is the job's throughput on the GPU (GB/s, GFLOP/s or Mkeys/s from the scene's work(), over taskGpuMs), and
// `wallRate` the same over taskMs. taskGpuMs alone decides validity: Chromium reports finished work either about
// 0.3 ms or about 3 ms after it ends (docs/benchmarking.md "GPU compute"), so taskMs is bimodal for jobs near that
// edge and its spread says nothing about Margo. Other engines join through engine-bench.
import { sceneCases } from '../lib/browser.mjs';
import { SCENES } from '../scenes/catalog.js';

/** The browser cases of `suite` (task scenes), each with its scene's throughput metrics `rate` and `wallRate`. */
export const withRate = (suite) => (ctx) =>
  sceneCases(suite, {
    primary: ['taskGpuMs'],
    keep: ['taskMs', 'taskGpuMs', 'coldMs', 'createMs', 'buildMs'],
  })(ctx).map((c) => {
    const work = SCENES[c.scene].work(c.params),
      per = (ms) => +(work.amount / (ms / 1000) / work.scale).toFixed(2);
    return {
      ...c,
      metrics: {
        ...c.metrics,
        rate: { unit: work.unit, better: 'higher' },
        wallRate: { unit: work.unit, better: 'higher' },
      },
      async run(runCtx) {
        const r = await c.run(runCtx);
        if (r.values?.taskGpuMs > 0) r.values.rate = per(r.values.taskGpuMs);
        if (r.values?.taskMs > 0) r.values.wallRate = per(r.values.taskMs);
        return r;
      },
    };
  });

export default {
  name: 'compute',
  title: 'GPU compute: sort, scan, reduce, histogram, random, matmul, FFT',
  uses: 'gpu',
  cases: withRate('compute'),
};
