// The CPU route of `@margoengine/physics/gpu-cloth`: the Rust kernel (packages/physics/cloth-kernel, SIMD on) that runs the
// GPU's passes on the WebGL2 compatibility layer and in Node, loaded once by `GPUCloth.load()`. Each cloth has a memory of
// its own, laid out as a header of byte offsets (cloth-kernel/src/lib.rs, H_*) and the arrays it names.
import { MargoError } from '@margoengine/math/errors';
import type { ClothFrame, ClothTopology } from '../gpu-cloth-sim.js';
import {
  GPU_CLOTH_COLLIDER_FLOATS,
  GPU_CLOTH_SLOT_FLOATS,
  GPU_CLOTH_VERTEX_FLOATS,
  MAX_GPU_CLOTH_COLLIDERS,
  GPU_CLOTH_FRAME_SUBSTEPS,
} from '../gpu-cloth-sim.js';

interface Exports {
  cloth_step(header: number): void;
  cloth_step_part(header: number, thread: number, threads: number): void;
  cloth_surface(header: number): void;
  __stack_pointer: WebAssembly.Global;
}

/** The most threads a cloth steps on. */
export const MAX_CLOTH_THREADS = 64;
/** Control words (i32) of a cloth's threads: the frame's generation, workers done, workers ready, an error flag. */
const GENERATION = 0,
  DONE = 1,
  READY = 2,
  ERROR = 3;

/** Waits until control word `at` reaches `value`: blocking where the thread may (Node, a worker), spinning in a page. */
function waitFor(control: Int32Array, at: number, value: number): void {
  for (let seen = Atomics.load(control, at); seen < value; seen = Atomics.load(control, at)) {
    try {
      Atomics.wait(control, at, seen, 50);
    } catch {
      // A page's main thread may not block: it spins on the load.
    }
  }
}

/** A worker thread of a cloth (cloth/thread.ts). */
interface ClothWorker {
  post(message: object): void;
  end(): void;
}

/** Starts a worker on `cloth/thread.ts`: a module worker in a page, a worker_threads one in Node (unreferenced). */
async function startWorker(): Promise<ClothWorker> {
  const url = new URL(/* @vite-ignore */ './cloth-thread.js', import.meta.url);
  if (typeof globalThis.Worker === 'function') {
    const worker = new globalThis.Worker(url, { type: 'module' });
    return { post: (message) => worker.postMessage(message), end: () => worker.terminate() };
  }
  const name = 'node:worker_threads';
  const { Worker: NodeWorker } = (await import(/* @vite-ignore */ name)) as {
    Worker: new (url: URL) => { postMessage(message: object): void; terminate(): Promise<number>; unref(): void };
  };
  const worker = new NodeWorker(url);
  worker.unref();
  return { post: (message) => worker.postMessage(message), end: () => void worker.terminate() };
}

/**
 * Work a CPU step did, counted by the kernel: substeps, particle updates, edge solves and particle-collider tests; with
 * threads, each thread's particle updates, edge solves and collider tests too (the main thread first).
 */
export interface ClothWork {
  substeps: number;
  particles: number;
  edges: number;
  colliderTests: number;
  threads?: number[];
}

const PAGE = 65536,
  STACK = 65536,
  HEADER_WORDS = 32;
/** The memory's maximum in pages, as every physics kernel declares it (scripts/physics-modules.mjs). */
const MAX_PAGES = 65536;

let compiled: Promise<WebAssembly.Module> | undefined;
let module: WebAssembly.Module | undefined;
let compiledShared: Promise<WebAssembly.Module> | undefined;
let sharedModule: WebAssembly.Module | undefined;
/** Workers started ahead, waiting for a cloth (`loadClothKernel` with threads). */
const idle: ClothWorker[] = [];

/**
 * Compiles the kernel once; later calls share it. With `threads` above 1, also the shared-memory build and that many
 * workers less one, which a cloth of that many threads takes.
 */
export function loadClothKernel(signal?: AbortSignal, threads = 1): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  compiled ??= compile(false).then(
    (m) => (module = m),
    (error: unknown) => {
      compiled = undefined;
      throw error;
    },
  );
  let done: Promise<WebAssembly.Module> = compiled;
  if (threads > 1) {
    if (typeof SharedArrayBuffer !== 'function')
      return Promise.reject(
        new MargoError(
          'unsupported',
          'GPUCloth threads need a SharedArrayBuffer: serve the page cross-origin isolated (COOP and COEP headers) or pass threads: 1. See https://margoengine.com/errors#gpu-cloth',
        ),
      );
    compiledShared ??= compile(true).then(
      (m) => (sharedModule = m),
      (error: unknown) => {
        compiledShared = undefined;
        throw error;
      },
    );
    const workers = (async () => {
      while (idle.length < threads - 1) idle.push(await startWorker());
    })();
    done = Promise.all([compiled, compiledShared, workers]).then(() => module!);
  }
  if (!signal) return done;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    done.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function compile(shared: boolean): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './cloth-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './cloth-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = (await import(/* @vite-ignore */ fs)) as { readFile(u: URL): Promise<Uint8Array> };
      return await WebAssembly.compile((await readFile(url)) as Uint8Array<ArrayBuffer>);
    }
    const response = await fetch(url);
    if (!response.ok)
      throw new MargoError(
        'failed',
        'Serve the GPU cloth CPU kernel (cloth-kernel.wasm) from its package URL. See https://margoengine.com/errors#gpu-cloth',
      );
    return response.headers.get('content-type')?.split(';')[0] === 'application/wasm'
      ? await WebAssembly.compileStreaming(response)
      : await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'Use a runtime with WebAssembly SIMD and serve cloth-kernel.wasm. See https://margoengine.com/errors#gpu-cloth',
      ),
      { cause },
    );
  }
}

