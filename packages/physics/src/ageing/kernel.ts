import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { ageingError } from './errors.js';

const DESCRIPTOR_BYTES = 32;
const WORK_WORDS = 6;
const MODEL_WORDS = 9;
const HISTORY_WORDS = 5;
const SURFACE_WORDS = 7;
const CLIMATE_WORDS = 10;
const MAX_BANK_BYTES = 0x7fff_ffff;

export interface AgeingKernelBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  readonly threads: 1 | 2 | 4;
  [Symbol.dispose](): void;
}

/** Material patch work performed by one native participant. */
export interface AgeingNativeWorkerWork {
  readonly patches: number;
  /** Patches for which both lanes applied the common exposure and thickness calculations. */
  readonly pairedPatches: number;
  readonly steel: number;
  readonly copper: number;
  readonly wood: number;
  readonly limestone: number;
}

/** Native work for the last accepted ageing step, with the caller at index zero. */
export interface AgeingNativeWorkCounts extends AgeingNativeWorkerWork {
  readonly threads: number;
  readonly workers: readonly AgeingNativeWorkerWork[];
}

export interface AgeingKernel {
  run(historyTrial: Region, surfaceTrial: Region, climate: Region, seconds: number): number;
  accept(): void;
  workCounts(): AgeingNativeWorkCounts | undefined;
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
      throw ageingError(`Ageing Wasm returned HTTP ${response.status}. Serve its optional kernel assets.`, 'failed');
    const module =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw ageingError('Load the material ageing Wasm assets on a SIMD-capable runtime.', 'failed', cause);
  }
}

export async function loadAgeingKernels(signal?: AbortSignal, threads: 1 | 2 | 4 = 1): Promise<AgeingKernelBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw ageingError('Choose 1, 2 or 4 native material ageing participants.', 'unsupported');
  const share = canShareMemory();
  if (threads !== 1 && !share)
    throw ageingError(
      'Use Node or an isolated browser worker for ageing helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './ageing-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    share
      ? compile(new URL(/* @vite-ignore */ './ageing-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Material ageing',
        phaseExport: 'ageing_thread_phase',
        phase: 'material exposure patches',
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
    throw ageingError('Start ageing helpers in Node or an isolated browser worker, or choose threads: 1.', code, cause);
  }
}

function stackTop({ byteOffset, byteLength }: Region) {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

function bank(memory: WebAssembly.Memory, region: Region, words: number): number {
  if (
    (region.memory ?? memory) !== memory ||
    region.type !== 'f64' ||
    region.layout !== 1 ||
    region.byteOffset % 8 !== 0 ||
    region.byteLength !== 8 * words
  )
    throw ageingError('Supply world-owned layout-1 f64 material model and trial banks with matching patch counts.');
  return region.byteOffset;
}

export function bindAgeingKernel(
  host: SolverHost,
  builds: AgeingKernelBuilds,
  modelRegion: Region,
  numPatches: number,
): AgeingKernel {
  try {
    return bind(host, builds, modelRegion, numPatches);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#ageing')) throw cause;
    throw ageingError('Bind compatible ageing Wasm and workers, or choose threads: 1.', 'failed', cause);
  }
}

function bind(
  host: SolverHost,
  { plain, shared, pool, threads }: AgeingKernelBuilds,
  modelRegion: Region,
  count: number,
): AgeingKernel {
  const sharedMemory =
    isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
  const module = sharedMemory ? shared : plain;
  if (!module)
    throw ageingError(
      pool
        ? 'Use shared world memory for ageing helpers, or choose threads: 1.'
        : 'Shared ageing Wasm is unavailable. Use plain world memory on this host.',
      'unsupported',
    );
  if (!Number.isInteger(count) || count < 1 || count * CLIMATE_WORDS * 8 > MAX_BANK_BYTES)
    throw ageingError('Choose a positive ageing patch count that fits the native arena.', 'unsupported');
  const model = bank(host.memory, modelRegion, MODEL_WORDS * count);
  const stack = host.allocate('ageing-native-stack', STACK_BYTES + 8, 'u8', 1);
  const job = host.allocate('ageing-native-job', DESCRIPTOR_BYTES + 8 * WORK_WORDS * threads, 'u8', 1).byteOffset;
  const work = job + DESCRIPTOR_BYTES;
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, __data_end: dataEnd, ageing_thread_phase } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof ageing_thread_phase !== 'function'
  )
    throw ageingError('Rebuild the slot-free ageing Wasm with its material phase export.', 'version');
  pointer.value = stackTop(stack);
  const phase = ageing_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('ageing-native-control', 4 * pool.controlWords, 'i32', 1).byteOffset;
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`ageing-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module, job, control, stackTops });
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  let ready = false;
  let hasAccepted = false;
  return {
    run(historyTrial, surfaceTrial, climateRegion, seconds) {
      ready = false;
      const history = bank(host.memory, historyTrial, HISTORY_WORDS * count);
      const surface = bank(host.memory, surfaceTrial, SURFACE_WORDS * count);
      const climate = bank(host.memory, climateRegion, CLIMATE_WORDS * count);
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, job, 6).set([model, history, surface, climate, count, work]);
      new Float64Array(buffer, job + 24, 1)[0] = seconds;
      const own = () => phase(job, 0, 0, threads);
      let status: number;
      try {
        status = pool ? pool.phase(0, own) : own();
      } catch (cause) {
        throw ageingError('Run matching ageing Wasm and helpers, or choose threads: 1.', 'failed', cause);
      }
      ready = status === 0;
      return status;
    },
    accept() {
      if (!ready) return;
      accepted.set(new Float64Array(host.memory.buffer, work, accepted.length));
      hasAccepted = true;
      ready = false;
    },
    workCounts() {
      if (!hasAccepted) return undefined;
      let patches = 0;
      let pairedPatches = 0;
      let steel = 0;
      let copper = 0;
      let wood = 0;
      let limestone = 0;
      const workers = Array.from({ length: threads }, (_, i) => {
        const at = i * WORK_WORDS;
        const row = {
          patches: accepted[at]!,
          pairedPatches: accepted[at + 1]!,
          steel: accepted[at + 2]!,
          copper: accepted[at + 3]!,
          wood: accepted[at + 4]!,
          limestone: accepted[at + 5]!,
        };
        patches += row.patches;
        pairedPatches += row.pairedPatches;
        steel += row.steel;
        copper += row.copper;
        wood += row.wood;
        limestone += row.limestone;
        return row;
      });
      return { threads, patches, pairedPatches, steel, copper, wood, limestone, workers };
    },
  };
}
