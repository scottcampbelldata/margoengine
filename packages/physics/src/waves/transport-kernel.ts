import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';
import { waveError } from './errors.js';

const PAGE = 65_536;
const JOB = 16;
const CONTROL = 112;
const WORK = 208;
const WORK_WORDS = 5;

/** Transport work performed by one native participant. */
export interface WaveTransportWorkerWork {
  /** Face fluxes with water on at least one side. */
  readonly fluxes: number;
  /** Wet-face fluxes evaluated in f64x2 lanes, counted per occupied lane. */
  readonly pairedFluxes: number;
  /** Fluxes that used a full wet ULTIMATE QUICKEST stencil. */
  readonly quickestFluxes: number;
  /** Updated wet-cell spectral bins. */
  readonly updates: number;
  /** Updated wet-cell bins computed in f64x2 lanes. */
  readonly pairedUpdates: number;
}

/** Spatial transport within an accepted interval; the caller is worker slot zero. */
export interface WaveTransportWorkCounts extends WaveTransportWorkerWork {
  readonly threads: number;
  readonly axisSweeps: number;
  readonly workers: readonly WaveTransportWorkerWork[];
}

interface Geometry {
  readonly nx: number;
  readonly nz: number;
  readonly nf: number;
  readonly nd: number;
  readonly spacing: number;
  readonly depth: Float64Array;
  readonly groupVelocity: Float64Array;
  readonly directionX: Float64Array;
  readonly directionZ: Float64Array;
  readonly swell?: Float64Array;
  readonly wrapX: boolean;
  readonly wrapZ: boolean;
}

export interface WaveTransportBuild {
  bind(geometry: Geometry): WaveTransportKernel;
  [Symbol.dispose](): void;
}

export interface WaveTransportKernel {
  advect(words: Float64Array, axis: 'x' | 'z', dt: number): void;
  resetWork(): void;
  workCounts(): WaveTransportWorkCounts;
}