/** Whether {@link loadClothKernel} has finished. */
export const clothKernelLoaded = (): boolean => module !== undefined;

/**
 * One cloth's kernel instance and memory. With `threads` above 1 the memory is shared and `threads - 1` workers (taken from
 * those `loadClothKernel` started) each run their share of every pass of every frame, the main thread the first share
 * (cloth-kernel/src/lib.rs, `cloth_step_part`): a static schedule, so the same bits at any thread count.
 */
export class ClothKernel {
  private readonly memory: WebAssembly.Memory;
  private readonly exports: Exports;
  private readonly at: Record<string, number> = {};
  private sdfCapacity = 0;
  private readonly count: number;
  private readonly threads: number;
  private readonly workers: ClothWorker[] = [];
  private generation = 0;

  constructor(topology: ClothTopology, threads = 1) {
    if (!module)
      throw new MargoError(
        'state',
        'Call await GPUCloth.load() once before making a GPUCloth. See https://margoengine.com/errors#gpu-cloth',
      );
    if (threads > 1 && (!sharedModule || idle.length < threads - 1))
      throw new MargoError(
        'state',
        `Call await GPUCloth.load(signal, ${threads}) before making a GPUCloth of ${threads} threads. See https://margoengine.com/errors#gpu-cloth`,
      );
    const N = topology.count;
    this.count = N;
    this.threads = threads;
    // A stack each thread, then the fixed regions, then the sdf samples last so they can grow.
    const sizes: [string, number][] = [
      ['header', HEADER_WORDS * 4],
      ['work', 16 * threads],
      ['control', 32],
      ['state', N * 48],
      ['normals', N * 16],
      ['vertices', N * GPU_CLOTH_VERTEX_FLOATS * 4],
      ['edges', topology.edges.byteLength],
      ['colors', Math.max(1, topology.colors.length) * 8],
      ['adjacency', topology.adjacency.byteLength],
      ['triangles', topology.triangles.byteLength],
      ['uvs', topology.uvs.byteLength],
      ['slots', GPU_CLOTH_FRAME_SUBSTEPS * GPU_CLOTH_SLOT_FLOATS * 4],
      ['pins', N * 32],
      ['colliders', MAX_GPU_CLOTH_COLLIDERS * GPU_CLOTH_COLLIDER_FLOATS * 4],
      ['tethers', N * 8],
    ];
    let end = STACK * threads;
    for (const [name, bytes] of sizes) {
      this.at[name] = end;
      end += Math.ceil(Math.max(4, bytes) / 16) * 16;
    }
    this.at.sdf = end;
    const shared = threads > 1;
    this.memory = new WebAssembly.Memory({ initial: Math.ceil((end + 16) / PAGE), maximum: MAX_PAGES, shared });
    const { exports } = new WebAssembly.Instance(shared ? sharedModule! : module, { env: { memory: this.memory } });
    this.exports = exports as unknown as Exports;
    if (!(this.exports.__stack_pointer instanceof WebAssembly.Global))
      throw new MargoError(
        'failed',
        'Build cloth-kernel.wasm with its exported stack pointer. See https://margoengine.com/errors#gpu-cloth',
      );
    this.exports.__stack_pointer.value = STACK;
    const u = this.u32('header', HEADER_WORDS);
    u.set([
      N,
      this.at.state!,
      this.at.normals!,
      this.at.vertices!,
      this.at.edges!,
      this.at.colors!,
      topology.colors.length,
      this.at.adjacency!,
      this.at.triangles!,
      this.at.uvs!,
      this.at.slots!,
      0,
      1,
      this.at.pins!,
      0,
      this.at.colliders!,
      0,
      this.at.sdf!,
      0,
      this.at.work!,
      topology.triangles.length / 3,
      this.at.control! + 16,
    ]);
    // The barrier (two words) lies in the control region, after the generation, done, ready and error words.
    for (let k = 1; k < threads; k++) {
      const worker = idle.pop()!;
      worker.post({
        module: sharedModule,
        memory: this.memory,
        stack: STACK * (k + 1),
        header: this.at.header,
        control: this.at.control,
        index: k,
        threads,
      });
      this.workers.push(worker);
    }
    this.u32('edges', topology.edges.length).set(topology.edges);
    this.u32('colors', topology.colors.length * 2).set(topology.colors.flat());
    this.u32('adjacency', topology.adjacency.length).set(topology.adjacency);
    this.u32('triangles', topology.triangles.length).set(topology.triangles);
    this.f32('uvs', topology.uvs.length).set(topology.uvs);
  }

