import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';
import { floodError } from './flood-errors.js';
import type { HullMesh, Vec3 } from './wetted.js';

const PAGE = 65_536;
const WORD = Float64Array.BYTES_PER_ELEMENT;
const INDEX = Uint32Array.BYTES_PER_ELEMENT;
const JOB = 16;
const CONTROL = 80;
const WORK_WORDS = 6;

/** Executed work for one flood volume participant. */
export interface FloodVolumeWorkerWork {
  /** Vertices projected once on the leader for every batch of requested planes. */
  readonly projectedVertices: number;
  readonly planes: number;
  readonly triangleVisits: number;
  /** Triangle distances evaluated against a pair of plane heights. */
  readonly trianglePairs: number;
  /** Piecewise-linear edge cuts evaluated in both SIMD lanes. */
  readonly intersectionPairs: number;
  /** Signed tetrahedral fan terms evaluated in both SIMD lanes. */
  readonly fanPairs: number;
}

/** Work accumulated since the last reset, with the caller in worker slot zero. */
export interface FloodVolumeWorkCounts extends FloodVolumeWorkerWork {
  readonly batches: number;
  readonly threads: number;
  readonly workers: readonly FloodVolumeWorkerWork[];
}

/** Optional synchronous compartment volume clipping. */
export interface FloodVolumeKernel {
  volumes(mesh: HullMesh, up: Vec3, heights: Float64Array, out: Float64Array): void;
  workCounts(): FloodVolumeWorkCounts;
  resetWork(): void;
  close(): void;
  [Symbol.dispose](): void;
}

