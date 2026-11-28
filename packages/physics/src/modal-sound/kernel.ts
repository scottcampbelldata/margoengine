import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { modalSoundError } from './errors.js';

const JOB_WORDS = 6;
const BATCH_BYTES = 16;
const RECEIPT_WORDS = 4;
const U32_MAX = 0xffff_ffff;

export interface ModalSoundBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export type ModalSoundJob = readonly [
  models: number,
  oscillators: number,
  modes: number,
  surface: number,
  drive: number,
  pcm: number,
];

/** Audio-rate work performed by one native participant. */
export interface ModalSoundWorkerWork {
  /** Complete independent tracks rendered to scratch. */
  readonly tracks: number;
  /** Mono PCM samples, summed over the participant's tracks. */
  readonly pcmSamples: number;
  /** Paired real/imaginary modal recurrence updates. */
  readonly modeUpdates: number;
  /** Spatial roughness band rotations across all PCM samples. */
  readonly textureUpdates: number;
}

/** Audio-rate work for the most recent successful block. The caller is worker index zero. */
export interface ModalSoundWorkCounts extends ModalSoundWorkerWork {
  readonly threads: number;
  readonly workers: readonly ModalSoundWorkerWork[];
}

export interface ModalSoundBatch {
  run(samples: number): number;
  workCounts(): ModalSoundWorkCounts | undefined;
}

type Phase = (batch: number, stage: number, part: number, parts: number) => number;

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    let bytes: BufferSource;
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      bytes = await readFile(url, { signal });
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw modalSoundError(
          `Modal sound Wasm request returned HTTP ${response.status}. Serve its optional kernel assets.`,
          'failed',
        );
      bytes = await response.arrayBuffer();
    }
    const module = await WebAssembly.compile(bytes);
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw modalSoundError(
      'Modal sound Wasm failed to load. Use a SIMD-capable runtime and serve the optional kernel assets.',
      'failed',
      cause,
    );
  }
}

export async function loadModalSoundBuilds(signal?: AbortSignal, threads: 1 | 2 | 4 = 1): Promise<ModalSoundBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw modalSoundError('Choose 1, 2 or 4 native modal sound participants.', 'unsupported');
  const sharedMemory = canShareMemory();
  if (threads > 1 && !sharedMemory)
    throw modalSoundError(
      'Use Node or an isolated browser worker for modal sound helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './modal-sound-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    sharedMemory
      ? compile(new URL(/* @vite-ignore */ './modal-sound-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Modal sound',
        phaseExport: 'modal_sound_thread_phase',
        phase: 'audio blocks',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw modalSoundError(
      'Start modal sound helpers in Node or an isolated browser worker, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

function stackTop(region: Region) {
  return Math.floor((region.byteOffset + region.byteLength) / 16) * 16;
}

export function bindModalSoundBatch(
  host: SolverHost,
  builds: ModalSoundBuilds,
  jobs: readonly ModalSoundJob[],
): ModalSoundBatch {
  try {
    return bind(host, builds, jobs);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#modal-sound')) throw cause;
    throw modalSoundError(
      'Bind modal sound Wasm and helpers in a compatible world, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

function bind(host: SolverHost, builds: ModalSoundBuilds, jobs: readonly ModalSoundJob[]): ModalSoundBatch {
  const pool = builds.pool;
  const shared =
    isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
  const module = shared ? builds.shared : builds.plain;
  if (!module)
    throw modalSoundError(
      pool
        ? 'Use shared world memory for modal sound helpers, or choose threads: 1.'
        : 'Shared modal sound Wasm is unavailable. Use plain world memory on this host.',
      'unsupported',
    );
  if (jobs.length === 0 || jobs.length > Math.floor(0x7fff_ffff / (4 * JOB_WORDS)))
    throw modalSoundError('Use a nonempty modal track list that fits the native job bank.', 'unsupported');

  const threads = pool?.count ?? 1;
  const stack = host.allocate('modal-sound-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const batch = host.allocate('modal-sound-batch', BATCH_BYTES + 8 * RECEIPT_WORDS * threads, 'u8', 1).byteOffset;
  const work = batch + BATCH_BYTES;
  const trackRegion = host.allocate('modal-sound-track-jobs', jobs.length * 4 * JOB_WORDS, 'i32', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  if (
    !(exports.__stack_pointer instanceof WebAssembly.Global) ||
    typeof exports.modal_sound_thread_phase !== 'function'
  )
    throw modalSoundError('Rebuild the modal sound Wasm with the track-batch export.', 'version');
  exports.__stack_pointer.value = stackTop(stack);
  const phase = exports.modal_sound_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('modal-sound-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`modal-sound-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module, job: batch, control: control.byteOffset, stackTops });
  }

  const trackWords = new Uint32Array(host.memory.buffer, trackRegion.byteOffset, jobs.length * JOB_WORDS);
  for (const [i, track] of jobs.entries()) trackWords.set(track, i * JOB_WORDS);
  const accepted = new Float64Array(RECEIPT_WORDS * threads);
  let ran = false;
  return {
    run(samples) {
      if (!Number.isInteger(samples) || samples < 0 || samples > U32_MAX) return 1;
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, batch, 4).set([trackRegion.byteOffset, jobs.length, samples, work]);
      const own = () => phase(batch, 0, 0, threads);
      try {
        const status = pool ? pool.phase(0, own) : own();
        if (status !== 0) return status;
      } catch (cause) {
        throw modalSoundError('Run matching modal sound helpers and Wasm, or choose threads: 1.', 'failed', cause);
      }
      accepted.set(new Float64Array(buffer, work, accepted.length));
      ran = true;
      return 0;
    },
    workCounts() {
      if (!ran) return undefined;
      let tracks = 0;
      let pcmSamples = 0;
      let modeUpdates = 0;
      let textureUpdates = 0;
      const workers = Array.from({ length: threads }, (_, i) => {
        const at = i * RECEIPT_WORDS;
        const row = {
          tracks: accepted[at]!,
          pcmSamples: accepted[at + 1]!,
          modeUpdates: accepted[at + 2]!,
          textureUpdates: accepted[at + 3]!,
        };
        tracks += row.tracks;
        pcmSamples += row.pcmSamples;
        modeUpdates += row.modeUpdates;
        textureUpdates += row.textureUpdates;
        return row;
      });
      return { threads, tracks, pcmSamples, modeUpdates, textureUpdates, workers };
    },
  };
}
