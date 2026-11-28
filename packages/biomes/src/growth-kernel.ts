import { MargoError } from '@margoengine/math/errors';
import type { Region, SolverHost } from '@margoengine/physics/world';
import { growthError } from './growth-errors.js';
import { createGrowthWorkers, type GrowthWorkerPool } from './growth-worker-pool.js';
import { loadPhysicsWorld, world } from './physics-world.js';

const SOURCE_BYTES = 24;
const JOB_BYTES = 40;
const WORK_WORDS = 4;
const MAX_SLICE_BYTES = 0x7fff_ffff;

export interface GrowthKernelBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: GrowthWorkerPool;
  readonly threads: 1 | 2 | 4;
  [Symbol.dispose](): void;
}

/** A voxel-space source in the shared obstacle-then-node order. */
export interface GrowthShadowSource {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly amount: number;
}

/** Useful shadow additions made by one native participant. */
export interface GrowthShadowWorkerWork {
  /** Number of source pyramids intersecting this participant's rows. */
  readonly sources: number;
  /** Number of X rows visited, summed across the clipped source pyramids. */
  readonly rows: number;
  /** Voxel additions, including overlapping source contributions. */
  readonly additions: number;
  /** Voxel additions made by paired f64x2 lanes. */
  readonly pairedAdditions: number;
}

/** Accepted season's shadow work. Both caller and helpers are included. */
export interface GrowthShadowWorkCounts extends GrowthShadowWorkerWork {
  readonly threads: number;
  /** Input pyramids, each counted once regardless of how many workers it intersects. */
  readonly sources: number;
  readonly workers: readonly GrowthShadowWorkerWork[];
}

export interface GrowthShadows {
  run(target: Region, sources: readonly GrowthShadowSource[]): void;
  accept(): void;
  workCounts(): GrowthShadowWorkCounts | undefined;
}

type Phase = (job: number, part: number, parts: number) => number;

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      const compiled = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return compiled;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw growthError(
        `Plant growth Wasm returned HTTP ${response.status}. Serve the optional growth kernel assets.`,
        'failed',
      );
    const module =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw growthError('Load the plant growth Wasm assets on a SIMD-capable runtime.', 'failed', cause);
  }
}

