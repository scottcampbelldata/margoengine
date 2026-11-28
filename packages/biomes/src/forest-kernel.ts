import { MargoError } from '@margoengine/math/errors';
import type { Region, SolverHost } from '@margoengine/physics/world';
import { forestError } from './forest-errors.js';
import { createGrowthWorkers, type GrowthWorkerPool } from './growth-worker-pool.js';
import { loadPhysicsWorld, world } from './physics-world.js';

const DESCRIPTOR_BYTES = 32;
const WORK_WORDS = 5;
const POPULATION_WORDS = 7;
const MAX_BANK_BYTES = 0x7fff_ffff;

export interface ForestKernelBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: GrowthWorkerPool;
  readonly threads: 1 | 2 | 4;
  [Symbol.dispose](): void;
}

/** Native crown comparisons performed by one participant. */
export interface ForestShadeWorkerWork {
  /** Output tree rows, including zeros for dead trees. */
  readonly trees: number;
  /** Live positive-radius trees that queried the neighbourhood. */
  readonly liveQueries: number;
  /** Candidate linked-list entries examined before Q16 saturation. */
  readonly candidateVisits: number;
  /** Overlapping candidates contributing a geometric shade term. */
  readonly overlaps: number;
  /** Real overlapping crowns evaluated in paired f64x2 lanes. */
  readonly pairedOverlaps: number;
}

/** Geometric shade work for the latest accepted year. The caller has index zero. */
export interface ForestShadeWorkCounts extends ForestShadeWorkerWork {
  readonly threads: number;
  readonly workers: readonly ForestShadeWorkerWork[];
}

export interface ForestShadeKernel {
  run(population: Region, count: number, cell: number): Int32Array;
  accept(): void;
  workCounts(): ForestShadeWorkCounts | undefined;
}

type Phase = (job: number, part: number, parts: number) => number;

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      const module = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw forestError(`Forest Wasm returned HTTP ${response.status}. Serve its optional kernel assets.`, 'failed');
    const module =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw forestError('Load the forest Wasm assets on a SIMD-capable runtime.', 'failed', cause);
  }
}