function error(code: MargoErrorCode, message: string, cause?: unknown): MargoError {
  const result = waveError(code, message);
  return cause === undefined ? result : Object.assign(result, { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './wave-transport-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './wave-transport-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw error('failed', `Wave transport returned HTTP ${response.status}. Serve its matching Wasm asset.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw error(
      'failed',
      'Load the matching wave transport asset in a Wasm SIMD runtime, or use the scalar solver.',
      cause,
    );
  }
}

function counter(words: Float64Array, at: number): WaveTransportWorkerWork {
  return {
    fluxes: words[at]!,
    pairedFluxes: words[at + 1]!,
    quickestFluxes: words[at + 2]!,
    updates: words[at + 3]!,
    pairedUpdates: words[at + 4]!,
  };
}

function bindTransport(
  module: WebAssembly.Module,
  threads: number,
  pool: NativePhasePool | undefined,
  active: () => void,
  grid: Geometry,
): WaveTransportKernel {
  const { nx, nz, nf, nd, spacing, depth, groupVelocity, directionX, directionZ, swell, wrapX, wrapZ } = grid;
  const cells = nx * nz;
  const bins = nf * nd;
  const size = cells * bins;
  if (
    ![nx, nz, nf, nd, size].every((value) => Number.isSafeInteger(value) && value > 0) ||
    !(spacing > 0 && Number.isFinite(spacing)) ||
    depth.length !== cells ||
    groupVelocity.length !== cells * nf ||
    directionX.length !== nd ||
    directionZ.length !== nd ||
    (swell && swell.length !== bins)
  )
    throw error('unsupported', 'Initialize one depth, dispersion and directional spectrum per valid wave cell.');
  let end = (threads + 1) * PAGE;
  function reserve(words: number): number {
    const start = end;
    end += words * Float64Array.BYTES_PER_ELEMENT;
    return start;
  }
  const sourceAt = reserve(size);
  const targetAt = reserve(size);
  const depthAt = reserve(depth.length);
  const groupAt = reserve(groupVelocity.length);
  const directionXAt = reserve(directionX.length);
  const directionZAt = reserve(directionZ.length);
  const swellAt = swell ? reserve(swell.length) : 0;
  const pages = Math.ceil(end / PAGE);
  if (pages > MAX_MEMORY_PAGES)
    throw error('unsupported', 'Use fewer grid cells, frequencies or directions to fit native transport memory.');
  const memory = new WebAssembly.Memory({ initial: pages, maximum: MAX_MEMORY_PAGES, shared: threads > 1 });
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  const { __stack_pointer: stack, wave_transport_thread_phase: phase } = exports;
  if (!(stack instanceof WebAssembly.Global) || typeof phase !== 'function')
    throw error('failed', 'Serve the matching stateless wave transport asset with its native flux phase.');
  stack.value = 2 * PAGE;
  const buffer = memory.buffer;
  const f64 = (at: number, length: number): Float64Array => new Float64Array(buffer, at, length);
  const source = f64(sourceAt, size);
  const target = f64(targetAt, size);
  f64(depthAt, depth.length).set(depth);
  f64(groupAt, groupVelocity.length).set(groupVelocity);
  f64(directionXAt, nd).set(directionX);
  f64(directionZAt, nd).set(directionZ);
  if (swell) f64(swellAt, bins).set(swell);
  const job = new Uint32Array(buffer, JOB, 16);
  job.set([
    sourceAt,
    targetAt,
    depthAt,
    groupAt,
    directionXAt,
    directionZAt,
    swellAt,
    WORK,
    nx,
    nz,
    nf,
    nd,
    0,
    Number(wrapX),
    Number(wrapZ),
  ]);
  const interval = f64(JOB + 64, 2);
  interval[1] = spacing;
  const work = f64(WORK, WORK_WORDS * threads);
  const accepted = new Float64Array(work.length);
  let axisSweeps = 0;
  pool?.init({
    memory,
    module,
    job: JOB,
    control: CONTROL,
    stackTops: Array.from({ length: threads - 1 }, (_, i) => (i + 3) * PAGE),
  });
  return {
    advect(words, axis, dt) {
      active();
      if (words.length !== size || !(dt > 0 && Number.isFinite(dt)))
        throw error(
          'unsupported',
          'Provide the initialized wave spectrum size and a finite positive transport interval.',
        );
      source.set(words);
      job[12] = axis === 'x' ? 0 : 1;
      interval[0] = dt;
      let status: number;
      try {
        const leader = () => phase(JOB, 0, 0, threads) as number;
        status = pool ? pool.phase(0, leader) : leader();
      } catch (cause) {
        throw error(
          'failed',
          'Run matching wave transport helpers in Node or an isolated browser worker, or choose threads: 1.',
          cause,
        );
      }
      if (status === 2)
        throw error(
          'failed',
          'The wave flux or update exceeded finite range. Reduce wave energy or the propagation interval.',
        );
      if (status !== 0) throw error('failed', 'Use matching native wave geometry, work buffers and spectrum layouts.');
      words.set(target);
      for (let i = 0; i < work.length; i++) accepted[i]! += work[i]!;
      axisSweeps++;
    },
    resetWork() {
      accepted.fill(0);
      axisSweeps = 0;
    },
    workCounts() {
      const totals = new Float64Array(WORK_WORDS);
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        for (let col = 0; col < WORK_WORDS; col++) totals[col]! += accepted[at + col]!;
        return counter(accepted, at);
      });
      return { ...counter(totals, 0), threads, axisSweeps, workers };
    },
  };
}

export async function loadWaveTransport({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}): Promise<WaveTransportBuild> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw error('unsupported', 'Choose 1, 2 or 4 wave transport participants.');
  const module = await loadModule(threads > 1, signal);
  signal?.throwIfAborted();
  let pool: NativePhasePool | undefined;
  let closed = false;
  let bound = false;
  function active() {
    if (closed) throw error('unsupported', 'Load a new wave transport solver after disposing this one.');
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
        subject: 'Wave transport',
        phaseExport: 'wave_transport_thread_phase',
        phase: 'spectral flux sweeps',
        signal,
      });
    }
    signal?.addEventListener('abort', close, { once: true });
    signal?.throwIfAborted();
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw error(
      'failed',
      'Start wave transport helpers in Node or an isolated browser worker, or choose threads: 1.',
      cause,
    );
  }
  return {
    bind(grid) {
      active();
      if (bound) throw error('unsupported', 'Load a fresh wave transport solver for another grid.');
      try {
        const kernel = bindTransport(module, threads, pool, active, grid);
        bound = true;
        return kernel;
      } catch (cause) {
        close();
        if (cause instanceof MargoError && cause.message.endsWith('#wave-spectrum')) throw cause;
        throw error(
          'failed',
          'Use a smaller spectral grid and matching wave transport Wasm to allocate its staging buffers.',
          cause,
        );
      }
    },
    [Symbol.dispose]: close,
  };
}
