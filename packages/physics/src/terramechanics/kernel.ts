import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';
import { soilError } from './errors.js';

export interface Builds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface NativeSoil {
  resistive(
    coefficients: number,
    samples: number,
    count: number,
    horizontalX: number,
    horizontalZ: number,
    forces: number,
  ): void;
  resistive_soil_thread_phase(job: number, stage: number, part: number, parts: number): number;
  resistive_soil_reduce(job: number): number;
  stamp(
    patch: number,
    areas: number,
    peak: number,
    change: number,
    dust: number,
    rim: number,
    pressure: number,
    heights: number,
    floor: number,
    floorGrid: number,
    budget: number,
    work: number,
    faces: number,
    nx: number,
    nz: number,
    dx: number,
    dz: number,
    originX: number,
    originZ: number,
    trackRelief: number,
    cycle: number,
    cycleActive: number,
  ): number;
  unload_soil(cycle: number, cycleActive: number, change: number): void;
  repose(
    areas: number,
    change: number,
    pressure: number,
    heights: number,
    faces: number,
    work: number,
    nx: number,
    nz: number,
    dx: number,
    dz: number,
    trackRelief: number,
    pendingFaces: number,
    pendingDelta: number,
    floor: number,
    floorGrid: number,
  ): number;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const node = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ node);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw soilError(
        `Terramechanics kernel returned HTTP ${response.status}. Use a host serving the optional Wasm assets.`,
        'failed',
      );
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw soilError('Serve the terramechanics Wasm assets and use a SIMD-capable runtime.', 'failed', cause);
  }
}

export async function loadSoil(signal?: AbortSignal, threads = 1): Promise<Builds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw soilError('Choose 1, 2 or 4 resistive-soil native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw soilError('Use Node or an isolated browser worker for resistive soil, or choose threads: 1.', 'unsupported');
  let pool: NativePhasePool | undefined;
  function close() {
    signal?.removeEventListener('abort', close);
    pool?.close();
  }
  try {
    const [plain, shared] = await Promise.all([
      threads === 1
        ? compile(new URL(/* @vite-ignore */ './terramechanics-kernel.wasm?no-inline', import.meta.url), signal)
        : undefined,
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './terramechanics-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    if (threads > 1) {
      pool = await createNativePhasePool(threads, {
        subject: 'Resistive soil',
        phaseExport: 'resistive_soil_thread_phase',
        phase: 'granular strip forces',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    if (cause instanceof MargoError && cause.message.endsWith('#soil')) throw cause;
    throw soilError(
      'Serve the terramechanics Wasm and use a compatible worker, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

export function bindSoil(host: SolverHost, builds: Builds): NativeSoil {
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw soilError(
      builds.pool
        ? 'Use shared world memory for resistive-soil helpers, or choose threads: 1.'
        : 'The shared soil kernel is unavailable. Create a plain-memory world.',
      'unsupported',
    );
  const stack = host.allocate('soil-stack', STACK_BYTES, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  if (
    !(exports.__stack_pointer instanceof WebAssembly.Global) ||
    typeof exports.resistive !== 'function' ||
    typeof exports.resistive_soil_thread_phase !== 'function' ||
    typeof exports.resistive_soil_reduce !== 'function' ||
    typeof exports.stamp !== 'function' ||
    typeof exports.unload_soil !== 'function' ||
    typeof exports.repose !== 'function'
  )
    throw soilError('Unexpected terramechanics kernel ABI. Run the build for both native variants.', 'failed');
  exports.__stack_pointer.value = stack.byteOffset + stack.byteLength;
  return exports as unknown as NativeSoil;
}

const JOB_BYTES = 32;
const RECEIPT_WORDS = 3;

/** Strip force work performed by a native participant. */
export interface ResistiveSoilWorkerWork {
  /** Physical submerged moving samples. */
  readonly samples: number;
  /** Physical samples computed with another live SIMD lane. */
  readonly pairedSamples: number;
  /** Executed SIMD pairs, including a zero-padded lane at odd body ends. */
  readonly simdPairs: number;
}

/** Work in the last accepted resistive force batch, with the caller at worker index zero. */
export interface ResistiveSoilWorkCounts extends ResistiveSoilWorkerWork {
  readonly threads: number;
  readonly workers: readonly ResistiveSoilWorkerWork[];
}

export interface ResistiveBatch {
  run(coefficients: number, samples: number, ranges: number, forces: number, bodies: number, count: number): number;
  workCounts(): ResistiveSoilWorkCounts | undefined;
}

export function bindResistiveBatch(host: SolverHost, builds: Builds, sampleCapacity: number): ResistiveBatch {
  const native = bindSoil(host, builds);
  const pool = builds.pool;
  const threads = pool?.count ?? 1;
  const job = host.allocate('resistive-soil-job', JOB_BYTES + 8 * RECEIPT_WORDS * threads, 'u8', 1).byteOffset;
  const values = host.allocate('resistive-soil-products', sampleCapacity * 6 * 8, 'f64', 1).byteOffset;
  const work = job + JOB_BYTES;
  if (pool) {
    const control = host.allocate('resistive-soil-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, part) => {
      const stack = host.allocate('resistive-soil-helper-stack-' + part, STACK_BYTES + 8, 'u8', 1);
      return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    });
    try {
      pool.init({ memory: host.memory, module: builds.shared!, job, control: control.byteOffset, stackTops });
    } catch (cause) {
      throw soilError('Use matching resistive-soil Wasm and helper assets, or choose threads: 1.', 'failed', cause);
    }
  }
  const accepted = new Float64Array(threads * RECEIPT_WORDS);
  let ready = false;
  return {
    run(coefficients, samples, ranges, forces, bodies, count) {
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, job, 8).set([coefficients, samples, ranges, values, forces, bodies, count, work]);
      const own = () => native.resistive_soil_thread_phase(job, 0, 0, threads);
      try {
        const status = (pool ? pool.phase(0, own) : own()) || native.resistive_soil_reduce(job);
        if (status === 0) {
          accepted.set(new Float64Array(buffer, work, accepted.length));
          ready = true;
        }
        return status;
      } catch (cause) {
        throw soilError('Run matching resistive-soil helpers and Wasm, or choose threads: 1.', 'failed', cause);
      }
    },
    workCounts() {
      if (!ready) return undefined;
      const totals = { samples: 0, pairedSamples: 0, simdPairs: 0 };
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * RECEIPT_WORDS;
        const samples = accepted[at]!;
        const pairedSamples = accepted[at + 1]!;
        const simdPairs = accepted[at + 2]!;
        totals.samples += samples;
        totals.pairedSamples += pairedSamples;
        totals.simdPairs += simdPairs;
        return { samples, pairedSamples, simdPairs };
      });
      return { threads, ...totals, workers };
    },
  };
}
