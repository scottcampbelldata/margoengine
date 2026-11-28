import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';
import { foamError } from './errors.js';

const PAGE = 65_536;
const WORD = Float64Array.BYTES_PER_ELEMENT;
const JOB = 16;
const CONTROL = 64;
const WORK_WORDS = 6;

/** Work one participant (the caller or a helper worker) did in the foam transport kernel, counted in the units below. */
export interface FoamTransportWorkerWork {
  /** X sweep lines visited over all CFL substeps. */
  readonly xLines: number;
  /** Z sweep lines visited over all CFL substeps. */
  readonly zLines: number;
  /** X faces reconstructed with coverage and rate-weighted coverage in the SIMD lanes. */
  readonly xFacePairs: number;
  /** Z faces reconstructed with coverage and rate-weighted coverage in the SIMD lanes. */
  readonly zFacePairs: number;
  /** Cell pairs updated during the X and Z sweeps. */
  readonly cellPairs: number;
  /** Cell pairs clamped after their Z sweep. */
  readonly clampPairs: number;
}

/** Work counts of the foam transport kernel: the totals over every participant, with each participant's own share in `workers`. */
export interface FoamTransportWorkCounts extends FoamTransportWorkerWork {
  /** Participants that shared the sweeps, the caller included. */
  readonly threads: number;
  /** CFL substeps the transported interval was cut into. */
  readonly substeps: number;
  /** Each participant's counts, the caller first. */
  readonly workers: readonly FoamTransportWorkerWork[];
}

export interface FoamTransportKernel {
  transport(
    foam: Float64Array,
    fx: Float64Array,
    fz: Float64Array,
    nx: number,
    nz: number,
    h: number,
    dt: number,
    steps: number,
  ): void;
  workCounts(): FoamTransportWorkCounts | undefined;
  close(): void;
}

