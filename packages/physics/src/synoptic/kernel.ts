import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { synopticError } from './errors.js';

const JOB_WORDS = 6;
const WORK_WORDS = 3;

export interface SynopticKernelBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  readonly threads: 1 | 2 | 4;
  [Symbol.dispose](): void;
}

/** Diagnostic cells published by one native participant. */
export interface SynopticWorkerWork {
  readonly rows: number;
  /** Cells whose temperature and vapour flux diagnostics used both SIMD lanes. */
  readonly pairedRows: number;
  /** Cells using a temperature anomaly from the two-layer solve. */
  readonly layerRows: number;
}

/** Work in the most recent accepted diagnostic publication. The caller is participant zero. */
export interface SynopticWorkCounts extends SynopticWorkerWork {
  readonly threads: number;
  readonly workers: readonly SynopticWorkerWork[];
}

export interface SynopticPublication {
  run(count: number, data: Region, diagnostic: Region, output: Region, layerOutput?: Region): void;
  accept(): void;
  workCounts(): SynopticWorkCounts | undefined;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      const name = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
      url.search = '';
      const module = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw synopticError(`Synoptic Wasm returned HTTP ${response.status}. Serve its optional assets.`, 'failed');
    const module =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw synopticError('Load the optional synoptic Wasm assets on a runtime that supports SIMD.', 'failed', cause);
  }
}

export async function loadSynopticKernels(signal?: AbortSignal, threads: 1 | 2 | 4 = 1): Promise<SynopticKernelBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw synopticError('Choose 1, 2 or 4 native synoptic participants.', 'unsupported');
  const share = canShareMemory();
  if (threads > 1 && !share)
    throw synopticError(
      'Use Node or an isolated browser worker for synoptic helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './synoptic-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    share
      ? compile(new URL(/* @vite-ignore */ './synoptic-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  let pool: NativePhasePool | undefined;
  const close = () => {
    signal?.removeEventListener('abort', close);
    pool?.close();
  };
  try {
    if (threads > 1) {
      pool = await createNativePhasePool(threads, {
        subject: 'Synoptic weather',
        phaseExport: 'synoptic_publish_phase',
        phase: 'regional diagnostics',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, threads, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw synopticError(
      'Start synoptic helpers in Node or an isolated browser worker, or choose threads: 1.',
      cause instanceof MargoError ? cause.code : 'failed',
      cause,
    );
  }
}

function matches(memory: WebAssembly.Memory, region: Region, words: number): boolean {
  return (
    (region.memory ?? memory) === memory &&
    region.type === 'f64' &&
    region.layout === 1 &&
    region.byteLength === 8 * words &&
    region.byteOffset % 8 === 0 &&
    region.byteOffset >= 0 &&
    region.byteOffset <= memory.buffer.byteLength - region.byteLength
  );
}

export function bindSynopticPublication(
  host: SolverHost,
  { threads, pool }: SynopticKernelBuilds,
  module: WebAssembly.Module,
  instance: WebAssembly.Instance,
): SynopticPublication {
  const { memory } = host;
  const { synoptic_publish_phase: phase, __data_end: dataEnd } = instance.exports;
  if (typeof phase !== 'function' || !(dataEnd instanceof WebAssembly.Global) || dataEnd.value !== 0)
    throw synopticError('Rebuild the slot-free synoptic Wasm with the diagnostic publication export.', 'version');
  if (pool && !isShared(memory))
    throw synopticError('Use shared world memory for synoptic helpers, or choose threads: 1.', 'unsupported');

  const job = host.allocate('synoptic-publication-job', 4 * (JOB_WORDS + WORK_WORDS * threads), 'i32', 1).byteOffset;
  const work = job + 4 * JOB_WORDS;
  if (pool) {
    const control = host.allocate('synoptic-publication-control', 4 * pool.controlWords, 'i32', 1).byteOffset;
    const stackTops = Array.from({ length: threads - 1 }, (_, i) => {
      const { byteOffset, byteLength } = host.allocate(`synoptic-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1);
      return Math.floor((byteOffset + byteLength) / 16) * 16;
    });
    try {
      pool.init({ memory, module, job, control, stackTops });
    } catch (cause) {
      pool.close();
      throw synopticError('Bind synoptic helpers to one shared world, or choose threads: 1.', 'failed', cause);
    }
  }

  const accepted = new Uint32Array(WORK_WORDS * threads);
  const own = () => phase(job, 0, 0, threads) as number;
  let ready = false;
  let hasAccepted = false;
  return {
    run(count, data, diagnostic, output, layerOutput) {
      ready = false;
      if (
        !Number.isSafeInteger(count) ||
        count <= 0 ||
        96 * count > 0x7fff_ffff ||
        !matches(memory, data, 5 * count) ||
        !matches(memory, diagnostic, 8 * count + 3) ||
        !matches(memory, output, 12 * count) ||
        (layerOutput && !matches(memory, layerOutput, 5 * count))
      )
        throw synopticError(
          'Allocate matching layout-1 f64 synoptic state, diagnostics and publication banks.',
          'version',
        );
      new Uint32Array(memory.buffer, job, JOB_WORDS).set([
        count,
        data.byteOffset,
        diagnostic.byteOffset,
        output.byteOffset,
        layerOutput?.byteOffset ?? 0,
        work,
      ]);
      let status: number;
      try {
        status = pool ? pool.phase(0, own) : own();
      } catch (cause) {
        throw synopticError('Run compatible synoptic Wasm and helpers, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0)
        throw synopticError(
          'Reduce pressure anomalies, wind or moisture so every regional diagnostic stays finite and pressure stays positive.',
        );
      ready = true;
    },
    accept() {
      if (!ready) throw synopticError('Run a successful diagnostic publication before accepting its work.');
      accepted.set(new Uint32Array(memory.buffer, work, accepted.length));
      ready = false;
      hasAccepted = true;
    },
    workCounts() {
      if (!hasAccepted) return undefined;
      const workers = Array.from({ length: threads }, (_, worker) => {
        const start = WORK_WORDS * worker;
        return { rows: accepted[start]!, pairedRows: accepted[start + 1]!, layerRows: accepted[start + 2]! };
      });
      const total = (key: keyof SynopticWorkerWork) => workers.reduce((sum, worker) => sum + worker[key], 0);
      return { threads, workers, rows: total('rows'), pairedRows: total('pairedRows'), layerRows: total('layerRows') };
    },
  };
}