function failure(message: string, cause?: unknown): MargoError {
  return Object.assign(floodError(cause instanceof MargoError ? cause.code : 'failed', message), { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './flood-volume-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './flood-volume-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok) throw failure(`Flood volume kernel HTTP ${response.status}. Serve the shipped Wasm asset.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw failure('Load the matching compartment clipping asset in a Wasm SIMD runtime.', cause);
  }
}

function instantiate(module: WebAssembly.Module, threads: number) {
  try {
    const memory = new WebAssembly.Memory({ initial: threads + 1, maximum: MAX_MEMORY_PAGES, shared: threads > 1 });
    return { memory, exports: new WebAssembly.Instance(module, { env: { memory } }).exports };
  } catch (cause) {
    throw failure('Use the matching flood volume assets and synchronous worker runtime, or choose threads: 1.', cause);
  }
}

function report(words: Float64Array, at: number): FloodVolumeWorkerWork {
  return {
    projectedVertices: words[at]!,
    planes: words[at + 1]!,
    triangleVisits: words[at + 2]!,
    trianglePairs: words[at + 3]!,
    intersectionPairs: words[at + 4]!,
    fanPairs: words[at + 5]!,
  };
}

/** Load the native compartment volume kernel. Use more than one participant in Node or an isolated browser worker. */
export async function loadFloodVolumeKernel({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}): Promise<FloodVolumeKernel> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw floodError('state', 'Choose 1, 2 or 4 flood volume participants.');
  const shared = threads > 1;
  const module = await loadModule(shared, signal);
  signal?.throwIfAborted();
  const { memory, exports } = instantiate(module, threads);
  const {
    __stack_pointer: stack,
    __data_end: data,
    flood_volume_project: project,
    flood_volume_thread_phase: phase,
  } = exports;
  if (
    !(stack instanceof WebAssembly.Global) ||
    !(data instanceof WebAssembly.Global) ||
    data.value !== 0 ||
    typeof project !== 'function' ||
    typeof phase !== 'function'
  )
    throw failure('Build the matching stateless flood volume assets with their clipping exports.');
  stack.value = 2 * PAGE;
  let pool: NativePhasePool | undefined;
  if (shared) {
    try {
      pool = await createNativePhasePool(threads, {
        subject: 'Flood volume',
        phaseExport: 'flood_volume_thread_phase',
        phase: 'compartment clipping',
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
      throw failure('Run the flood volume helpers in Node or an isolated browser worker, or choose threads: 1.', cause);
    }
  }
  let closed = false;
  let batches = 0;
  const verticesAt = (threads + 1) * PAGE;
  const words = new Float64Array(WORK_WORDS * threads);
  const totals = new Float64Array(WORK_WORDS);
  function close() {
    if (closed) return;
    closed = true;
    pool?.close();
  }
  return {
    volumes(mesh, up, heights, out) {
      if (closed) throw floodError('state', 'Load a new flood volume kernel after closing this one.');
      const vertices = mesh.vertices.length / 3;
      const triangles = mesh.indices.length / 3;
      const planes = heights.length;
      if (
        !Number.isSafeInteger(vertices) ||
        vertices < 3 ||
        !Number.isSafeInteger(triangles) ||
        triangles < 1 ||
        planes < 1 ||
        planes !== out.length ||
        !Number.isSafeInteger(2 * planes * triangles) ||
        up.length !== 3 ||
        !up.every(Number.isFinite) ||
        !heights.every(Number.isFinite)
      )
        throw floodError(
          'state',
          'Supply an indexed compartment mesh, a finite plane normal, and equal nonempty finite height and volume tables.',
        );
      const projectedAt = verticesAt + mesh.vertices.length * WORD;
      const heightsAt = projectedAt + vertices * WORD;
      const volumesAt = heightsAt + planes * WORD;
      const workAt = volumesAt + planes * WORD;
      const indicesAt = workAt + words.byteLength;
      const pages = Math.ceil((indicesAt + mesh.indices.length * INDEX) / PAGE);
      if (pages > MAX_MEMORY_PAGES)
        throw floodError(
          'state',
          'Use fewer compartment triangles or heights to fit flood volume staging into Wasm memory.',
        );
      try {
        const grow = pages - memory.buffer.byteLength / PAGE;
        if (grow > 0) memory.grow(grow);
      } catch (cause) {
        throw failure('Use a smaller compartment mesh to fit native flood volume memory.', cause);
      }
      const buffer = memory.buffer;
      const target = new Float64Array(buffer, verticesAt, mesh.vertices.length);
      target.set(mesh.vertices);
      // A non-finite coordinate can project to a nonsensical clip; refuse before the worker dispatch.
      if (!target.every(Number.isFinite))
        throw floodError('state', 'Use finite compartment mesh vertices in body-local metres.');
      const indices = new Uint32Array(buffer, indicesAt, mesh.indices.length);
      for (let i = 0; i < indices.length; i++) {
        const value = mesh.indices[i]!;
        if (!Number.isInteger(value) || value < 0 || value >= vertices)
          throw floodError('state', 'Keep each compartment triangle index inside the mesh vertex array.');
        indices[i] = value;
      }
      new Uint32Array(buffer, JOB, 10).set([
        verticesAt,
        indicesAt,
        projectedAt,
        heightsAt,
        volumesAt,
        workAt,
        vertices,
        triangles,
        planes,
        0,
      ]);
      new Float64Array(buffer, JOB + 40, 3).set(up);
      new Float64Array(buffer, heightsAt, planes).set(heights);
      const work = new Float64Array(buffer, workAt, words.length);
      work.fill(0);
      let status: number;
      try {
        status = project(JOB) || (pool ? pool.phase(0, () => phase(JOB, 0, 0, threads)) : phase(JOB, 0, 0, 1));
      } catch (cause) {
        throw failure('Run matching flood volume workers and Wasm, or choose threads: 1.', cause);
      }
      if (status === 1)
        throw floodError(
          'state',
          'Flood volume clipping exceeded finite range. Rescale the body-local compartment mesh.',
        );
      if (status !== 0) throw failure('Use matching flood volume Wasm and work buffers.');
      const pairs = Math.floor(planes / 2);
      for (let part = 0; part < threads; part++) {
        const receipt = report(work, part * WORK_WORDS);
        const count = Math.floor((pairs * (part + 1)) / threads) - Math.floor((pairs * part) / threads);
        const planeCount = 2 * count + Number(part === threads - 1 && planes % 2 !== 0);
        if (
          receipt.projectedVertices !== (part === 0 ? vertices : 0) ||
          receipt.planes !== planeCount ||
          receipt.triangleVisits !== planeCount * triangles ||
          receipt.trianglePairs !== count * triangles ||
          !Number.isSafeInteger(receipt.intersectionPairs) ||
          receipt.intersectionPairs < 0 ||
          receipt.intersectionPairs > 2 * receipt.trianglePairs ||
          !Number.isSafeInteger(receipt.fanPairs) ||
          receipt.fanPairs < 0 ||
          receipt.fanPairs > 2 * receipt.trianglePairs
        )
          throw failure('Rebuild matching flood volume assets to obtain valid native work counts.');
      }
      const accepted = new Float64Array(buffer, volumesAt, planes);
      if (!accepted.every(Number.isFinite))
        throw failure('Use finite compartment clipping geometry and matching native volume assets.');
      out.set(accepted);
      for (let i = 0; i < work.length; i++) {
        words[i]! += work[i]!;
        totals[i % WORK_WORDS]! += work[i]!;
      }
      batches++;
    },
    resetWork() {
      batches = 0;
      words.fill(0);
      totals.fill(0);
    },
    workCounts() {
      return {
        ...report(totals, 0),
        batches,
        threads,
        workers: Array.from({ length: threads }, (_, part) => report(words, part * WORK_WORDS)),
      };
    },
    close,
    [Symbol.dispose]: close,
  };
}
