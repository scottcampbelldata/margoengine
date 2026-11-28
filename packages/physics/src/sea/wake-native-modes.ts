import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';

const PAGE = 65_536;
const JOB = 16;
const JOB_BYTES = 48;
const CONTROL = JOB + JOB_BYTES;
const RECEIPT_WORDS = 2;
const WORD_BYTES = Float64Array.BYTES_PER_ELEMENT;

export interface WakeModeBuilds {
  readonly module: WebAssembly.Module;
  readonly threads: 1 | 2 | 4;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

/** Nonzero-wavenumber modes propagated by one native participant. */
export interface WakeNativeWorkerWork {
  readonly modes: number;
  /** Physical complex modes whose real and imaginary components ran together in f64x2 lanes. */
  readonly pairedModes: number;
}

/** Work contributed to the most recent accepted wake tick. The caller is participant zero. */
export interface WakeNativeWorkCounts extends WakeNativeWorkerWork {
  readonly threads: number;
  readonly workers: readonly WakeNativeWorkerWork[];
}

export interface WakeNativeModes {
  /** Native-owned interleaved half spectra in height, pressure and potential order. */
  readonly spectra: [Float64Array, Float64Array, Float64Array];
  prepareGravity(
    vertical: Float64Array,
    cosine: Float64Array,
    over: Float64Array,
    times: Float64Array,
    level: number,
  ): void;
  prepareCurrent(vertical: Float64Array, natural: Float64Array, coefficients: Float64Array): void;
  advance(): void;
  accept(): void;
  workCounts(): WakeNativeWorkCounts | undefined;
  close(): void;
}

function modeError(message: string, code: 'state' | 'failed' | 'unsupported' | 'version' = 'state', cause?: unknown) {
  const error = new MargoError(code, `${message} See https://margoengine.com/errors#physics-wake`);
  return cause === undefined ? error : Object.assign(error, { cause });
}

async function sharedModule(signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = new URL(/* @vite-ignore */ './wake-fft-shared.wasm?no-inline', import.meta.url);
  if (url.protocol === 'file:') {
    url.search = '';
    const fs = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw modeError(`Wake mode Wasm returned HTTP ${response.status}. Serve its optional asset.`, 'failed');
  return response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
    ? WebAssembly.compileStreaming(response)
    : WebAssembly.compile(await response.arrayBuffer());
}

export async function loadWakeModes(
  plain: WebAssembly.Module,
  threads: 1 | 2 | 4 = 1,
  signal?: AbortSignal,
): Promise<WakeModeBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw modeError('Choose 1, 2 or 4 native wake participants.', 'unsupported');
  if (threads === 1) return { module: plain, threads, [Symbol.dispose]() {} };
  let pool: NativePhasePool | undefined;
  const close = () => {
    signal?.removeEventListener('abort', close);
    pool?.close();
  };
  try {
    const module = await sharedModule(signal);
    signal?.throwIfAborted();
    pool = await createNativePhasePool(threads, {
      subject: 'Wake modes',
      phaseExport: 'wake_mode_phase',
      phase: 'modal propagation',
      signal,
    });
    signal?.addEventListener('abort', close, { once: true });
    signal?.throwIfAborted();
    return { module, threads, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw modeError('Start wake helpers in Node or an isolated browser worker, or choose threads: 1.', 'failed', cause);
  }
}

export function bindWakeModes(
  builds: WakeModeBuilds,
  count: number,
  extended: boolean,
  instance?: WebAssembly.Instance,
): WakeNativeModes {
  try {
    return bind(builds, count, extended, instance);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#physics-wake')) throw cause;
    throw modeError('Bind the matching wake mode Wasm and use a smaller grid if memory is exhausted.', 'failed', cause);
  }
}

function bind(builds: WakeModeBuilds, count: number, extended: boolean, fft?: WebAssembly.Instance): WakeNativeModes {
  const { module, threads, pool } = builds;
  const words = count * (extended ? 16 : 10) + threads + JOB_BYTES / WORD_BYTES;
  if (!Number.isSafeInteger(count) || count < 1 || words * WORD_BYTES > 0x7fff_ffff)
    throw modeError('Choose a wake grid whose half spectra and coefficients fit the native arena.');

  let instance: WebAssembly.Instance;
  let memory: WebAssembly.Memory;
  let job: number;
  let receipt: number;
  if (pool) {
    const stackPages = threads + 1;
    const pages = stackPages + Math.ceil((words * WORD_BYTES) / PAGE);
    if (pages > MAX_MEMORY_PAGES) throw modeError('Use a smaller wake grid to fit the shared mode bank.');
    memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
    instance = new WebAssembly.Instance(module, { env: { memory } });
    const { __stack_pointer: stack, __data_end: dataEnd } = instance.exports;
    if (!(stack instanceof WebAssembly.Global) || !(dataEnd instanceof WebAssembly.Global) || dataEnd.value !== 0)
      throw modeError('Rebuild the slot-free shared wake modes.', 'version');
    stack.value = 2 * PAGE;
    job = JOB;
    receipt = stackPages * PAGE;
  } else {
    instance = fft ?? new WebAssembly.Instance(module);
    const { memory: ownMemory, wake_mode_buffer: reserve } = instance.exports;
    if (!(ownMemory instanceof WebAssembly.Memory) || typeof reserve !== 'function')
      throw modeError('Rebuild the private wake FFT with the modal workspace export.', 'version');
    memory = ownMemory;
    job = reserve(words) as number;
    if (!job) throw modeError('Reduce wave grid dimensions to fit the native mode workspace.');
    receipt = job + JOB_BYTES;
  }
  const { wake_mode_phase: phase } = instance.exports;
  if (typeof phase !== 'function') throw modeError('Rebuild the wake Wasm with the modal phase export.', 'version');
  if (pool) {
    pool.init({
      memory,
      module,
      job,
      control: CONTROL,
      stackTops: Array.from({ length: threads - 1 }, (_, i) => (i + 3) * PAGE),
    });
  }

  // Initializing the private FFT may grow its memory. The caller has already
  // initialized that plan before allocating these views, and transforms do not grow it.
  const buffer = memory.buffer;
  let next = receipt + 4 * RECEIPT_WORDS * threads;
  const reserve = (length: number) => {
    const view = new Float64Array(buffer, next, length);
    next += WORD_BYTES * length;
    return view;
  };
  const spectra: WakeNativeModes['spectra'] = [reserve(2 * count), reserve(2 * count), reserve(2 * count)];
  const vertical = reserve(count);
  const first = reserve((extended ? 8 : 1) * count);
  const second = reserve(count);
  const third = extended ? undefined : reserve(count);
  const level = new Float64Array(buffer, job + 40, 1);
  new Uint32Array(buffer, job, 10).set([
    spectra[0].byteOffset,
    spectra[1].byteOffset,
    spectra[2].byteOffset,
    vertical.byteOffset,
    first.byteOffset,
    second.byteOffset,
    third?.byteOffset ?? 0,
    count,
    receipt,
    Number(extended),
  ]);

  const accepted = new Uint32Array(RECEIPT_WORDS * threads);
  const own = () => phase(job, 0, 0, threads) as number;
  let configured = false;
  let ready = false;
  let hasAccepted = false;
  let closed = false;
  const close = () => {
    closed = true;
    builds[Symbol.dispose]();
  };
  function verify(): void {
    // The private shared arena has equal initial and maximum lengths. A
    // helper can expose a different SharedArrayBuffer wrapper for the same bytes.
    if (closed || (!pool && memory.buffer !== buffer))
      throw modeError('Use a live wake mode plan without resizing its initialized FFT workspace.');
  }
  return {
    spectra,
    prepareGravity(k, c, so, st, equilibrium) {
      verify();
      if (
        !third ||
        k.length !== count ||
        c.length !== count ||
        so.length !== count ||
        st.length !== count ||
        !Number.isFinite(equilibrium)
      )
        throw modeError('Use matching finite gravity modal coefficients and the full half-spectrum grid.');
      vertical.set(k);
      first.set(c);
      second.set(so);
      third.set(st);
      level[0] = equilibrium;
      configured = true;
    },
    prepareCurrent(k, omega, coefficients) {
      verify();
      if (!extended || k.length !== count || omega.length !== count || coefficients.length !== 8 * count)
        throw modeError(
          'Use matching current, capillary and gravity modal coefficients for the full half-spectrum grid.',
        );
      vertical.set(k);
      first.set(coefficients);
      second.set(omega);
      configured = true;
    },
    advance() {
      ready = false;
      verify();
      if (!configured) throw modeError('Prepare the modal coefficients for this wake step before propagating waves.');
      let status: number;
      try {
        status = pool ? pool.phase(0, own) : own();
      } catch (cause) {
        throw modeError('Run compatible wake Wasm and helpers, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0)
        throw modeError('Reduce wave heights, pressure or time scale so modal propagation stays finite.');
      ready = true;
    },
    accept() {
      if (!ready) throw modeError('Advance the wake successfully before accepting its mode receipt.');
      accepted.set(new Uint32Array(buffer, receipt, accepted.length));
      ready = false;
      hasAccepted = true;
    },
    workCounts() {
      if (!hasAccepted) return undefined;
      const workers = Array.from({ length: threads }, (_, part) => ({
        modes: accepted[2 * part]!,
        pairedModes: accepted[2 * part + 1]!,
      }));
      return {
        threads,
        modes: workers.reduce((sum, row) => sum + row.modes, 0),
        pairedModes: workers.reduce((sum, row) => sum + row.pairedModes, 0),
        workers,
      };
    },
    close,
  };
}
