import { MargoError } from '@margoengine/math/errors';
import { FORCING_WORDS } from '../hydro/fields.js';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { vortexError } from './errors.js';

const JOB_BYTES = 32;
const WORK_WORDS = 5;

/** A fixed built-in natural vortex profile for the water kernel. */
export interface VortexWaterProfile {
  readonly family: 0 | 1 | 2;
  readonly cx: number;
  readonly cz: number;
  readonly vx: number;
  readonly vz: number;
  readonly radius: number;
  readonly deficit: number;
  readonly shape: number;
  readonly density: number;
  readonly coriolis: number;
  readonly spin: number;
  readonly radial: number;
  readonly tangential: number;
  readonly surface: number;
  readonly height: number;
  readonly roughness: number;
  readonly ground: number;
  readonly decay: number;
  readonly peak: number;
  readonly secondaryRadius: number;
  readonly secondaryWidth: number;
  readonly secondaryStrength: number;
}

/** Grid geometry translated into the vortex's frame at the sampled time. */
export interface VortexWaterGeometry {
  readonly width: number;
  readonly depth: number;
  readonly dx: number;
  readonly dz: number;
  readonly originX: number;
  readonly originZ: number;
  readonly offsetX: number;
  readonly offsetZ: number;
  readonly sampleY: number;
  readonly density: number;
  readonly time: number;
  readonly windStress: boolean;
}

/** Work in an accepted pressure and stress grid partition. */
export interface VortexWaterWorkerWork {
  /** Water rows examined, including dry cells. */
  readonly cells: number;
  readonly wetCells: number;
  /** Four face-pressure samples for each wet cell, measured across both horizontal axes. */
  readonly pressureSamples: number;
  /** Horizontal wind samples used for stress, zero if wind stress is disabled. */
  readonly windSamples: number;
  /** Face-radius results computed by paired f64x2 square roots. */
  readonly pairedRadiusLanes: number;
}

/** Work from the most recent accepted native grid, with the caller at index zero. */
export interface VortexWaterWorkCounts extends VortexWaterWorkerWork {
  readonly threads: number;
  readonly workers: readonly VortexWaterWorkerWork[];
}

export interface VortexWaterBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface VortexWaterKernel {
  apply(water: Float32Array, profile: VortexWaterProfile, geometry: VortexWaterGeometry, out: Float64Array): void;
  workCounts(): VortexWaterWorkCounts | undefined;
}

type Phase = (job: number, stage: number, part: number, parts: number) => number;