  private f32(name: string, length: number): Float32Array {
    return new Float32Array(this.memory.buffer, this.at[name]!, length);
  }
  private u32(name: string, length: number): Uint32Array {
    return new Uint32Array(this.memory.buffer, this.at[name]!, length);
  }

  /** Runs `frame` on `state` (12 N floats), `normals` (4 N) and `vertices` in place, and returns the work it did. */
  step(
    state: Float32Array,
    normals: Float32Array,
    vertices: Float32Array,
    frame: ClothFrame,
    tethers?: Uint32Array,
  ): ClothWork {
    const N = this.count;
    if (frame.sdf.byteLength > this.sdfCapacity) {
      const need = this.at.sdf! + frame.sdf.byteLength + 16;
      if (need > this.memory.buffer.byteLength)
        this.memory.grow(Math.ceil((need - this.memory.buffer.byteLength) / PAGE));
      this.sdfCapacity = frame.sdf.byteLength;
    }
    this.f32('state', 12 * N).set(state);
    this.f32('normals', 4 * N).set(normals);
    this.f32('slots', frame.slotCount * GPU_CLOTH_SLOT_FLOATS).set(
      frame.slots.subarray(0, frame.slotCount * GPU_CLOTH_SLOT_FLOATS),
    );
    this.f32('pins', frame.pinCount * 8).set(frame.pins.subarray(0, frame.pinCount * 8));
    this.f32('colliders', frame.colliderCount * GPU_CLOTH_COLLIDER_FLOATS).set(
      frame.colliders.subarray(0, frame.colliderCount * GPU_CLOTH_COLLIDER_FLOATS),
    );
    if (frame.sdf.length > 1) this.f32('sdf', frame.sdf.length).set(frame.sdf);
    if (tethers) this.u32('tethers', 2 * N).set(tethers);
    const h = this.u32('header', HEADER_WORDS);
    h[11] = frame.slotCount;
    h[12] = frame.substeps;
    h[14] = frame.pinCount;
    h[16] = frame.colliderCount;
    h[18] = tethers ? this.at.tethers! : 0;
    if (this.threads === 1) this.exports.cloth_step(this.at.header!);
    else this.parallel();
    state.set(this.f32('state', 12 * N));
    normals.set(this.f32('normals', 4 * N));
    vertices.set(this.f32('vertices', vertices.length));
    const words = this.u32('work', 4 * this.threads),
      work: ClothWork = { substeps: words[0]!, particles: 0, edges: 0, colliderTests: 0 };
    if (this.threads > 1) work.threads = [];
    for (let k = 0; k < this.threads; k++) {
      work.particles += words[4 * k + 1]!;
      work.edges += words[4 * k + 2]!;
      work.colliderTests += words[4 * k + 3]!;
      work.threads?.push(words[4 * k + 1]! + words[4 * k + 2]! + words[4 * k + 3]!);
    }
    return work;
  }

  /** One frame on every thread: the workers are started with the frame's generation, the main thread runs its share. */
  private parallel(): void {
    const control = new Int32Array(this.memory.buffer, this.at.control!, 4);
    waitFor(control, READY, this.threads - 1);
    Atomics.store(control, DONE, 0);
    this.generation++;
    Atomics.store(control, GENERATION, this.generation);
    Atomics.notify(control, GENERATION);
    this.exports.cloth_step_part(this.at.header!, 0, this.threads);
    waitFor(control, DONE, this.threads - 1);
    if (Atomics.load(control, ERROR) !== 0)
      throw new MargoError(
        'failed',
        'A GPUCloth worker thread stopped; make the cloth again. See https://margoengine.com/errors#gpu-cloth',
      );
  }

  /** Ends the cloth's worker threads. */
  dispose(): void {
    for (const worker of this.workers.splice(0)) worker.end();
  }

  /** The surface pass alone: writes `vertices`, and `normals` when given (else they are worked out and dropped). */
  surface(state: Float32Array, normals: Float32Array, vertices: Float32Array, keepNormals: boolean): void {
    const N = this.count;
    this.f32('state', 12 * N).set(state.subarray(0, 12 * N));
    this.f32('normals', 4 * N).set(normals);
    this.exports.cloth_surface(this.at.header!);
    if (keepNormals) normals.set(this.f32('normals', 4 * N));
    vertices.set(this.f32('vertices', vertices.length));
  }
}
