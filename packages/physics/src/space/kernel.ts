import type { Vec3 } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { STANDISH_ORBITS } from '../../../shared/standish-orbits.js';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { celestialError } from './errors.js';

const PLANETS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const;
const ELEMENTS = 6;
const PLANET_WORDS = 3;
const WORK_WORDS = 3;
const JOB_BYTES = 24;

export interface CelestialKernelBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  readonly threads: 1 | 2 | 4;
  [Symbol.dispose](): void;
}

/** Planetary work completed by one native participant for one analytic epoch. */
export interface CelestialOrbitWorkerWork {
  readonly planets: number;
  /** Planet rows evaluated with another live f64x2 lane. */
  readonly pairedPlanets: number;
  /** Scalar-equivalent Newton updates to the Kepler equation over both lanes. */
  readonly keplerIterations: number;
}

/** Accepted analytic orbit work. The caller has index zero. */
export interface CelestialOrbitWorkCounts extends CelestialOrbitWorkerWork {
  readonly threads: number;
  readonly workers: readonly CelestialOrbitWorkerWork[];
}

export interface CelestialOrbitKernel {
  /** Table 1 coordinates in metres, Mercury through Neptune including the Earth–Moon barycentre. */
  run(centuries: number): readonly Vec3[];
  accept(): void;
  workCounts(): CelestialOrbitWorkCounts | undefined;
}

type Phase = (job: number, stage: number, part: number, parts: number) => number;

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
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
      throw celestialError(
        `Celestial Wasm returned HTTP ${response.status}. Serve its optional kernel assets.`,
        'failed',
      );
    const module =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw celestialError('Load the celestial Wasm assets on a SIMD-capable runtime.', 'failed', cause);
  }
}

export async function loadCelestialKernels(
  signal?: AbortSignal,
  threads: 1 | 2 | 4 = 1,
): Promise<CelestialKernelBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw celestialError('Choose 1, 2 or 4 native celestial participants.', 'unsupported');
  const share = canShareMemory();
  if (threads !== 1 && !share)
    throw celestialError(
      'Use Node or an isolated browser worker for celestial helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './celestial-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    share
      ? compile(new URL(/* @vite-ignore */ './celestial-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  let pool: NativePhasePool | undefined;
  function close() {
    signal?.removeEventListener('abort', close);
    pool?.close();
  }
  try {
    if (threads !== 1) {
      pool = await createNativePhasePool(threads, {
        subject: 'Celestial ephemeris',
        phaseExport: 'celestial_thread_phase',
        phase: 'analytic planetary orbits',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, threads, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    const code = cause instanceof MargoError ? cause.code : 'failed';
    throw celestialError(
      'Start celestial helpers in Node or an isolated browser worker, or choose threads: 1.',
      code,
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region) {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindCelestialOrbits(host: SolverHost, builds: CelestialKernelBuilds): CelestialOrbitKernel {
  try {
    return bind(host, builds);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#celestial')) throw cause;
    throw celestialError('Bind compatible celestial Wasm and helpers, or choose threads: 1.', 'failed', cause);
  }
}

function bind(host: SolverHost, { plain, shared, pool, threads }: CelestialKernelBuilds): CelestialOrbitKernel {
  const sharedMemory =
    isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
  const module = sharedMemory ? shared : plain;
  if (!module)
    throw celestialError(
      pool
        ? 'Use shared world memory for celestial helpers, or choose threads: 1.'
        : 'Shared celestial Wasm is unavailable. Use plain world memory.',
      'unsupported',
    );

  const stack = host.allocate('celestial-orbit-stack', STACK_BYTES + 8, 'u8', 1);
  const job = host.allocate('celestial-orbit-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1).byteOffset;
  const work = job + JOB_BYTES;
  const table = host.allocate('celestial-orbit-table', 16 * ELEMENTS * PLANETS.length, 'f64', 1).byteOffset;
  const output = host.allocate('celestial-orbit-output', 8 * PLANET_WORDS * PLANETS.length, 'f64', 1).byteOffset;

  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, __data_end: dataEnd, celestial_thread_phase } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof celestial_thread_phase !== 'function'
  )
    throw celestialError('Rebuild the slot-free celestial Wasm with its planetary orbit phase.', 'version');
  pointer.value = stackTop(stack);
  const phase = celestial_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('celestial-orbit-control', 4 * pool.controlWords, 'i32', 1).byteOffset;
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`celestial-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module, job, control, stackTops });
  }

  const coefficients = new Float64Array(host.memory.buffer, table, 2 * ELEMENTS * PLANETS.length);
  for (const [i, name] of PLANETS.entries()) {
    const { at, rate } = STANDISH_ORBITS[name];
    coefficients.set(at, 2 * ELEMENTS * i);
    coefficients.set(rate, 2 * ELEMENTS * i + ELEMENTS);
  }
  new Uint32Array(host.memory.buffer, job, 4).set([table, output, work, 0]);

  const accepted = new Float64Array(WORK_WORDS * threads);
  let ready = false;
  let hasAccepted = false;
  return {
    run(centuries) {
      ready = false;
      const buffer = host.memory.buffer;
      new Float64Array(buffer, job + 16, 1)[0] = centuries;
      const own = () => phase(job, 0, 0, threads);
      let status: number;
      try {
        status = pool ? pool.phase(0, own) : own();
      } catch (cause) {
        throw celestialError('Run matching celestial Wasm and helpers, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0)
        throw celestialError('Use a finite epoch within the 1800–2050 analytic range, or supply a JPL SPK.');
      const result = new Float64Array(buffer, output, PLANET_WORDS * PLANETS.length);
      ready = true;
      return Array.from({ length: PLANETS.length }, (_, i) => {
        const at = i * PLANET_WORDS;
        return [result[at]!, result[at + 1]!, result[at + 2]!];
      });
    },
    accept() {
      if (!ready) return;
      accepted.set(new Float64Array(host.memory.buffer, work, accepted.length));
      hasAccepted = true;
      ready = false;
    },
    workCounts() {
      if (!hasAccepted) return undefined;
      let planets = 0;
      let pairedPlanets = 0;
      let keplerIterations = 0;
      const workers = Array.from({ length: threads }, (_, i) => {
        const at = i * WORK_WORDS;
        const row = { planets: accepted[at]!, pairedPlanets: accepted[at + 1]!, keplerIterations: accepted[at + 2]! };
        planets += row.planets;
        pairedPlanets += row.pairedPlanets;
        keplerIterations += row.keplerIterations;
        return row;
      });
      return { threads, planets, pairedPlanets, keplerIterations, workers };
    },
  };
}
