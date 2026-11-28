import { MargoError } from '@margoengine/math/errors';
import type { NativePhasePool } from '../native-phase-pool.js';
import { isShared, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

const JOB_BYTES = 56;
const HEADER_WORDS = 6;
const RECEIPT_WORDS = 2;
const U32 = Uint32Array.BYTES_PER_ELEMENT;

/**
 * What one participant did in a catenary step: velocity rows, position rows and SIMD node pairs integrated.
 */
export interface RailWireWorkerWork {
  readonly velocityRows: number;
  readonly positionRows: number;
  /** Each visit integrates one lateral and vertical node pair in the two SIMD lanes. */
  readonly simdNodePairs: number;
}

/** Work counts for one catenary step: the thread count plus each participant's `RailWireWorkerWork`. */
export interface RailWireWorkCounts extends RailWireWorkerWork {
  readonly threads: number;
  readonly workers: readonly RailWireWorkerWork[];
}

export interface WireKernel {
  step(
    position: number,
    velocity: number,
    force: number,
    nodes: number,
    intervals: number,
    tensionPerMassSpacingSquared: number,
    inverseMass: number,
    damping: number,
    dt: number,
  ): RailWireWorkCounts;
}

export async function loadWireKernel(memory: WebAssembly.Memory, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  const shared = isShared(memory);
  const url = shared
    ? new URL(/* @vite-ignore */ './rail-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './rail-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      const module = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError('failed', 'You must serve the optional railway solver Wasm from its package URL.');
    const module =
      response.headers.get('content-type')?.split(';')[0] === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(new MargoError('failed', 'Use a SIMD runtime and serve the optional railway solver Wasm.'), {
      cause,
    });
  }
}

function stackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 8, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

export function bindWireKernel(host: SolverHost, module: WebAssembly.Module, pool?: NativePhasePool): WireKernel {
  if (pool && !isShared(host.memory))
    throw new MargoError('unsupported', 'Use worldMemory(true) for catenary workers or choose threads: 1.');
  const threads = pool?.count ?? 1;
  const leaderStack = stackTop(host, 'rail-stack');
  const job = host.allocate('rail-wire-job', JOB_BYTES, 'u32', 1);
  const receipts = host.allocate('rail-wire-receipts', threads * RECEIPT_WORDS * U32, 'u32', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const {
    __stack_pointer: pointer,
    __data_end: dataEnd,
    rail_wire_apply: apply,
    rail_wire_thread_phase: phase,
  } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof apply !== 'function' ||
    typeof phase !== 'function'
  )
    throw new MargoError(
      'failed',
      'You must rebuild the railway solver Wasm with its matching stack, wire and phase exports.',
    );
  pointer.value = leaderStack;
  if (pool) {
    const control = host.allocate('rail-wire-control', pool.controlWords * U32, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, part) => stackTop(host, `rail-wire-stack-${part}`));
    pool.init({ module, memory: host.memory, job: job.byteOffset, control: control.byteOffset, stackTops });
  }

  const ptr = job.byteOffset;
  return {
    step(position, velocity, force, nodes, intervals, c2, inverseMass, damping, dt) {
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, ptr, HEADER_WORDS).set([
        position,
        velocity,
        force,
        receipts.byteOffset,
        nodes,
        intervals,
      ]);
      new Float64Array(buffer, ptr + HEADER_WORDS * U32, 4).set([c2, inverseMass, damping, dt]);
      const status = pool
        ? pool.phase(0, () => phase(ptr, 0, 0, threads)) || pool.phase(1, () => phase(ptr, 1, 0, threads))
        : apply(ptr);
      if (status === 1)
        throw new MargoError(
          'state',
          'Catenary displacement or velocity exceeds finite range. Reduce the contact load or use a smaller step.',
        );
      if (status !== 0)
        throw new MargoError(
          'state',
          'Invalid native catenary step. Increase wire node spacing, reduce stiffness or use a smaller step.',
        );
      const raw = new Uint32Array(buffer, receipts.byteOffset, RECEIPT_WORDS * threads);
      let velocityRows = 0;
      let positionRows = 0;
      const workers = Array.from({ length: threads }, (_, part) => {
        const kicks = raw[RECEIPT_WORDS * part]!;
        const drifts = raw[RECEIPT_WORDS * part + 1]!;
        velocityRows += kicks;
        positionRows += drifts;
        return { velocityRows: kicks, positionRows: drifts, simdNodePairs: kicks + drifts };
      });
      if (positionRows !== nodes - 2 || velocityRows !== positionRows - Math.floor(positionRows / intervals))
        throw new MargoError(
          'failed',
          'Native workers missed catenary nodes. You must rebuild the matching railway assets.',
        );
      return { threads, velocityRows, positionRows, simdNodePairs: velocityRows + positionRows, workers };
    },
  };
}
