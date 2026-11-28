import { MargoError } from '@margoengine/math/errors';
import { FORCING_WORDS } from '../hydro/fields.js';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';
import { surfError } from './errors.js';

const PAGE = 65_536;
const JOB = 16;
const CONTROL = 128;
const WORK = 224;
const WORK_WORDS = 5;

/** Work actually performed by one native surf participant. */
export interface SurfForceWorkerWork {
  /** Wave-active cells whose directional moments and roller stresses were evaluated. */
  readonly momentCells: number;
  /** Moment cells evaluated in one of the two f64x2 lanes. */
  readonly pairedMoments: number;
  readonly directionalBins: number;
  /** Wet cells receiving the centered radiation-stress divergence. */
  readonly divergenceCells: number;
  /** Divergence cells evaluated in one of the two f64x2 lanes. */
  readonly pairedDivergence: number;
}

/** Work for the last accepted force calculation, with the caller in slot zero. */
export interface SurfForceWorkCounts extends SurfForceWorkerWork {
  readonly threads: number;
  readonly workers: readonly SurfForceWorkerWork[];
}

interface Grid {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly dz: number;
  readonly density: number;
  readonly gravity: number;
  readonly wetDepth: number;
  readonly dtheta: number;
  readonly directionX: Float64Array;
  readonly directionZ: Float64Array;
  readonly wrapX: boolean;
  readonly wrapZ: boolean;
}

export interface SurfForceBuild {
  bind(grid: Grid): SurfForceKernel;
  [Symbol.dispose](): void;
}

export interface SurfForceKernel {
  force(
    energy: Float64Array,
    roller: Float64Array,
    groupSpeed: Float64Array,
    phaseSpeed: Float64Array,
    depth: Float64Array,
    wavenumber: Float64Array,
    omega: Float64Array,
    output: Float64Array,
  ): void;
  workCounts(): SurfForceWorkCounts;
}

