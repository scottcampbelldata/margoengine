import { MargoError } from '@margoengine/math/errors';
import { compileWasmAsset } from '../../../shared/wasm-asset.js';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';
import { entryError } from './errors.js';
import type { SlamProfile } from './slam.js';

const PAGE = 65_536;
const WORD = Float64Array.BYTES_PER_ELEMENT;
const INDEX = Uint32Array.BYTES_PER_ELEMENT;
const JOB = 16;
const CONTROL = 80;
const WORK_WORDS = 6;

/** Work one participant (the caller or a helper worker) did in the entry profile kernel, counted in the units below. */
export interface EntryProfileWorkerWork {
  /** Raw vertices projected onto the section normal, once per profile on the lead participant. */
  readonly projectedVertices: number;
  /** Section planes evaluated by this participant. */
  readonly planes: number;
  /** Ordered triangle visits across the participant's planes. */
  readonly triangleVisits: number;
  /** Triangle distances evaluated against two distinct plane slots in the SIMD lanes. */
  readonly trianglePairs: number;
  /** Clip-edge intersections evaluated against both planes simultaneously. */
  readonly intersectionPairs: number;
  /** Clipped polygon fan terms projected for the two planes in the SIMD lanes. */
  readonly fanPairs: number;
}

/** Work counts of the entry profile kernel: the totals over every participant, with each participant's own share in `workers`. */
export interface EntryProfileWorkCounts extends EntryProfileWorkerWork {
  /** Section profiles the kernel has built since its last `resetWork()`. */
  readonly profiles: number;
  /** Participants that shared the work, the caller included (1, 2 or 4). */
  readonly threads: number;
  /** Each participant's counts, the caller first. */
  readonly workers: readonly EntryProfileWorkerWork[];
}

export interface EntryProfileKernel {
  profile(
    world: ArrayLike<number>,
    indices: ArrayLike<number>,
    normal: readonly [number, number, number],
    lowest: number,
    top: number,
    levels: number,
  ): SlamProfile;
  resetWork(): void;
  workCounts(): EntryProfileWorkCounts;
  close(): void;
}