function failure(message: string, cause?: unknown): MargoError {
  return Object.assign(foamError('failed', message), { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './foam-transport-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './foam-transport-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok) throw failure(`Foam transport kernel HTTP ${response.status}. Serve its shipped Wasm asset.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw failure('Run foam transport with Wasm SIMD support and its matching kernel asset.', cause);
  }
}

function exportsOf(module: WebAssembly.Module, memory: WebAssembly.Memory): WebAssembly.Exports {
  try {
    return new WebAssembly.Instance(module, { env: { memory } }).exports;
  } catch (cause) {
    throw failure('Use the matching foam transport Wasm assets or choose threads: 1.', cause);
  }
}

function memoryFor(threads: number): WebAssembly.Memory {
  try {
    return new WebAssembly.Memory({ initial: threads + 1, maximum: MAX_MEMORY_PAGES, shared: threads > 1 });
  } catch (cause) {
    throw failure('Use a compatible Wasm memory runtime, or choose threads: 1 for foam transport.', cause);
  }
}

function row(words: Float64Array, at: number): FoamTransportWorkerWork {
  return {
    xLines: words[at]!,
    zLines: words[at + 1]!,
    xFacePairs: words[at + 2]!,
    zFacePairs: words[at + 3]!,
    cellPairs: words[at + 4]!,
    clampPairs: words[at + 5]!,
  };
}

function counts(
  words: Float64Array,
  threads: number,
  substeps: number,
  nx: number,
  nz: number,
): FoamTransportWorkCounts {
  const totals = new Float64Array(WORK_WORDS);
  const workers = Array.from({ length: threads }, (_, part) => {
    const at = part * WORK_WORDS;
    const work = row(words, at);
    const lines = (count: number) =>
      (Math.floor(((part + 1) * count) / threads) - Math.floor((part * count) / threads)) * substeps;
    if (
      work.xLines !== lines(nz) ||
      work.zLines !== lines(nx) ||
      work.cellPairs !== work.xLines * nx + work.zLines * nz ||
      work.clampPairs !== work.zLines * nz ||
      !Number.isSafeInteger(work.xFacePairs) ||
      !Number.isSafeInteger(work.zFacePairs) ||
      work.xFacePairs < work.xLines * (nx - 1) ||
      work.zFacePairs < work.zLines * (nz - 1) ||
      work.xFacePairs > work.xLines * (nx + 1) ||
      work.zFacePairs > work.zLines * (nz + 1)
    )
      throw failure('Foam transport work receipts are invalid. Rebuild the matching native assets.');
    for (let i = 0; i < WORK_WORDS; i++) totals[i]! += words[at + i]!;
    return work;
  });
  return { threads, substeps, ...row(totals, 0), workers };
}

export async function loadFoamKernel({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}): Promise<FoamTransportKernel> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw foamError('state', 'Use 1, 2 or 4 native foam transport participants.');
  const shared = threads > 1;
  const module = await loadModule(shared, signal);
  signal?.throwIfAborted();
  const memory = memoryFor(threads);
  const {
    __stack_pointer: stack,
    __data_end: data,
    foam_transport_apply: apply,
    foam_transport_thread_phase: thread,
  } = exportsOf(module, memory);
  if (
    !(stack instanceof WebAssembly.Global) ||
    !(data instanceof WebAssembly.Global) ||
    data.value !== 0 ||
    typeof apply !== 'function' ||
    typeof thread !== 'function'
  )
    throw failure('Build foam transport with its matching split-advection and stack exports.');
  const phase = thread;
  const serial = apply;
  stack.value = 2 * PAGE;
  let pool: NativePhasePool | undefined;
  if (shared) {
    pool = await createNativePhasePool(threads, {
      subject: 'Foam transport',
      phaseExport: 'foam_transport_thread_phase',
      phase: 'directional flux',
      signal,
    });
    pool.init({
      memory,
      module,
      job: JOB,
      control: CONTROL,
      stackTops: Array.from({ length: threads - 1 }, (_, i) => (i + 3) * PAGE),
    });
  }
  let closed = false;
  let work: FoamTransportWorkCounts | undefined;
  const foamAt = (threads + 1) * PAGE;

  function run(steps: number): number {
    if (!pool) return serial(JOB, steps);
    for (let step = 0; step < steps; step++) {
      const x = pool.phase(0, () => phase(JOB, 0, 0, threads));
      if (x !== 0) return x;
      const z = pool.phase(1, () => phase(JOB, 1, 0, threads));
      if (z !== 0) return z;
    }
    return 0;
  }

  return {
    transport(foam, fx, fz, nx, nz, h, dt, steps) {
      if (closed) throw foamError('state', 'Load a new foam transport solver after disposing this one.');
      const cells = nx * nz;
      const sub = steps > 0 ? dt / steps : 0;
      if (
        !Number.isSafeInteger(nx) ||
        nx < 1 ||
        !Number.isSafeInteger(nz) ||
        nz < 1 ||
        !Number.isSafeInteger(steps) ||
        steps < 0 ||
        steps > 0xffff_ffff ||
        !Number.isSafeInteger(2 * cells * steps) ||
        !(h > 0 && Number.isFinite(h) && dt >= 0 && Number.isFinite(dt)) ||
        (dt > 0 && steps > 0 && !(sub > 0)) ||
        !Number.isFinite(sub / h) ||
        foam.length !== 2 * cells ||
        fx.length !== (nx + 1) * nz ||
        fz.length !== nx * (nz + 1)
      )
        throw foamError('state', 'Provide a representable foam grid and CFL count. Use fewer cells or a smaller step.');
      const receiptWords = WORK_WORDS * threads;
      if (steps === 0) {
        work = counts(new Float64Array(receiptWords), threads, 0, nx, nz);
        return;
      }
      const temporaryAt = foamAt + foam.byteLength;
      const fxAt = temporaryAt + foam.byteLength;
      const fzAt = fxAt + fx.byteLength;
      const workAt = fzAt + fz.byteLength;
      const pages = Math.ceil((workAt + receiptWords * WORD) / PAGE);
      if (pages > MAX_MEMORY_PAGES)
        throw foamError('state', 'Foam transport exceeds Wasm storage. Use fewer grid cells.');
      try {
        const grow = pages - memory.buffer.byteLength / PAGE;
        if (grow > 0) memory.grow(grow);
      } catch (cause) {
        throw failure('Use a smaller foam grid to fit the available Wasm memory.', cause);
      }
      const buffer = memory.buffer;
      new Uint32Array(buffer, JOB, 8).set([foamAt, temporaryAt, fxAt, fzAt, workAt, nx, nz, 0]);
      new Float64Array(buffer, JOB + 32, 2).set([h, sub]);
      const candidate = new Float64Array(buffer, foamAt, foam.length);
      candidate.set(foam);
      new Float64Array(buffer, fxAt, fx.length).set(fx);
      new Float64Array(buffer, fzAt, fz.length).set(fz);
      const actual = new Float64Array(buffer, workAt, receiptWords);
      actual.fill(0);
      const status = run(steps);
      if (status === 1)
        throw foamError('state', 'Foam transport exceeded finite range. Reduce face speed or the injected decay rate.');
      if (status !== 0)
        throw foamError(
          'state',
          'Provide a valid foam transport grid, positive spacing and representable CFL intervals.',
        );
      const receipt = counts(actual, threads, steps, nx, nz);
      foam.set(candidate);
      work = receipt;
    },
    workCounts() {
      return work;
    },
    close() {
      closed = true;
      pool?.close();
    },
  };
}
