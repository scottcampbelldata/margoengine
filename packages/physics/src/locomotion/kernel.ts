import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { locomotionError } from './errors.js';

const JOB_BYTES = 72;
const WORK_WORDS = 7;

/** Body and contact work executed by a native participant. */
export interface LocomotionWorkerWork {
  /** Independently integrated poses. */
  readonly bodies: number;
  /** Ground-contact rows evaluated, including swing and unloaded contact candidates. */
  readonly contactRows: number;
  readonly snakeLinks: number;
  readonly feet: number;
  readonly torsoRows: number;
  /** Contact rows marked as stance by the respective body model. */
  readonly stanceRows: number;
  /** Paired f64x2 contact projections executed for anisotropic friction, spring rate or damping. */
  readonly pairedContactDots: number;
}

/** Native work in the latest successful integration, with the caller at worker index zero. */
export interface LocomotionWorkCounts extends LocomotionWorkerWork {
  readonly threads: number;
  readonly workers: readonly LocomotionWorkerWork[];
}

interface BodyRange {
  readonly offset: number;
  readonly count: number;
}

export interface LocomotionBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface LocomotionKernel {
  prepare(body: number, profile: number, actuators: number, anchors: number, geometry: number, count: number): void;
  stepBatch(
    body: number,
    profile: number,
    actuators: number,
    anchors: number,
    geometry: number,
    contacts: number,
    dt: number,
    gravityX: number,
    gravityY: number,
    gravityZ: number,
  ): number;
  workCounts(): LocomotionWorkCounts | undefined;
}

type Phase = (job: number, stage: number, part: number, parts: number) => number;

export async function loadLocomotionBuilds(signal?: AbortSignal, threads = 1): Promise<LocomotionBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw locomotionError('Choose 1, 2 or 4 locomotion native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw locomotionError(
      'Use Node or an isolated browser worker for locomotion helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './locomotion-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './locomotion-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  let pool: NativePhasePool | undefined;
  function close() {
    signal?.removeEventListener('abort', close);
    pool?.close();
  }
  try {
    if (threads > 1) {
      pool = await createNativePhasePool(threads, {
        subject: 'Locomotion',
        phaseExport: 'locomotion_thread_phase',
        phase: 'body contact integration',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw locomotionError(
      'Start locomotion helpers in Node or an isolated browser worker, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const module = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ module);
      const wasm = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return wasm;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw locomotionError(
        `Locomotion Wasm request returned HTTP ${response.status}; serve the locomotion kernel asset.`,
        'failed',
      );
    const wasm =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return wasm;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw locomotionError(
      'Locomotion Wasm failed to load; use a SIMD runtime and serve the optional locomotion kernel.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindLocomotionKernel(
  host: SolverHost,
  builds: LocomotionBuilds,
  ranges: readonly BodyRange[],
): LocomotionKernel {
  try {
    return bind(host, builds, ranges);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#locomotion')) throw cause;
    throw locomotionError(
      'Bind locomotion Wasm and helpers in a compatible world, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

function bind(host: SolverHost, builds: LocomotionBuilds, ranges: readonly BodyRange[]): LocomotionKernel {
  const pool = builds.pool;
  const wasm = isShared(host.memory) ? builds.shared : builds.plain;
  if (!wasm)
    throw locomotionError(
      pool
        ? 'Use shared world memory for locomotion helpers, or choose threads: 1.'
        : 'The shared locomotion kernel is unavailable; create a plain-memory world.',
      'unsupported',
    );

  const stack = host.allocate('locomotion-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const threads = pool?.count ?? 1;
  const region = host.allocate('locomotion-native-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1);
  const table = host.allocate('locomotion-native-ranges', 8 * ranges.length, 'u32', 1);
  const tableWords = new Uint32Array(host.memory.buffer, table.byteOffset, 2 * ranges.length);
  for (const [row, range] of ranges.entries()) {
    tableWords[2 * row] = range.offset;
    tableWords[2 * row + 1] = range.count;
  }
  const bodyCount = ranges.length;
  const job = region.byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, locomotion_prepare, locomotion_thread_phase } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    typeof locomotion_prepare !== 'function' ||
    typeof locomotion_thread_phase !== 'function'
  )
    throw locomotionError('Rebuild the locomotion Wasm with its prepare and contact-integration exports.', 'failed');
  pointer.value = stackTop(stack);
  const phase = locomotion_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('locomotion-native-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`locomotion-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module: wasm, job, control: control.byteOffset, stackTops });
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  return {
    prepare: locomotion_prepare as LocomotionKernel['prepare'],
    stepBatch(...args) {
      const buffer = host.memory.buffer;
      const words = new Uint32Array(buffer, job, 10);
      words.set(args.slice(0, 6));
      words[6] = table.byteOffset;
      words[7] = work;
      words[8] = bodyCount;
      new Float64Array(buffer, job + 40, 4).set(args.slice(6));
      const leader = () => phase(job, 0, 0, threads);
      let status: number;
      try {
        status = pool ? pool.phase(0, leader) : leader();
      } catch (cause) {
        throw locomotionError('Run matching locomotion helpers and Wasm, or choose threads: 1.', 'failed', cause);
      }
      if (status === 0) accepted.set(new Float64Array(buffer, work, accepted.length));
      return status;
    },
    workCounts() {
      const totals = {
        bodies: 0,
        contactRows: 0,
        snakeLinks: 0,
        feet: 0,
        torsoRows: 0,
        stanceRows: 0,
        pairedContactDots: 0,
      };
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        const bodies = accepted[at]!;
        const contactRows = accepted[at + 1]!;
        const snakeLinks = accepted[at + 2]!;
        const feet = accepted[at + 3]!;
        const torsoRows = accepted[at + 4]!;
        const stanceRows = accepted[at + 5]!;
        const pairedContactDots = accepted[at + 6]!;
        totals.bodies += bodies;
        totals.contactRows += contactRows;
        totals.snakeLinks += snakeLinks;
        totals.feet += feet;
        totals.torsoRows += torsoRows;
        totals.stanceRows += stanceRows;
        totals.pairedContactDots += pairedContactDots;
        return { bodies, contactRows, snakeLinks, feet, torsoRows, stanceRows, pairedContactDots };
      });
      return totals.bodies ? { threads, ...totals, workers } : undefined;
    },
  };
}