export async function loadForestKernels(signal?: AbortSignal, threads: 1 | 2 | 4 = 1): Promise<ForestKernelBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw forestError('Choose 1, 2 or 4 native forest participants.', 'unsupported');
  const { canShareMemory } = await loadPhysicsWorld();
  signal?.throwIfAborted();
  const share = canShareMemory();
  if (threads !== 1 && !share)
    throw forestError(
      'Use Node or an isolated browser worker for forest helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './forest-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    share
      ? compile(new URL(/* @vite-ignore */ './forest-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
    signal?.throwIfAborted();
    const code = cause instanceof MargoError ? cause.code : 'failed';
    throw forestError('Start forest helpers in Node or an isolated browser worker, or choose threads: 1.', code, cause);
  }
}

function stackTop({ byteOffset, byteLength }: Region) {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindForestShade(
  host: SolverHost,
  builds: ForestKernelBuilds,
  capacity: number,
  tableSize: number,
): ForestShadeKernel {
  try {
    return bind(host, builds, capacity, tableSize);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#forest')) throw cause;
    throw forestError('Bind compatible forest Wasm and workers, or choose threads: 1.', 'failed', cause);
  }
}

function bind(
  host: SolverHost,
  { plain, shared, pool, threads }: ForestKernelBuilds,
  capacity: number,
  tableSize: number,
): ForestShadeKernel {
  const sharedMemory =
    world().isShared(host.memory) ||
    Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
  const module = sharedMemory ? shared : plain;
  if (!module)
    throw forestError(
      pool
        ? 'Use shared world memory for forest helpers, or choose threads: 1.'
        : 'Shared forest Wasm is unavailable. Use plain world memory.',
      'unsupported',
    );
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity * POPULATION_WORDS * 4 > MAX_BANK_BYTES ||
    !Number.isInteger(tableSize) ||
    tableSize < 2 * capacity ||
    (tableSize & (tableSize - 1)) !== 0 ||
    4 * (capacity + 3 * tableSize) > MAX_BANK_BYTES
  )
    throw forestError('Choose a forest capacity whose population and neighbour table fit Wasm memory.', 'unsupported');

  const stackSize = world().STACK_BYTES + 8;
  const stack = host.allocate('forest-kernel-stack', stackSize, 'u8', 1);
  const job = host.allocate('forest-shade-job', DESCRIPTOR_BYTES + 8 * WORK_WORDS * threads, 'u8', 1).byteOffset;
  const work = job + DESCRIPTOR_BYTES;
  const shade = host.allocate('forest-crown-shade', 4 * capacity, 'i32', 1).byteOffset;
  const scratch = host.allocate('forest-neighbour-table', 4 * (capacity + 3 * tableSize), 'i32', 1).byteOffset;
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, __data_end: dataEnd, forest_prepare, forest_shade_phase } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof forest_prepare !== 'function' ||
    typeof forest_shade_phase !== 'function'
  )
    throw forestError('Rebuild the slot-free forest Wasm with its table and shade phase exports.', 'version');
  pointer.value = stackTop(stack);
  const prepare = forest_prepare as (job: number) => number;
  const phase = forest_shade_phase as Phase;
  if (pool) {
    const control = host.allocate('forest-shade-control', 4 * pool.controlWords, 'i32', 1).byteOffset;
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`forest-helper-stack-${i}`, stackSize, 'u8', 1)),
    );
    pool.bind({ memory: host.memory, module, job, control, phaseExport: 'forest_shade_phase' }, stackTops);
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  let ready = false;
  let hasAccepted = false;
  return {
    run(population, count, cell) {
      ready = false;
      if (
        (population.memory ?? host.memory) !== host.memory ||
        population.type !== 'i32' ||
        population.byteOffset % 4 !== 0 ||
        population.byteLength !== 4 * POPULATION_WORDS * capacity ||
        !Number.isInteger(count) ||
        count < 0 ||
        count > capacity ||
        !Number.isInteger(cell) ||
        cell < 1 ||
        cell > 0xffff_ffff
      )
        throw forestError('Supply the world-owned i32 population layout, a valid tree count and positive cell width.');
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, job, 8).set([
        population.byteOffset,
        shade,
        scratch,
        capacity,
        count,
        tableSize,
        cell,
        work,
      ]);
      if (prepare(job) !== 0)
        throw forestError('Choose a forest count and cell width supported by the neighbour table.');
      const own = () => phase(job, 0, threads);
      let status: number;
      try {
        status = pool ? pool.phase(own) : own();
      } catch (cause) {
        throw forestError('Run matching forest Wasm and helpers, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0) throw forestError('Use the bound forest population and compatible native helpers.');
      ready = true;
      return new Int32Array(buffer, shade, count);
    },
    accept() {
      if (!ready) return;
      accepted.set(new Float64Array(host.memory.buffer, work, accepted.length));
      hasAccepted = true;
      ready = false;
    },
    workCounts() {
      if (!hasAccepted) return undefined;
      let trees = 0;
      let liveQueries = 0;
      let candidateVisits = 0;
      let overlaps = 0;
      let pairedOverlaps = 0;
      const workers = Array.from({ length: threads }, (_, i) => {
        const at = i * WORK_WORDS;
        const row = {
          trees: accepted[at]!,
          liveQueries: accepted[at + 1]!,
          candidateVisits: accepted[at + 2]!,
          overlaps: accepted[at + 3]!,
          pairedOverlaps: accepted[at + 4]!,
        };
        trees += row.trees;
        liveQueries += row.liveQueries;
        candidateVisits += row.candidateVisits;
        overlaps += row.overlaps;
        pairedOverlaps += row.pairedOverlaps;
        return row;
      });
      return { threads, trees, liveQueries, candidateVisits, overlaps, pairedOverlaps, workers };
    },
  };
}