function failure(message: string, cause?: unknown): MargoError {
  return Object.assign(entryError(cause instanceof MargoError ? cause.code : 'failed', message), { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './entry-profile-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './entry-profile-kernel.wasm?no-inline', import.meta.url);
  return compileWasmAsset(
    url,
    signal,
    failure,
    (status) => `Entry profile kernel HTTP ${status}. Serve its shipped Wasm asset.`,
    'Run entry profiles with Wasm SIMD support and their matching kernel asset.',
  );
}

function instantiate(module: WebAssembly.Module, threads: number) {
  try {
    const memory = new WebAssembly.Memory({ initial: threads + 1, maximum: MAX_MEMORY_PAGES, shared: threads > 1 });
    return { memory, exports: new WebAssembly.Instance(module, { env: { memory } }).exports };
  } catch (cause) {
    throw failure('Use the matching entry profile Wasm assets in a compatible runtime, or choose threads: 1.', cause);
  }
}

function report(words: Float64Array, at: number): EntryProfileWorkerWork {
  return {
    projectedVertices: words[at]!,
    planes: words[at + 1]!,
    triangleVisits: words[at + 2]!,
    trianglePairs: words[at + 3]!,
    intersectionPairs: words[at + 4]!,
    fanPairs: words[at + 5]!,
  };
}

function acceptedStatus(status: number): void {
  if (status === 1)
    throw entryError(
      'state',
      'Entry profile geometry exceeds finite range. Rescale the mesh or use nearby origin cells.',
    );
  if (status !== 0) throw failure('Run entry section clipping with the matching native kernel and profile buffers.');
}

export async function loadEntryProfileKernel({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}): Promise<EntryProfileKernel> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw entryError('state', 'Use 1, 2 or 4 native entry-profile participants.');
  const shared = threads > 1;
  const module = await loadModule(shared, signal);
  signal?.throwIfAborted();
  const { memory, exports } = instantiate(module, threads);
  const {
    __stack_pointer: stack,
    __data_end: data,
    entry_profile_project: project,
    entry_profile_thread_phase: phase,
  } = exports;
  if (
    !(stack instanceof WebAssembly.Global) ||
    !(data instanceof WebAssembly.Global) ||
    data.value !== 0 ||
    typeof project !== 'function' ||
    typeof phase !== 'function'
  )
    throw failure('Build entry profiles with their matching native stack, projection and clipping exports.');
  stack.value = 2 * PAGE;
  let pool: NativePhasePool | undefined;
  if (shared) {
    try {
      pool = await createNativePhasePool(threads, {
        subject: 'Entry profile',
        phaseExport: 'entry_profile_thread_phase',
        phase: 'section clipping',
        signal,
      });
      pool.init({
        memory,
        module,
        job: JOB,
        control: CONTROL,
        stackTops: Array.from({ length: threads - 1 }, (_, i) => (i + 3) * PAGE),
      });
    } catch (cause) {
      pool?.close();
      signal?.throwIfAborted();
      throw failure('Run entry profile workers in Node or an isolated browser worker, or choose threads: 1.', cause);
    }
  }
  let closed = false;
  let profiles = 0;
  const verticesAt = (threads + 1) * PAGE;
  const words = new Float64Array(WORK_WORDS * threads);
  const totals = new Float64Array(WORK_WORDS);
  return {
    profile(world, indices, normal, lowest, top, levels) {
      if (closed) throw entryError('state', 'Load a new entry profile kernel after disposing this one.');
      const vertices = world.length / 3;
      const triangles = indices.length / 3;
      if (
        !Number.isSafeInteger(vertices) ||
        vertices < 3 ||
        !Number.isSafeInteger(triangles) ||
        triangles < 1 ||
        !Number.isSafeInteger(levels) ||
        levels < 1 ||
        !Number.isSafeInteger(2 * triangles * levels) ||
        normal.length !== 3 ||
        !normal.every(Number.isFinite) ||
        !Number.isFinite(lowest) ||
        !(top >= 0 && Number.isFinite(top))
      )
        throw entryError('state', 'Provide a finite indexed entry mesh and positive whole section count.');
      const projectedAt = verticesAt + world.length * WORD;
      const levelsAt = projectedAt + vertices * WORD;
      const areasAt = levelsAt + levels * WORD;
      const workAt = areasAt + levels * WORD;
      const trianglesAt = workAt + words.byteLength;
      const pages = Math.ceil((trianglesAt + indices.length * INDEX) / PAGE);
      if (pages > MAX_MEMORY_PAGES)
        throw entryError(
          'state',
          'Entry profile staging exceeds Wasm space. Use a smaller collision mesh or fewer sections.',
        );
      try {
        const grow = pages - memory.buffer.byteLength / PAGE;
        if (grow > 0) memory.grow(grow);
      } catch (cause) {
        throw failure('Use a smaller entry collision mesh to fit the available native memory.', cause);
      }
      const buffer = memory.buffer;
      new Uint32Array(buffer, JOB, 10).set([
        verticesAt,
        trianglesAt,
        projectedAt,
        levelsAt,
        areasAt,
        workAt,
        vertices,
        triangles,
        levels,
        0,
      ]);
      new Float64Array(buffer, JOB + 40, 3).set(normal);
      new Float64Array(buffer, verticesAt, world.length).set(world);
      const index = new Uint32Array(buffer, trianglesAt, indices.length);
      for (let i = 0; i < indices.length; i++) {
        const value = indices[i]!;
        if (!Number.isInteger(value) || value < 0 || value >= vertices)
          throw entryError('state', 'Use entry triangle indices inside the transformed vertex array.');
        index[i] = value;
      }
      const planes = new Float64Array(buffer, levelsAt, levels);
      const heights = new Float64Array(levels + 1);
      for (let i = 1; i <= levels; i++) {
        const height = (top * i) / levels;
        heights[i] = height;
        planes[i - 1] = lowest + height;
      }
      if (!planes.every(Number.isFinite))
        throw entryError('state', 'Entry section heights exceed finite range. Rescale the mesh and nearby origin.');
      const work = new Float64Array(buffer, workAt, words.length);
      work.fill(0);
      let status: number;
      try {
        status = project(JOB) || (pool ? pool.phase(0, () => phase(JOB, 0, 0, threads)) : phase(JOB, 0, 0, 1));
      } catch (cause) {
        throw failure('Run the matching entry clipping workers and Wasm, or choose threads: 1.', cause);
      }
      acceptedStatus(status);
      const pairs = Math.floor(levels / 2);
      for (let part = 0; part < threads; part++) {
        const at = part * WORK_WORDS;
        const received = report(work, at);
        const partition = Math.floor((pairs * (part + 1)) / threads) - Math.floor((pairs * part) / threads);
        const planeCount = 2 * partition + Number(part === threads - 1 && levels % 2 !== 0);
        if (
          received.projectedVertices !== (part === 0 ? vertices : 0) ||
          received.planes !== planeCount ||
          received.triangleVisits !== planeCount * triangles ||
          received.trianglePairs !== partition * triangles ||
          !Number.isSafeInteger(received.intersectionPairs) ||
          received.intersectionPairs < 0 ||
          received.intersectionPairs > 2 * received.trianglePairs ||
          !Number.isSafeInteger(received.fanPairs) ||
          received.fanPairs < 0 ||
          received.fanPairs > 2 * received.trianglePairs
        )
          throw failure('Entry section work receipts are invalid. Rebuild the matching native assets.');
      }
      const radii = new Float64Array(levels + 1);
      const areas = new Float64Array(buffer, areasAt, levels);
      for (let i = 1; i <= levels; i++) radii[i] = Math.max(radii[i - 1]!, Math.sqrt(areas[i - 1]! / Math.PI));
      for (let i = 0; i < work.length; i++) {
        words[i]! += work[i]!;
        totals[i % WORK_WORDS]! += work[i]!;
      }
      profiles++;
      return { heights, radii };
    },
    resetWork() {
      profiles = 0;
      words.fill(0);
      totals.fill(0);
    },
    workCounts() {
      return {
        ...report(totals, 0),
        profiles,
        threads,
        workers: Array.from({ length: threads }, (_, part) => report(words, part * WORK_WORDS)),
      };
    },
    close() {
      closed = true;
      pool?.close();
    },
  };
}
