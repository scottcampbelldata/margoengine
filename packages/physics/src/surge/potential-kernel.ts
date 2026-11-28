import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';
import { surgeError } from './errors.js';

const PAGE = 65_536;
const JOB = 16;
const CONTROL = 160;
const WORK = 256;
const WET_COUNT = 352;
const WORK_WORDS = 5;

/** Successful grid operations performed by one native surge participant. */
export interface SurgePotentialWorkerWork {
  /** Inverse-barometer terms. */
  readonly pressureCells: number;
  /** The sum of Sun and Moon tidal potentials, counted per cell. */
  readonly tideCells: number;
  /** Tidal cells computed in f64x2 lanes, excluding the scalar tail. */
  readonly pairedTides: number;
  readonly synthesizedCells: number;
  /** Final potential heights computed in f64x2 lanes. */
  readonly pairedSynthesis: number;
}

/** Work for the last accepted potential calculation, with the caller in worker slot zero. */
export interface SurgePotentialWorkCounts extends SurgePotentialWorkerWork {
  readonly threads: number;
  readonly wetCells: number;
  readonly workers: readonly SurgePotentialWorkerWork[];
}

interface Parameters {
  readonly hasPressure: boolean;
  readonly reference?: number;
  readonly rhoG: number;
  readonly gravity: number;
  readonly love: number;
  readonly grow: number;
}

export interface SurgePotentialBuild {
  bind(count: number, positions?: Float64Array): SurgePotentialKernel;
  [Symbol.dispose](): void;
}

export interface SurgePotentialKernel {
  apply(
    parts: Float64Array,
    wet: Uint8Array,
    bodies: Float64Array | undefined,
    params: Parameters,
    potential: Float64Array,
  ): void;
  workCounts(): SurgePotentialWorkCounts;
}

