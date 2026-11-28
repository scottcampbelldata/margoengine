import { MargoError } from '@margoengine/math/errors';
import { hullError } from './errors.js';
import { openSlammingBatch, type SlammingJob, type SlammingReply, type SlammingResult } from './slamming-native.js';
import {
  slamMeshHash,
  type HullSlammingOptions,
  type HullSlammingTable,
  type HullSlammingWorkerWork,
} from './slamming-table.js';
import { slamGeometry, slamQuadratureNodes, validateSlamInputs } from './slamming.js';
import { SEA_WATER, type HullMesh } from './wetted.js';

async function load(signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = new URL(/* @vite-ignore */ './hull-slamming-kernel.wasm?no-inline', import.meta.url);
  if (url.protocol === 'file:') {
    url.search = '';
    const name = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
    return await WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw hullError(
      'failed',
      `Hull slamming Wasm returned HTTP ${response.status}. Serve the optional slamming asset.`,
    );
  return await WebAssembly.compile(await response.arrayBuffer());
}

interface WorkerEndpoint {
  request(job: SlammingJob, resolve: (reply: SlammingReply) => void, reject: (reason: unknown) => void): void;
  terminate(): void | Promise<number>;
}

type NodeWorker = {
  postMessage(message: SlammingJob): void;
  once(event: 'message', receive: (reply: SlammingReply) => void): void;
  once(event: 'error' | 'messageerror', receive: (error: Error) => void): void;
  once(event: 'exit', receive: (code: number) => void): void;
  terminate(): Promise<number>;
};

async function workerEndpoint(): Promise<WorkerEndpoint> {
  if (typeof Worker === 'function') {
    const worker = new Worker(new URL(/* @vite-ignore */ './hull-slamming-thread.js', import.meta.url), {
      type: 'module',
    });
    return {
      request(job, resolve, reject) {
        worker.addEventListener('message', ({ data }) => resolve(data), { once: true });
        worker.addEventListener('error', reject, { once: true });
        worker.addEventListener('messageerror', reject, { once: true });
        worker.postMessage(job);
      },
      terminate: () => worker.terminate(),
    };
  }
  const name = 'node:worker_threads';
  const { Worker: NodeSlammingWorker } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ name)) as {
    Worker: new (url: URL, options: { execArgv: string[] }) => NodeWorker;
  };
  const worker = new NodeSlammingWorker(new URL(/* @vite-ignore */ './hull-slamming-thread.js', import.meta.url), {
    execArgv: [],
  });
  return {
    request(job, resolve, reject) {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('messageerror', reject);
      worker.once('exit', (code) => reject(`Hull slamming worker exited with code ${code}.`));
      worker.postMessage(job);
    },
    terminate: () => worker.terminate(),
  };
}

function geometryError() {
  return hullError(
    'state',
    'Use a representable hull breadth, level spacing and water density to keep the slamming profile finite.',
  );
}

async function remote(job: SlammingJob, signal: AbortSignal): Promise<SlammingResult> {
  signal.throwIfAborted();
  const worker = await workerEndpoint();
  try {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      const reply = await new Promise<SlammingReply>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        worker.request(job, resolve, reject);
      });
      signal.throwIfAborted();
      if ('invalid' in reply) throw geometryError();
      if ('error' in reply)
        throw Object.assign(
          hullError('failed', 'Run the bundled hull slamming worker in a Wasm SIMD runtime, or use threads: 1.'),
          { cause: reply.error },
        );
      return reply;
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  } finally {
    await worker.terminate();
  }
}

async function local(job: SlammingJob, signal: AbortSignal): Promise<SlammingResult> {
  signal.throwIfAborted();
  const native = openSlammingBatch(job);
  try {
    for (const [index, section] of job.sections.entries()) {
      // Keep the caller responsive without queueing a separate task for every station.
      if ((index & 7) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      if (!native.add(section)) throw geometryError();
    }
    return native.result();
  } finally {
    native.close();
  }
}

function combined(workers: readonly HullSlammingWorkerWork[]): HullSlammingWorkerWork {
  const work = { stations: 0, samples: 0, bisections: 0, quadraturePairs: 0, profileComparisons: 0 };
  for (const row of workers) {
    work.stations += row.stations;
    work.samples += row.samples;
    work.bisections += row.bisections;
    work.quadraturePairs += row.quadraturePairs;
    work.profileComparisons += row.profileComparisons;
  }
  return work;
}

export async function bake(
  mesh: HullMesh,
  { density = SEA_WATER, stations = 24, levels = 48, threads: requested = 1, signal }: HullSlammingOptions,
): Promise<HullSlammingTable> {
  signal?.throwIfAborted();
  if (requested !== 1 && requested !== 2 && requested !== 4)
    throw hullError('state', 'Choose 1, 2 or 4 hull slamming threads.');
  validateSlamInputs(mesh, density, stations, levels);
  const sections = slamGeometry(mesh, stations, levels);
  const meshHash = slamMeshHash(mesh);
  const nodes = slamQuadratureNodes();
  const threads = Math.max(1, Math.min(requested, sections.length));
  const controller = new AbortController();
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let pending: Promise<SlammingResult>[] = [];
  try {
    const module = await load(signal);
    const jobs = Array.from({ length: threads }, (_, part) => ({
      module,
      density,
      nodes,
      sections: sections.slice(
        Math.floor((part * sections.length) / threads),
        Math.floor(((part + 1) * sections.length) / threads),
      ),
    }));
    const helpers = jobs.slice(1).map((job) => remote(job, active));
    pending = [local(jobs[0]!, active), ...helpers];
    const results = await Promise.all(pending);
    active.throwIfAborted();
    const workers = Object.freeze(results.map(({ work }) => Object.freeze(work)));
    return Object.freeze({
      density,
      stations,
      levels,
      meshHash,
      profiles: Object.freeze(results.flatMap(({ profiles }) => profiles.map((profile) => Object.freeze(profile)))),
      work: Object.freeze({ ...combined(workers), threads, workers }),
    });
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      hullError('failed', 'Serve the hull slamming assets in a Wasm SIMD runtime, or use scalar slamStations.'),
      { cause },
    );
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
  }
}
