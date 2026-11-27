import { createCompute } from '@margoengine/compute';
import { COUNT, BUCKET_SIZE } from './input.mjs';

export async function openCompute(forced, earlyCompatibility) {
  const signal = AbortSignal.timeout(18000);
  if (!earlyCompatibility && navigator.gpu) {
    try {
      const compute = await createCompute({ backend: 'webgpu', signal });
      return { compute, backend: 'webgpu' };
    } catch (error) {
      if (error.code !== 'unsupported') throw error;
    }
  }
  const opened = earlyCompatibility ? await earlyCompatibility : null;
  if (opened?.error) throw opened.error;
  const outcome = opened?.outcome ?? await (await import('./compatibility.js')).installCompatibility(forced, signal);
  const compute = await createCompute({ backend: 'webgpu', signal });
  return { compute, backend: outcome.installed ? 'webgl2' : 'webgpu' };
}

export async function sortKeys(compute, keys, signal) {
  let input, sorted;
  try {
    const start = performance.now();
    input = compute.array(keys);
    await compute.done({ signal });
    const uploaded = performance.now();
    const cpuStart = compute.device.dispatches?.cpu;
    sorted = compute.sort(input, { bits: 20 });
    await compute.done({ signal });
    const completed = performance.now();
    const cpuDispatches = cpuStart === undefined ? undefined : compute.device.dispatches.cpu - cpuStart;
    const result = await sorted.read({ signal });
    const read = performance.now();
    return { result, ms: completed - uploaded, upload: uploaded - start, readback: read - completed, cpuDispatches };
  } finally {
    sorted?.dispose();
    input?.dispose();
  }
}

export async function rankCuts(compute, histogram, signal) {
  let counts, scanned;
  try {
    counts = compute.array(histogram);
    scanned = compute.scan(counts);
    const ranks = await scanned.read({ signal });
    for (let i = 0; i < ranks.length; i++) {
      if (ranks[i] !== (i + 1) * BUCKET_SIZE) throw new Error('The rank scan did not match the verified counts.');
    }
    if (ranks.length * BUCKET_SIZE !== COUNT) throw new Error('Unexpected number of rank bins.');
    return [1, 2, 3, 4].map(quarter => ranks[quarter * ranks.length / 4 - 1]);
  } finally {
    scanned?.dispose();
    counts?.dispose();
  }
}