function failed(message: string, cause?: unknown): MargoError {
  const result = surgeError('failed', message);
  return cause === undefined ? result : Object.assign(result, { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './surge-potential-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './surge-potential-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw failed(`The surge potential kernel returned HTTP ${response.status}. Serve its shipped Wasm asset.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw failed('Load the shipped surge potential asset in a Wasm SIMD runtime, or use the scalar solver.', cause);
  }
}

function receipt(words: Uint32Array, at: number): SurgePotentialWorkerWork {
  return {
    pressureCells: words[at]!,
    tideCells: words[at + 1]!,
    pairedTides: words[at + 2]!,
    synthesizedCells: words[at + 3]!,
    pairedSynthesis: words[at + 4]!,
  };
}

function bindPotential(
  module: WebAssembly.Module,
  threads: number,
  pool: NativePhasePool | undefined,
  active: () => void,
  cells: number,
  positions: Float64Array | undefined,
): SurgePotentialKernel {
  if (!(Number.isSafeInteger(cells) && cells > 0) || (positions && positions.length !== 3 * cells))
    throw surgeError('unsupported', 'Initialize a surge grid with one Earth-fixed xyz vector per tidal cell.');
  let end = (threads + 1) * PAGE;
  function reserve(words: number): number {
    const at = end;
    end += words * Float64Array.BYTES_PER_ELEMENT;
    return at;
  }
  const partsAt = reserve(2 * cells);
  const positionsAt = positions ? reserve(3 * cells) : 0;
  const potentialAt = reserve(cells);
  const wetAt = end;
  const pages = Math.ceil((end + cells) / PAGE);
  if (pages > MAX_MEMORY_PAGES) throw surgeError('unsupported', 'Use fewer surge cells to fit native forcing memory.');
  const memory = new WebAssembly.Memory({ initial: pages, maximum: MAX_MEMORY_PAGES, shared: threads > 1 });
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  const { __stack_pointer: stack, surge_potential_thread_phase: phase, surge_potential_reduce: reduce } = exports;
  if (!(stack instanceof WebAssembly.Global) || typeof phase !== 'function' || typeof reduce !== 'function')
    throw failed('Serve the matching stateless surge asset with its native potential and wet-mean phases.');
  const runPhase = phase as (job: number, stage: number, part: number, parts: number) => number;
  stack.value = 2 * PAGE;
  const buffer = memory.buffer;
  const f64 = (at: number, length: number): Float64Array => new Float64Array(buffer, at, length);
  const candidateParts = f64(partsAt, 2 * cells);
  const candidatePotential = f64(potentialAt, cells);
  const wetRows = new Uint8Array(buffer, wetAt, cells);
  if (positions) f64(positionsAt, positions.length).set(positions);
  const descriptor = new Uint32Array(buffer, JOB, 8);
  descriptor.set([partsAt, wetAt, positionsAt, potentialAt, WORK, WET_COUNT, cells]);
  const bodyValues = f64(JOB + 32, 6);
  const input = f64(JOB + 80, 5);
  const work = new Uint32Array(buffer, WORK, WORK_WORDS * threads);
  const wetCount = new Uint32Array(buffer, WET_COUNT, 1);
  const accepted = new Uint32Array(work.length);
  let acceptedWet = 0;
  pool?.init({
    memory,
    module,
    job: JOB,
    control: CONTROL,
    stackTops: Array.from({ length: threads - 1 }, (_, i) => (i + 3) * PAGE),
  });
  return {
    apply(parts, wet, bodies, params, potential) {
      active();
      const { hasPressure, reference, rhoG, gravity, love, grow } = params;
      if (
        parts.length !== candidateParts.length ||
        wet.length !== cells ||
        potential.length !== cells ||
        (bodies && (!positions || bodies.length !== 6)) ||
        ![rhoG, gravity, love].every((value) => value > 0 && Number.isFinite(value)) ||
        !Number.isFinite(grow) ||
        (reference !== undefined && !Number.isFinite(reference))
      )
        throw surgeError(
          'unsupported',
          'Supply grid-sized pressure and wetness with finite surge settings and six f64 celestial words.',
        );
      candidateParts.set(parts);
      wetRows.set(wet);
      if (bodies) bodyValues.set(bodies);
      descriptor[7] = Number(hasPressure) | (bodies ? 2 : 0) | (reference === undefined ? 0 : 4);
      input.set([rhoG, gravity, love, grow, reference ?? 0]);
      work.fill(0);
      function run(stage: number): number {
        const leader = () => runPhase(JOB, stage, 0, threads);
        return pool ? pool.phase(stage, leader) : leader();
      }
      let status: number;
      try {
        status = (bodies ? run(0) : 0) || (reduce(JOB) as number) || run(1);
      } catch (cause) {
        throw failed(
          'Use matching surge helpers and Wasm in Node or an isolated browser worker, or choose threads: 1.',
          cause,
        );
      }
      if (status === 2)
        throw failed(
          'The surge potential or wet-cell mean exceeds finite range. Check pressures and the Earth-fixed Sun and Moon vectors.',
        );
      if (status !== 0) throw failed('Serve matching surge potential phase and geometry layouts.');
      parts.set(candidateParts);
      potential.set(candidatePotential);
      accepted.set(work);
      acceptedWet = wetCount[0]!;
    },
    workCounts() {
      const totals = new Uint32Array(WORK_WORDS);
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        for (let col = 0; col < WORK_WORDS; col++) totals[col]! += accepted[at + col]!;
        return receipt(accepted, at);
      });
      return { ...receipt(totals, 0), threads, wetCells: acceptedWet, workers };
    },
  };
}

export async function loadSurgePotential({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}): Promise<SurgePotentialBuild> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw surgeError('unsupported', 'Choose 1, 2 or 4 surge potential participants.');
  const module = await loadModule(threads > 1, signal);
  signal?.throwIfAborted();
  let pool: NativePhasePool | undefined;
  let closed = false;
  let bound = false;
  function active() {
    if (closed) throw surgeError('disposed', 'Load a new surge solver after disposing this one.');
  }
  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    pool?.close();
  }
  try {
    if (threads > 1) {
      pool = await createNativePhasePool(threads, {
        subject: 'Surge potential',
        phaseExport: 'surge_potential_thread_phase',
        phase: 'tides and inverse barometer',
        signal,
      });
    }
    signal?.addEventListener('abort', close, { once: true });
    signal?.throwIfAborted();
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw failed('Start surge helpers in Node or an isolated browser worker, or choose threads: 1.', cause);
  }
  return {
    bind(count, positions) {
      active();
      if (bound) throw surgeError('attached', 'Load a fresh surge solver for another grid.');
      try {
        const kernel = bindPotential(module, threads, pool, active, count, positions);
        bound = true;
        return kernel;
      } catch (cause) {
        close();
        if (cause instanceof MargoError && cause.message.endsWith('#storm-surge')) throw cause;
        throw failed('Use a smaller surge grid and matching Wasm to allocate its forcing buffers.', cause);
      }
    },
    [Symbol.dispose]: close,
  };
}
