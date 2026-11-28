import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { accretionError } from './errors.js';

const JOB_BYTES = 56;
const WORK_WORDS = 2;
const MAX_BANK_BYTES = 0x7fff_ffff;
const BANKS = ['mass', 'density', 'heat', 'phase', 'flux', 'budget'] as const;
const INPUT_BANKS = ['mass', 'phase', 'budget'] as const;

export interface AccretionKernelBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  readonly threads: 1 | 2 | 4;
  [Symbol.dispose](): void;
}

export type AccretionBanks = Readonly<Record<(typeof BANKS)[number], Region>>;

/** Annuli evaluated by one native participant in the accepted density, heating and phase pass. */
export interface AccretionWorkerWork {
  readonly annuli: number;
  /** Annuli with both SIMD lanes active, excluding an unpaired final annulus. */
  readonly pairedAnnuli: number;
}

/** Latest accepted native work. The caller is worker zero. */
export interface AccretionWorkCounts extends AccretionWorkerWork {
  readonly threads: number;
  readonly workers: readonly AccretionWorkerWork[];
}

export interface AccretionKernel {
  run(dt: number, feed: number): void;
  accept(): void;
  workCounts(): AccretionWorkCounts | undefined;
}

type Phase = (job: number, stage: number, part: number, parts: number) => number;

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
      throw accretionError(
        `Accretion Wasm returned HTTP ${response.status}. Serve its optional kernel assets.`,
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
    throw accretionError('Load the accretion Wasm assets on a SIMD-capable runtime.', 'failed', cause);
  }
}

