import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';

const JOB = 16;
const CONTROL = 64;
const PAGE = 65_536;
const INPUT_WORDS = 4;
const OUTPUT_WORDS = 10;
const WORK_WORDS = 4;
const WORD = Float64Array.BYTES_PER_ELEMENT;

export interface OutdoorSoundWorkerWork {
  /** Complete acoustic paths integrated by this participant. */
  readonly links: number;
  /** Path samples actually integrated across both legs. */
  readonly samples: number;
  /** SIMD pairs of attenuation bands accumulated over the accepted samples. */
  readonly bandPairs: number;
  /** Atmospheric coefficient sets computed after an adjacent temperature or pressure change within each link. */
  readonly coefficientSets: number;
}

export interface OutdoorSoundWorkCounts extends OutdoorSoundWorkerWork {
  readonly threads: number;
  readonly workers: readonly OutdoorSoundWorkerWork[];
}

export interface OutdoorSoundKernel {
  integrate(
    samples: Float64Array,
    firstCounts: Uint32Array,
    totalCounts: Uint32Array,
    slotsPerLink: number,
    humidity: number,
  ): Float64Array;
  workCounts(): OutdoorSoundWorkCounts | undefined;
  close(): void;
}

function loadFailure(message: string, cause?: unknown): MargoError {
  return Object.assign(new MargoError('failed', message), { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './outdoor-sound-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './outdoor-sound-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok) throw loadFailure(`Outdoor sound kernel HTTP ${response.status}. Serve its shipped Wasm asset.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw loadFailure('Run outdoor sound with Wasm SIMD support and its matching kernel asset.', cause);
  }
}

function memoryFor(threads: number): WebAssembly.Memory {
  try {
    return new WebAssembly.Memory({ initial: threads + 1, maximum: MAX_MEMORY_PAGES, shared: threads > 1 });
  } catch (cause) {
    throw loadFailure('Use a compatible Wasm memory runtime, or choose threads: 1 for outdoor sound.', cause);
  }
}

export async function loadOutdoorKernel({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}): Promise<OutdoorSoundKernel> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw new MargoError('state', 'Use 1, 2 or 4 native outdoor sound participants.');
  const shared = threads > 1;
  const module = await loadModule(shared, signal);
  signal?.throwIfAborted();
  const memory = memoryFor(threads);
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  const { __stack_pointer: stack, __data_end: dataEnd, outdoor_sound_thread_phase: phase } = exports;
  if (
    !(stack instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof phase !== 'function'
  )
    throw loadFailure('Build outdoor sound with its matching native quadrature and stack exports.');
  const apply = phase;
  stack.value = 2 * PAGE;
  let pool: NativePhasePool | undefined;
  if (shared) {
    pool = await createNativePhasePool(threads, {
      subject: 'Outdoor sound',
      phaseExport: 'outdoor_sound_thread_phase',
      phase: 'path quadrature',
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
  let work: OutdoorSoundWorkCounts | undefined;
  const samplesAt = (threads + 1) * PAGE;
  return {
    integrate(samples, firstCounts, totalCounts, slotsPerLink, humidity) {
      if (closed) throw new MargoError('state', 'Load a new outdoor sound solver after disposing this one.');
      const links = totalCounts.length;
      if (
        links === 0 ||
        firstCounts.length !== links ||
        !Number.isSafeInteger(slotsPerLink) ||
        slotsPerLink < 1 ||
        samples.length !== INPUT_WORDS * slotsPerLink * links ||
        !(humidity >= 0 && humidity <= 1)
      )
        throw new MargoError(
          'state',
          'Provide complete outdoor path rows, valid leg counts and humidity from zero to one.',
        );
      if (samples.byteLength > 0x7fff_ffff)
        throw new MargoError(
          'state',
          'Outdoor path samples exceed Wasm slice addressing. Use fewer links or integration intervals.',
        );
      const firstAt = samplesAt + samples.byteLength;
      const totalAt = firstAt + firstCounts.byteLength;
      const outputAt = totalAt + totalCounts.byteLength;
      const workAt = outputAt + OUTPUT_WORDS * links * WORD;
      const pages = Math.ceil((workAt + WORK_WORDS * threads * WORD) / PAGE);
      if (pages > MAX_MEMORY_PAGES)
        throw new MargoError(
          'state',
          'Outdoor path work exceeds Wasm storage. Use fewer links or integration intervals.',
        );
      try {
        const grow = pages - memory.buffer.byteLength / PAGE;
        if (grow > 0) memory.grow(grow);
      } catch (cause) {
        throw loadFailure('Use fewer acoustic links or ray samples to fit the available Wasm memory.', cause);
      }
      const buffer = memory.buffer;
      new Uint32Array(buffer, JOB, 8).set([samplesAt, firstAt, totalAt, outputAt, workAt, links, slotsPerLink, 0]);
      new Float64Array(buffer, JOB + 32, 1)[0] = humidity;
      new Float64Array(buffer, samplesAt, samples.length).set(samples);
      new Uint32Array(buffer, firstAt, links).set(firstCounts);
      new Uint32Array(buffer, totalAt, links).set(totalCounts);
      const status = pool ? pool.phase(0, () => apply(JOB, 0, 0, threads)) : apply(JOB, 0, 0, 1);
      if (status === 1)
        throw new MargoError(
          'state',
          'Outdoor acoustic delay, loss or length exceeds finite range. Reduce path extent or supply finite air conditions.',
        );
      if (status !== 0)
        throw new MargoError(
          'state',
          'Provide valid outdoor acoustic intervals with each first leg contained in its path.',
        );
      const counts = new Float64Array(buffer, workAt, WORK_WORDS * threads);
      let sampleCount = 0;
      let coefficientSets = 0;
      const workers = Array.from({ length: threads }, (_, part) => {
        const start = Math.floor((links * part) / threads);
        const stop = Math.floor((links * (part + 1)) / threads);
        let expectedSamples = 0;
        for (let link = start; link < stop; link++) expectedSamples += totalCounts[link]!;
        const at = part * WORK_WORDS;
        const setCount = counts[at + 3]!;
        if (
          counts[at] !== stop - start ||
          counts[at + 1] !== expectedSamples ||
          counts[at + 2] !== 4 * expectedSamples ||
          !Number.isSafeInteger(setCount) ||
          setCount < 0 ||
          setCount > expectedSamples
        )
          throw loadFailure('Outdoor sound work receipts are invalid. Rebuild the matching native assets.');
        sampleCount += expectedSamples;
        coefficientSets += setCount;
        return {
          links: stop - start,
          samples: expectedSamples,
          bandPairs: expectedSamples * 4,
          coefficientSets: setCount,
        };
      });
      const output = new Float64Array(buffer, outputAt, links * OUTPUT_WORDS).slice();
      work = { threads, links, samples: sampleCount, bandPairs: 4 * sampleCount, coefficientSets, workers };
      return output;
    },
    workCounts() {
      return work;
    },
    close() {
      closed = true;
      pool?.close();
    },
  };
}
