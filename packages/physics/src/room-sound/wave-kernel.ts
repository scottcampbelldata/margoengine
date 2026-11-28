import { MargoError } from '@margoengine/math/errors';
import type { NativePhasePool } from '../native-phase-pool.js';
import { isShared, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

const HEADER_WORDS = 12;
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const JOB_BYTES = HEADER_WORDS * U32 + F64;

export interface RoomWaveWorkerWork {
  /** Number of acoustic samples in which this participant ran its assigned slab range. */
  readonly samples: number;
  /** Number of pairs of acoustic grid rows evaluated by the SIMD stencil. */
  readonly pairs: number;
}

export interface RoomWaveWorkCounts extends RoomWaveWorkerWork {
  readonly threads: number;
  readonly workers: readonly RoomWaveWorkerWork[];
}

export interface RoomWaveKernel {
  step(
    current: number,
    previous: number,
    coefficients: number,
    input: number,
    trace: number,
    n: number,
    row: number,
    plane: number,
    source: number,
    receiver: number,
    samples: number,
    lambdaSquared: number,
  ): RoomWaveWorkCounts;
}

function allocateStackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 8, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

function accept(status: number): void {
  if (status === 1)
    throw new MargoError(
      'state',
      'Acoustic pressure exceeds finite range. Reduce the initial pressure or source amplitude.',
    );
  if (status !== 0)
    throw new MargoError('failed', 'Invalid acoustic stencil job. Rebuild or serve the matching room sound assets.');
}

export function bindRoomWaveKernel(
  host: SolverHost,
  module: WebAssembly.Module,
  pool?: NativePhasePool,
): RoomWaveKernel {
  if (pool && !isShared(host.memory))
    throw new MargoError('unsupported', 'Use worldMemory(true) for room acoustic workers or choose threads: 1.');
  const threads = pool?.count ?? 1;
  const leaderStack = allocateStackTop(host, 'room-wave-stack');
  const job = host.allocate('room-wave-job', JOB_BYTES, 'u32', 1);
  const receipts = host.allocate('room-wave-receipts', 2 * threads * F64, 'f64', 2);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const {
    __stack_pointer: pointer,
    __data_end: dataEnd,
    acoustic_wave_apply: apply,
    acoustic_wave_thread_phase: phase,
    acoustic_wave_finish_sample: finish,
  } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof apply !== 'function' ||
    typeof phase !== 'function' ||
    typeof finish !== 'function'
  )
    throw new MargoError('failed', 'Rebuild the room sound Wasm with its matching stack and pressure stencil exports.');
  pointer.value = leaderStack;
  const address = job.byteOffset;
  if (pool) {
    const control = host.allocate('room-wave-control', pool.controlWords * U32, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, part) =>
      allocateStackTop(host, `room-wave-stack-${part}`),
    );
    pool.init({ module, memory: host.memory, job: address, control: control.byteOffset, stackTops });
  }

  return {
    step(current, previous, coefficients, input, trace, n, row, plane, source, receiver, samples, lambdaSquared) {
      const pairsPerSample = (n - 2 * plane) / 2;
      const expectedPairs = pairsPerSample * samples;
      if (!Number.isSafeInteger(expectedPairs))
        throw new MargoError(
          'state',
          'Acoustic work exceeds the exact integer range. Reduce the grid or sample count.',
        );
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, address, HEADER_WORDS).set([
        current,
        previous,
        coefficients,
        input,
        trace,
        receipts.byteOffset,
        n,
        row,
        plane,
        source,
        receiver,
        samples,
      ]);
      new Float64Array(buffer, address + HEADER_WORDS * U32, 1)[0] = lambdaSquared;
      const raw = new Float64Array(buffer, receipts.byteOffset, 2 * threads);
      if (pool) {
        if (samples === 0) raw.fill(0);
        for (let sample = 0; sample < samples; sample++) {
          accept(pool.phase(sample, () => phase(address, sample, 0, threads)));
          accept(finish(address, sample));
        }
      } else {
        accept(apply(address));
      }
      const workers = Array.from({ length: threads }, (_, part) => {
        const perSample =
          Math.floor(((part + 1) * pairsPerSample) / threads) - Math.floor((part * pairsPerSample) / threads);
        const seen = raw[2 * part]!;
        const pairs = raw[2 * part + 1]!;
        if (seen !== samples || pairs !== perSample * samples)
          throw new MargoError(
            'failed',
            'Native workers missed acoustic cells. Rebuild the matching room sound assets.',
          );
        return { samples: seen, pairs };
      });
      return { threads, samples, pairs: expectedPairs, workers };
    },
  };
}