export async function loadAccretionKernels(
  signal?: AbortSignal,
  threads: 1 | 2 | 4 = 1,
): Promise<AccretionKernelBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw accretionError('Choose 1, 2 or 4 native accretion participants.', 'unsupported');
  const share = canShareMemory();
  if (threads !== 1 && !share)
    throw accretionError(
      'Use Node or an isolated browser worker for accretion helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './accretion-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    share
      ? compile(new URL(/* @vite-ignore */ './accretion-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  let pool: NativePhasePool | undefined;
  function close() {
    signal?.removeEventListener('abort', close);
    pool?.close();
  }
  try {
    if (threads !== 1) {
      pool = await createNativePhasePool(threads, {
        subject: 'Accretion disk',
        phaseExport: 'accretion_thread_phase',
        phase: 'density, heating and orbital phase',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, threads, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    const code = cause instanceof MargoError ? cause.code : 'failed';
    throw accretionError(
      'Start accretion helpers in Node or an isolated browser worker, or choose threads: 1.',
      code,
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region) {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

function bank(memory: WebAssembly.Memory, region: Region, words: number): void {
  if (
    (region.memory ?? memory) !== memory ||
    region.type !== 'f64' ||
    region.layout !== 1 ||
    region.byteOffset % 8 !== 0 ||
    region.byteLength !== 8 * words
  )
    throw accretionError('Supply the world-owned layout-1 f64 disk grid and state banks with matching annulus counts.');
}

export function bindAccretionDisk(
  host: SolverHost,
  builds: AccretionKernelBuilds,
  n: number,
  config: Region,
  accepted: AccretionBanks,
): AccretionKernel {
  try {
    return bind(host, builds, n, config, accepted);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#accretion')) throw cause;
    throw accretionError('Bind compatible accretion Wasm and workers, or choose threads: 1.', 'failed', cause);
  }
}

function bind(
  host: SolverHost,
  { plain, shared, pool, threads }: AccretionKernelBuilds,
  n: number,
  config: Region,
  accepted: AccretionBanks,
): AccretionKernel {
  const memory = host.memory;
  const sharedMemory =
    isShared(memory) || Object.prototype.toString.call(memory.buffer) === '[object SharedArrayBuffer]';
  const module = sharedMemory ? shared : plain;
  if (!module)
    throw accretionError(
      pool
        ? 'Use shared world memory for accretion helpers, or choose threads: 1.'
        : 'Shared accretion Wasm is unavailable. Use plain world memory.',
      'unsupported',
    );
  if (!Number.isInteger(n) || n < 1 || (5 * n + 1) * 8 > MAX_BANK_BYTES)
    throw accretionError('Choose a positive accretion annulus count that fits the native arena.', 'unsupported');

  const lengths = { mass: n, density: n, heat: n, phase: n, flux: n + 1, budget: 5 };
  bank(memory, config, 5 * n + 1);
  for (const name of BANKS) bank(memory, accepted[name], lengths[name]);
  const scratch = host.allocate('accretion-thomas-scratch', 16 * n, 'f64', 1).byteOffset;
  const reserve = (name: keyof AccretionBanks) => host.allocate('accretion-trial-' + name, 8 * lengths[name], 'f64', 1);
  const trial = {
    mass: reserve('mass'),
    density: reserve('density'),
    heat: reserve('heat'),
    phase: reserve('phase'),
    flux: reserve('flux'),
    budget: reserve('budget'),
  };
  const stack = host.allocate('accretion-native-stack', STACK_BYTES + 8, 'u8', 1);
  const job = host.allocate('accretion-native-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1).byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  const {
    __stack_pointer: pointer,
    __data_end: dataEnd,
    accretion_prepare,
    accretion_thread_phase,
    accretion_finish,
  } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof accretion_prepare !== 'function' ||
    typeof accretion_thread_phase !== 'function' ||
    typeof accretion_finish !== 'function'
  )
    throw accretionError(
      'Rebuild the slot-free accretion Wasm with its transport and annulus phase exports.',
      'version',
    );
  pointer.value = stackTop(stack);
  const prepare = accretion_prepare as (job: number) => number;
  const phase = accretion_thread_phase as Phase;
  const finish = accretion_finish as (job: number) => number;
  if (pool) {
    const control = host.allocate('accretion-native-control', 4 * pool.controlWords, 'i32', 1).byteOffset;
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`accretion-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory, module, job, control, stackTops });
  }
  new Uint32Array(memory.buffer, job, 10).set([
    n,
    config.byteOffset,
    scratch,
    ...BANKS.map((name) => trial[name].byteOffset),
    work,
  ]);

  const words = (region: Region) => new Float64Array(memory.buffer, region.byteOffset, region.byteLength / 8);
  const receipt = new Float64Array(WORK_WORDS * threads);
  let ready = false;
  let hasAccepted = false;
  return {
    run(dt, feed) {
      ready = false;
      for (const name of INPUT_BANKS) words(trial[name]).set(words(accepted[name]));
      new Float64Array(memory.buffer, job + 40, 2).set([dt, feed]);
      const own = () => phase(job, 0, 0, threads);
      let status: number;
      try {
        status = prepare(job) || (pool ? pool.phase(0, own) : own()) || finish(job);
      } catch (cause) {
        throw accretionError('Run matching accretion Wasm and helpers, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0)
        throw accretionError(
          'Accretion transport or heating exceeds the numeric range. Reduce mass, flux or step duration.',
        );
      ready = true;
    },
    accept() {
      if (!ready) return;
      for (const name of BANKS) words(accepted[name]).set(words(trial[name]));
      receipt.set(new Float64Array(memory.buffer, work, receipt.length));
      hasAccepted = true;
      ready = false;
    },
    workCounts() {
      if (!hasAccepted) return undefined;
      let annuli = 0;
      let pairedAnnuli = 0;
      const workers = Array.from({ length: threads }, (_, i) => {
        const at = i * WORK_WORDS;
        const row = { annuli: receipt[at]!, pairedAnnuli: receipt[at + 1]! };
        annuli += row.annuli;
        pairedAnnuli += row.pairedAnnuli;
        return row;
      });
      return { threads, annuli, pairedAnnuli, workers };
    },
  };
}