function failed(message: string, cause?: unknown): MargoError {
  const result = surfError('failed', message);
  return cause === undefined ? result : Object.assign(result, { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './surf-force-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './surf-force-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw failed(`The surf force kernel returned HTTP ${response.status}. Serve its shipped Wasm asset.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw failed('Load the shipped surf force asset in a Wasm SIMD runtime, or use the scalar solver.', cause);
  }
}

function receipt(words: Uint32Array, at: number): SurfForceWorkerWork {
  return {
    momentCells: words[at]!,
    pairedMoments: words[at + 1]!,
    directionalBins: words[at + 2]!,
    divergenceCells: words[at + 3]!,
    pairedDivergence: words[at + 4]!,
  };
}

function bindForce(
  module: WebAssembly.Module,
  threads: number,
  pool: NativePhasePool | undefined,
  active: () => void,
  grid: Grid,
): SurfForceKernel {
  const { nx, nz, dx, dz, density, gravity, wetDepth, dtheta, directionX, directionZ, wrapX, wrapZ } = grid;
  const cells = nx * nz;
  const bins = directionX.length;
  const size = cells * bins;
  if (
    ![nx, nz, bins, size].every((value) => Number.isSafeInteger(value) && value > 0) ||
    ![dx, dz, density, gravity, wetDepth, dtheta].every((value) => value > 0 && Number.isFinite(value)) ||
    directionZ.length !== bins
  )
    throw surfError('unsupported', 'Initialize a finite positive surf grid and one basis vector per direction.');
  let end = (threads + 1) * PAGE;
  function reserve(words: number): number {
    const at = end;
    end += words * Float64Array.BYTES_PER_ELEMENT;
    return at;
  }
  const energyAt = reserve(size);
  const rollerAt = reserve(cells);
  const propsAt = reserve(5 * cells);
  const directionXAt = reserve(bins);
  const directionZAt = reserve(bins);
  const stressAt = reserve(3 * cells);
  const outputAt = reserve(FORCING_WORDS * cells);
  const pages = Math.ceil(end / PAGE);
  if (pages > MAX_MEMORY_PAGES)
    throw surfError('unsupported', 'Use fewer surf cells or directions to fit native forcing memory.');
  const memory = new WebAssembly.Memory({ initial: pages, maximum: MAX_MEMORY_PAGES, shared: threads > 1 });
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  const { __stack_pointer: stack, surf_force_thread_phase: phase } = exports;
  if (!(stack instanceof WebAssembly.Global) || typeof phase !== 'function')
    throw failed('Serve the matching stateless surf asset with its forcing phase.');
  stack.value = 2 * PAGE;
  const buffer = memory.buffer;
  const f64 = (at: number, length: number): Float64Array => new Float64Array(buffer, at, length);
  const energyWords = f64(energyAt, size);
  const rollerWords = f64(rollerAt, cells);
  const properties = f64(propsAt, 5 * cells);
  const candidate = f64(outputAt, FORCING_WORDS * cells);
  f64(directionXAt, bins).set(directionX);
  f64(directionZAt, bins).set(directionZ);
  new Uint32Array(buffer, JOB, 14).set([
    energyAt,
    rollerAt,
    propsAt,
    directionXAt,
    directionZAt,
    stressAt,
    outputAt,
    WORK,
    nx,
    nz,
    bins,
    Number(wrapX),
    Number(wrapZ),
  ]);
  f64(JOB + 56, 6).set([dx, dz, density, gravity, wetDepth, dtheta]);
  const work = new Uint32Array(buffer, WORK, WORK_WORDS * threads);
  const accepted = new Uint32Array(work.length);
  pool?.init({
    memory,
    module,
    job: JOB,
    control: CONTROL,
    stackTops: Array.from({ length: threads - 1 }, (_, i) => (i + 3) * PAGE),
  });
  return {
    force(energy, roller, cg, c, depth, k, sigma, output) {
      active();
      const planes = [cg, c, depth, k, sigma];
      if (
        energy.length !== size ||
        roller.length !== cells ||
        output.length !== candidate.length ||
        planes.some((plane) => plane.length !== cells)
      )
        throw surfError(
          'unsupported',
          'Supply one wave, roller and dispersion field matching the initialized surf grid.',
        );
      energyWords.set(energy);
      rollerWords.set(roller);
      for (const [i, plane] of planes.entries()) properties.set(plane, i * cells);
      for (let stage = 0; stage <= 1; stage++) {
        let status: number;
        try {
          const leader = () => phase(JOB, stage, 0, threads) as number;
          status = pool ? pool.phase(stage, leader) : leader();
        } catch (cause) {
          throw failed(
            'Use matching surf helpers and Wasm in Node or an isolated browser worker, or choose threads: 1.',
            cause,
          );
        }
        if (status === 2)
          throw failed(
            'A surf radiation stress or forcing exceeded finite range. Reduce wave energy or choose a resolved depth grid.',
          );
        if (status !== 0) throw failed('Serve matching surf forcing phase and geometry layouts.');
      }
      output.set(candidate);
      accepted.set(work);
    },
    workCounts() {
      const totals = new Uint32Array(WORK_WORDS);
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        for (let col = 0; col < WORK_WORDS; col++) totals[col]! += accepted[at + col]!;
        return receipt(accepted, at);
      });
      return { ...receipt(totals, 0), threads, workers };
    },
  };
}

export async function loadSurfForce({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}): Promise<SurfForceBuild> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw surfError('unsupported', 'Choose 1, 2 or 4 surf force participants.');
  const module = await loadModule(threads > 1, signal);
  signal?.throwIfAborted();
  let pool: NativePhasePool | undefined;
  let closed = false;
  let bound = false;
  function active() {
    if (closed) throw surfError('unsupported', 'Load a new surf solver after disposing this one.');
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
        subject: 'Surf force',
        phaseExport: 'surf_force_thread_phase',
        phase: 'wave moments and stress divergence',
        signal,
      });
    }
    signal?.addEventListener('abort', close, { once: true });
    signal?.throwIfAborted();
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw failed('Start surf helpers in Node or an isolated browser worker, or choose threads: 1.', cause);
  }
  return {
    bind(grid) {
      active();
      if (bound) throw surfError('unsupported', 'Load a fresh surf solver for another grid.');
      try {
        const kernel = bindForce(module, threads, pool, active, grid);
        bound = true;
        return kernel;
      } catch (cause) {
        close();
        if (cause instanceof MargoError && cause.message.endsWith('#nearshore-surf')) throw cause;
        throw failed('Use a smaller surf grid and matching Wasm to allocate its forcing buffers.', cause);
      }
    },
    [Symbol.dispose]: close,
  };
}