export async function loadGrowthKernel(signal?: AbortSignal, threads: 1 | 2 | 4 = 1): Promise<GrowthKernelBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw growthError('Choose 1, 2 or 4 plant growth native participants.', 'unsupported');
  const { canShareMemory } = await loadPhysicsWorld();
  signal?.throwIfAborted();
  const share = canShareMemory();
  if (threads > 1 && !share)
    throw growthError(
      'Use Node or an isolated browser worker for growth helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './growth-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    share
      ? compile(new URL(/* @vite-ignore */ './growth-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  let pool: GrowthWorkerPool | undefined;
  function close() {
    signal?.removeEventListener('abort', close);
    pool?.close();
  }
  try {
    if (threads !== 1) {
      pool = await createGrowthWorkers(threads, signal);
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, threads, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    throw cause;
  }
}

function stackTop({ byteOffset, byteLength }: Region) {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindGrowthShadows(
  host: SolverHost,
  builds: GrowthKernelBuilds,
  maximumSources: number,
  dimensions: readonly [number, number, number],
  depth: number,
  transmission: number,
): GrowthShadows {
  try {
    return bind(host, builds, maximumSources, dimensions, depth, transmission);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#plant-growth')) throw cause;
    throw growthError('Bind compatible plant growth Wasm and workers, or choose threads: 1.', 'failed', cause);
  }
}

function bind(
  host: SolverHost,
  { plain, shared, threads, pool }: GrowthKernelBuilds,
  maximumSources: number,
  [nx, ny, nz]: readonly [number, number, number],
  depth: number,
  transmission: number,
): GrowthShadows {
  const sharedMemory =
    world().isShared(host.memory) ||
    Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
  const module = sharedMemory ? shared : plain;
  if (!module)
    throw growthError(
      pool
        ? 'Use shared world memory for plant growth helpers, or choose threads: 1.'
        : 'Shared plant growth Wasm is unavailable. Use plain world memory on this host.',
      'unsupported',
    );
  const targetBytes = 8 * nx * ny * nz;
  if (
    !Number.isSafeInteger(targetBytes) ||
    targetBytes > MAX_SLICE_BYTES ||
    !Number.isSafeInteger(maximumSources) ||
    maximumSources < 0 ||
    maximumSources * SOURCE_BYTES > MAX_SLICE_BYTES
  )
    throw growthError(
      'Use a smaller voxel domain or a shorter productive lifetime to fit native shadow work.',
      'unsupported',
    );

  const stackSize = world().STACK_BYTES + 8;
  const stack = host.allocate('plant-growth-stack', stackSize, 'u8', 1);
  const job = host.allocate('plant-growth-shadow-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1).byteOffset;
  const work = job + JOB_BYTES;
  const sourceBank = host.allocate('plant-growth-source-bank', SOURCE_BYTES * maximumSources, 'u8', 1).byteOffset;
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, __data_end: dataEnd, growth_shadow_phase } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof growth_shadow_phase !== 'function'
  )
    throw growthError('Rebuild the slot-free plant growth Wasm with its shadow phase export.', 'version');
  pointer.value = stackTop(stack);
  const phase = growth_shadow_phase as Phase;
  if (pool) {
    const control = host.allocate('plant-growth-shadow-control', 4 * pool.controlWords, 'i32', 1).byteOffset;
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`plant-growth-helper-stack-${i}`, stackSize, 'u8', 1)),
    );
    pool.bind({ memory: host.memory, module, job, control }, stackTops);
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  let pendingSources: number | undefined;
  let acceptedSources: number | undefined;
  return {
    run(target, sources) {
      pendingSources = undefined;
      if (
        (target.memory ?? host.memory) !== host.memory ||
        target.type !== 'f64' ||
        target.byteOffset % 8 !== 0 ||
        target.byteLength !== targetBytes ||
        sources.length > maximumSources
      )
        throw growthError('Use the world-owned f64 shadow grid and reserve capacity for its active sources.');
      const buffer = host.memory.buffer;
      const packed = new DataView(buffer, sourceBank, SOURCE_BYTES * sources.length);
      for (const [i, { x, y, z, amount }] of sources.entries()) {
        if (
          !Number.isInteger(x) ||
          x < 0 ||
          x >= nx ||
          !Number.isInteger(y) ||
          y < 0 ||
          y >= ny ||
          !Number.isInteger(z) ||
          z < 0 ||
          z >= nz ||
          !Number.isFinite(amount) ||
          amount < 0 ||
          amount > 1
        )
          throw growthError('Give each shadow source an in-grid voxel and a finite strength from zero to one.');
        const at = SOURCE_BYTES * i;
        packed.setInt32(at, x, true);
        packed.setInt32(at + 4, y, true);
        packed.setInt32(at + 8, z, true);
        packed.setFloat64(at + 16, amount, true);
      }
      new Uint32Array(buffer, job, 8).set([target.byteOffset, sourceBank, nx, ny, nz, sources.length, depth, work]);
      new Float64Array(buffer, job + 32, 1)[0] = transmission;
      const own = () => phase(job, 0, threads);
      let status: number;
      try {
        status = pool ? pool.phase(own) : own();
      } catch (cause) {
        throw growthError('Run matching plant growth Wasm and helpers, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0) throw growthError('Supply representable voxel dimensions and valid shadow sources.');
      pendingSources = sources.length;
    },
    accept() {
      if (pendingSources === undefined) return;
      accepted.set(new Float64Array(host.memory.buffer, work, accepted.length));
      acceptedSources = pendingSources;
      pendingSources = undefined;
    },
    workCounts() {
      if (acceptedSources === undefined) return undefined;
      let rows = 0;
      let additions = 0;
      let pairedAdditions = 0;
      const workers = Array.from({ length: threads }, (_, i) => {
        const at = i * WORK_WORDS;
        const row = {
          sources: accepted[at]!,
          rows: accepted[at + 1]!,
          additions: accepted[at + 2]!,
          pairedAdditions: accepted[at + 3]!,
        };
        rows += row.rows;
        additions += row.additions;
        pairedAdditions += row.pairedAdditions;
        return row;
      });
      return { threads, sources: acceptedSources, rows, additions, pairedAdditions, workers };
    },
  };
}
