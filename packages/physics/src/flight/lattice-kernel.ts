import { MargoError } from '@margoengine/math/errors';
import type { Vec3 } from '../math.js';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';

const PAGE = 65_536;
const WORD = Float64Array.BYTES_PER_ELEMENT;
const PANEL_WORDS = 22;
const RECEIPT_WORDS = 6;
const JOB = 16;
const CONTROL = 64;

/** Counted work done by one participant in an accepted wing load. */
export interface WingLatticeWorkerWork {
  /** Evaluated collocation point–horseshoe influences. */
  readonly matrixInteractions: number;
  /** Two active collocation points evaluated simultaneously against one horseshoe. */
  readonly matrixPairs: number;
  /** Evaluated bound point–horseshoe induced-velocity contributions. */
  readonly wakeInteractions: number;
  /** Two active bound points evaluated simultaneously against one horseshoe. */
  readonly wakePairs: number;
  /** Matrix entries updated in fixed-order elimination on the caller. */
  readonly eliminationUpdates: number;
  /** Two adjacent elimination entries updated by the same SIMD multiplication and subtraction. */
  readonly eliminationPairs: number;
}

/** Total work in the accepted load and its partition among native participants. */
export interface WingLatticeWorkCounts extends WingLatticeWorkerWork {
  /** Participants, including the caller. */
  readonly threads: number;
  /** Native calls, including the implicit load probes. */
  readonly solves: number;
  /** Work in fixed partition order, beginning with the caller. */
  readonly workers: readonly WingLatticeWorkerWork[];
}

export interface WingLatticeKernel {
  solve(
    panels: {
      boundA: readonly Vec3[];
      boundB: readonly Vec3[];
      trailA: readonly Vec3[];
      trailB: readonly Vec3[];
      collocation: readonly Vec3[];
      normal: readonly Vec3[];
      points: readonly Vec3[];
      stalled: readonly boolean[];
      speeds: readonly number[];
      relative: readonly Vec3[];
      wake: Vec3;
    },
    keepInfluence?: boolean,
  ): { circulation: Float64Array; induced: Float64Array; influence?: Float64Array };
  resetWork(): void;
  workCounts(): WingLatticeWorkCounts;
  close(): void;
}

function latticeError(code: 'failed' | 'state', message: string): MargoError {
  return new MargoError(code, message + ' See https://margoengine.com/errors#physics-flight');
}