export async function loadVortexWaterBuilds(signal?: AbortSignal, threads = 1): Promise<VortexWaterBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw vortexError('Choose 1, 2 or 4 vortex-water native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw vortexError(
      'Use Node or an isolated browser worker for vortex-water helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './vortex-water-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './vortex-water-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Vortex water stress',
        phaseExport: 'vortex_water_thread_phase',
        phase: 'water pressure and stress',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw vortexError(
      'Start vortex-water helpers in Node or an isolated browser worker, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const module = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ module);
      const wasm = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return wasm;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw vortexError(
        `VortexWater Wasm request returned HTTP ${response.status}; serve the vortex-water kernel asset.`,
        'failed',
      );
    const wasm =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return wasm;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw vortexError(
      'VortexWater Wasm failed to load; use a SIMD runtime and serve the optional vortex-water kernel.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindVortexWaterKernel(host: SolverHost, builds: VortexWaterBuilds, cells: number): VortexWaterKernel {
  try {
    return bind(host, builds, cells);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#vortex')) throw cause;
    throw vortexError('Bind the vortex water Wasm and helpers in a compatible world, or choose threads: 1.', 'failed', cause);
  }
}

function bind(host: SolverHost, builds: VortexWaterBuilds, cells: number): VortexWaterKernel {
  const pool = builds.pool;
  const wasm = isShared(host.memory) ? builds.shared : builds.plain;
  if (!wasm)
    throw vortexError(
      pool
        ? 'Use shared world memory for vortex water helpers, or choose threads: 1.'
        : 'Shared vortex water Wasm is unavailable; choose plain world memory.',
      'unsupported',
    );
  if (!Number.isInteger(cells) || cells < 1 || cells * FORCING_WORDS * 8 >= 0x80000000)
    throw vortexError('Use a positive water grid that fits the native arena.');
  const threads = pool?.count ?? 1;
  const stack = host.allocate('vortex-water-stack', STACK_BYTES + 8, 'u8', 1);
  const region = host.allocate('vortex-water-job', JOB_BYTES + threads * WORK_WORDS * 8, 'u8', 1);
  const depths = host.allocate('vortex-water-depths', 4 * cells, 'f32', 1).byteOffset;
  const profileWords = host.allocate('vortex-water-profile', 22 * 8, 'f64', 1).byteOffset;
  const geometryWords = host.allocate('vortex-water-geometry', 9 * 8, 'f64', 1).byteOffset;
  const result = host.allocate('vortex-water-candidate', FORCING_WORDS * cells * 8, 'f64', 1).byteOffset;
  const job = region.byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, __data_end: end, vortex_water_thread_phase } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(end instanceof WebAssembly.Global) ||
    end.value !== 0 ||
    typeof vortex_water_thread_phase !== 'function'
  )
    throw vortexError('Rebuild the slot-free vortex water Wasm with its pressure and stress stage.', 'failed');
  pointer.value = stackTop(stack);
  const phase = vortex_water_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('vortex-water-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate('vortex-water-helper-stack-' + i, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module: wasm, job, control: control.byteOffset, stackTops });
  }

  const accepted = new Float64Array(threads * WORK_WORDS);
  return {
    apply(water, profile, geometry, out) {
      if (geometry.width * geometry.depth !== cells || water.length !== 3 * cells || out.length !== FORCING_WORDS * cells)
        throw vortexError('Match the native vortex water grid and layout-1 field sizes.');
      const buffer = host.memory.buffer;
      const height = new Float32Array(buffer, depths, cells);
      for (let i = 0; i < cells; i++) height[i] = water[3 * i]!;
      new Float64Array(buffer, profileWords, 22).set([
        profile.family, profile.cx, profile.cz, profile.vx, profile.vz, profile.radius, profile.deficit,
        profile.shape, profile.density, profile.coriolis, profile.spin, profile.radial, profile.tangential,
        profile.surface, profile.height, profile.roughness, profile.ground, profile.decay, profile.peak,
        profile.secondaryRadius, profile.secondaryWidth, profile.secondaryStrength,
      ]);
      new Float64Array(buffer, geometryWords, 9).set([
        geometry.dx, geometry.dz, geometry.originX, geometry.originZ, geometry.offsetX, geometry.offsetZ,
        geometry.sampleY, geometry.density, geometry.time,
      ]);
      new Uint32Array(buffer, job, 8).set([
        depths, profileWords, geometryWords, result, work, geometry.width, geometry.depth, Number(geometry.windStress),
      ]);
      const leader = () => phase(job, 0, 0, threads);
      let status: number;
      try {
        status = pool ? pool.phase(0, leader) : leader();
      } catch (cause) {
        throw vortexError('Run matching vortex water helpers and Wasm, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0)
        throw vortexError('Vortex water forcing exceeded its finite range. Use local coordinates and finite physical inputs.', 'failed');
      out.set(new Float64Array(buffer, result, out.length));
      accepted.set(new Float64Array(buffer, work, accepted.length));
    },
    workCounts() {
      const totals = { cells: 0, wetCells: 0, pressureSamples: 0, windSamples: 0, pairedRadiusLanes: 0 };
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        const cells = accepted[at]!;
        const wetCells = accepted[at + 1]!;
        const pressureSamples = accepted[at + 2]!;
        const windSamples = accepted[at + 3]!;
        const pairedRadiusLanes = accepted[at + 4]!;
        totals.cells += cells;
        totals.wetCells += wetCells;
        totals.pressureSamples += pressureSamples;
        totals.windSamples += windSamples;
        totals.pairedRadiusLanes += pairedRadiusLanes;
        return { cells, wetCells, pressureSamples, windSamples, pairedRadiusLanes };
      });
      return totals.cells ? { threads, ...totals, workers } : undefined;
    },
  };
}