function loadFailure(message: string, cause?: unknown): MargoError {
  return Object.assign(latticeError('failed', message), { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './wing-lattice-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './wing-lattice-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok) throw loadFailure(`Wing lattice kernel HTTP ${response.status}. Serve its shipped Wasm asset.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw loadFailure('Run the wing lattice with Wasm SIMD support and its matching kernel asset.', cause);
  }
}

function report(values: Float64Array, offset: number): WingLatticeWorkerWork {
  return {
    matrixInteractions: values[offset]!,
    matrixPairs: values[offset + 1]!,
    wakeInteractions: values[offset + 2]!,
    wakePairs: values[offset + 3]!,
    eliminationUpdates: values[offset + 4]!,
    eliminationPairs: values[offset + 5]!,
  };
}

function check(status: number): void {
  if (status === 1)
    throw latticeError(
      'state',
      'Wing lattice influence or circulation exceeds finite range. Reduce the wing geometry or wind magnitudes.',
    );
  if (status !== 0) throw loadFailure('Rebuild or serve the matching native wing lattice matrix and wake assets.');
}

export async function loadWingLattice({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}): Promise<WingLatticeKernel> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw latticeError('state', 'Use 1, 2 or 4 native wing lattice participants.');
  const shared = threads > 1;
  const module = await loadModule(shared, signal);
  signal?.throwIfAborted();
  const memory = new WebAssembly.Memory({ initial: threads + 1, maximum: MAX_MEMORY_PAGES, shared });
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  const {
    __stack_pointer: stack,
    __data_end: data,
    flight_lattice_thread_phase: phase,
    flight_lattice_solve: solve,
  } = exports;
  if (
    !(stack instanceof WebAssembly.Global) ||
    !(data instanceof WebAssembly.Global) ||
    data.value !== 0 ||
    typeof phase !== 'function' ||
    typeof solve !== 'function'
  )
    throw loadFailure('Build the wing lattice with its matching stack, solve and phase exports.');
  const apply = phase;
  stack.value = 2 * PAGE;
  let pool: NativePhasePool | undefined;
  if (shared) {
    pool = await createNativePhasePool(threads, {
      subject: 'Wing lattice',
      phaseExport: 'flight_lattice_thread_phase',
      phase: 'matrix and wake',
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
  let solves = 0;
  const sums = new Float64Array(RECEIPT_WORDS);
  const participantTotals = new Float64Array(RECEIPT_WORDS * threads);
  const panelsAt = (threads + 1) * PAGE;

  function runPhase(stage: number): number {
    return pool ? pool.phase(stage, () => apply(JOB, stage, 0, threads)) : apply(JOB, stage, 0, threads);
  }

  return {
    solve(
      { boundA, boundB, trailA, trailB, collocation, normal, points, stalled, relative, speeds, wake },
      keepInfluence,
    ) {
      if (closed) throw latticeError('state', 'Load a new wing lattice after disposing this one.');
      const n = boundA.length;
      const matrixAt = panelsAt + PANEL_WORDS * n * WORD;
      const rhsAt = matrixAt + n * n * WORD;
      const inducedAt = rhsAt + n * WORD;
      const workAt = inducedAt + 3 * n * WORD;
      const need = Math.ceil((workAt + participantTotals.byteLength) / PAGE);
      if (!Number.isSafeInteger(need) || need > MAX_MEMORY_PAGES)
        throw latticeError('state', 'Wing lattice exceeds Wasm storage. Reduce chordwise or spanwise panel counts.');
      try {
        const grow = need - memory.buffer.byteLength / PAGE;
        if (grow > 0) memory.grow(grow);
      } catch (cause) {
        throw loadFailure('Use fewer wing panels to fit the available WebAssembly memory.', cause);
      }
      const buffer = memory.buffer;
      new Uint32Array(buffer, JOB, 6).set([panelsAt, matrixAt, rhsAt, inducedAt, workAt, n]);
      new Float64Array(buffer, JOB + 24, 3).set(wake);
      const geometry = new Float64Array(buffer, panelsAt, PANEL_WORDS * n);
      const rhs = new Float64Array(buffer, rhsAt, n);
      for (let i = 0; i < n; i++) {
        const at = PANEL_WORDS * i;
        geometry.set(boundA[i]!, at);
        geometry.set(boundB[i]!, at + 3);
        geometry.set(trailA[i]!, at + 6);
        geometry.set(trailB[i]!, at + 9);
        geometry.set(collocation[i]!, at + 12);
        geometry.set(normal[i]!, at + 15);
        geometry.set(points[i]!, at + 18);
        geometry[at + 21] = stalled[i] ? 0 : speeds[i]! > 1e-9 ? 1 : 2;
        const [vx, vy, vz] = relative[i]!;
        const [nx, ny, nz] = normal[i]!;
        rhs[i] = stalled[i] ? 0 : -(vx * nx + vy * ny + vz * nz);
      }
      if (!geometry.every(Number.isFinite) || !rhs.every(Number.isFinite) || !wake.every(Number.isFinite))
        throw latticeError('state', 'Use finite wing geometry, relative wind and aerodynamic directions.');
      const matrix = new Float64Array(buffer, matrixAt, n * n);
      matrix.fill(0);
      check(runPhase(0));
      // Native elimination overwrites its matrix. Only membrane damping needs the original diagonal response.
      const influence = keepInfluence ? matrix.slice() : undefined;
      check(solve(JOB));
      check(runPhase(1));
      const work = new Float64Array(buffer, workAt, RECEIPT_WORDS * threads);
      for (let i = 0; i < work.length; i++) {
        const value = work[i]!;
        if (!Number.isSafeInteger(value) || value < 0)
          throw loadFailure('Wing lattice work receipts are invalid. Rebuild the matching native assets.');
      }
      for (let i = 0; i < work.length; i++) {
        participantTotals[i]! += work[i]!;
        sums[i % RECEIPT_WORDS]! += work[i]!;
      }
      solves++;
      const circulation = rhs.slice();
      const induced = new Float64Array(buffer, inducedAt, 3 * n).slice();
      return influence ? { circulation, induced, influence } : { circulation, induced };
    },
    resetWork() {
      solves = 0;
      sums.fill(0);
      participantTotals.fill(0);
    },
    workCounts() {
      return {
        ...report(sums, 0),
        threads,
        solves,
        workers: Array.from({ length: threads }, (_, part) => report(participantTotals, part * RECEIPT_WORDS)),
      };
    },
    close() {
      closed = true;
      pool?.close();
    },
  };
}
