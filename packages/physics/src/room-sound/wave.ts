import { MargoError } from '@margoengine/math/errors';
import type { NativePhasePool } from '../native-phase-pool.js';
import {
  canShareMemory,
  type FieldDescriptor,
  type FieldUse,
  isShared,
  regionWords,
  type Port,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
  BASE_RATE,
  MAX_MEMORY_PAGES,
} from '../world/index.js';
import { bindRoomWaveKernel, type RoomWaveWorkCounts } from './wave-kernel.js';

const BYTES = Float64Array.BYTES_PER_ELEMENT;
const LAYOUT = 1;
const ROOT_THREE = Math.sqrt(3);
const METER_SOUND_SPEED = 343;

/** Integer x, y, z of an acoustic cell, with y up. */
export type AcousticVoxel = readonly [number, number, number];

/** Cubic air cells, x fastest, then y and z. Air may occupy any connected or disconnected volume. */
export interface AcousticGrid {
  /** Number of voxels along the x, y and z axes. */
  readonly dimensions: AcousticVoxel;
  /** Voxel edge length, metres. */
  readonly spacing: number;
  /** Mask, 1 for air and 0 for solid. Default is air throughout the supplied bounds. */
  readonly air?: ArrayLike<number>;
  /** Pressure reflection coefficient of the closed faces around each air cell. Default 0.85. */
  readonly reflection?: number | ArrayLike<number>;
}

/** Load settings including an optional world field for pressure source samples. */
export interface RoomSoundOptions {
  /** Unique world solver id. Default 'roomSound'. */
  readonly id?: string;
  /** Read layout-1 f64 pressure increments in Pa from {@link RoomSoundSolver.excitationField}. */
  readonly excitation?: boolean;
  /** Native participants including the caller. Defaults to 1. */
  readonly threads?: number;
  /** Cancels loading the optional Wasm binaries. */
  readonly signal?: AbortSignal;
}

/** Geometry, physical properties and a monopole location for the room pressure update. */
export interface RoomSoundParams {
  readonly grid: AcousticGrid;
  readonly source: AcousticVoxel;
  readonly receiver: AcousticVoxel;
  /** Uniform speed of sound in m/s. Default 343. */
  readonly speedOfSound?: number;
  /** Spatially uniform amplitude loss rate in s⁻¹. Default zero. */
  readonly airDamping?: number;
  /** Initial pressure sampled in logical x-fast cells, in Pa. Default zero. */
  readonly initialPressure?: ArrayLike<number>;
  /** Pressure increment added in the first internal sample, Pa. Default 1 for a passive impulse, 0 with excitation. */
  readonly impulse?: number;
}

/** The samples produced by the previous world step in Pa. */
export interface RoomSoundTrace {
  /** Native samples per second, a dyadic multiple of 60 Hz. */
  readonly sampleRate: number;
  /** One-based absolute sample index of values[0], starting when this solver was added. */
  readonly firstSample: number;
  readonly values: Float64Array;
}

interface RoomState {
  host: SolverHost;
  native: ReturnType<typeof bindRoomWaveKernel>;
  pressure: readonly [Region, Region];
  candidatePressure: readonly [Region, Region];
  clock: Region;
  trace: Region;
  candidateTrace: Region;
  coefficients: Region;
  forcing: Region;
  volume: number;
  row: number;
  plane: number;
  source: number;
  receiver: number;
  dimensions: AcousticVoxel;
  impulse: number;
  steps: number;
  lambda2: number;
}

function invalid(message: string): MargoError {
  return new MargoError('state', message);
}

function finite(value: number, label: string, min = -Infinity, max = Infinity): number {
  if (!(Number.isFinite(value) && value >= min && value <= max))
    throw invalid(`Choose finite room sound ${label} between ${min} and ${max}.`);
  return value;
}

function dimensions(grid: AcousticGrid): AcousticVoxel {
  const d = grid?.dimensions;
  if (d?.length !== 3 || ![d[0], d[1], d[2]].every((v) => Number.isSafeInteger(v) && v >= 1))
    throw invalid('Provide three positive integer voxel counts for the acoustic grid.');
  return [d[0], d[1], d[2]];
}

function index(pos: AcousticVoxel, d: AcousticVoxel, description: string): number {
  if (pos?.length !== 3 || ![pos[0], pos[1], pos[2]].every((v, i) => Number.isSafeInteger(v) && v >= 0 && v < d[i]!))
    throw invalid(`Set the room sound ${description} inside its acoustic grid.`);
  return pos[0] + d[0] * (pos[1] + d[1] * pos[2]);
}

function offsets(p: AcousticVoxel, row: number, plane: number): number {
  return p[0] + 1 + row * (p[1] + 1) + plane * (p[2] + 1);
}

function regionData(s: Pick<RoomState, 'host'>, region: Region): Float64Array {
  return regionWords(s.host.memory, region) as Float64Array;
}

function descriptor(name: string, kind: FieldDescriptor['kind'], quantity: string): FieldDescriptor {
  return { name, kind, quantity, unit: 'Pa', centring: 'cell' };
}

async function load(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  try {
    if (url.protocol === 'file:') {
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      url.search = '';
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new MargoError(
        'failed',
        `Room sound kernel HTTP ${response.status}. Use the Wasm file shipped with this entry.`,
      );
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError('failed', 'Room sound could not load its kernel. Use a SIMD runtime and serve its Wasm assets.'),
      { cause },
    );
  }
}

/** A linear room pressure field with reflecting and absorptive walls, diffraction and receiver traces. */
export class RoomSoundSolver implements Solver<RoomSoundParams> {
  readonly id: string;
  /** Layout-1 f64 pressure increments: either one impulse or one per internal sample. */
  readonly excitationField: FieldDescriptor;
  /** Layout-1 f64 most recent pressure samples, in increasing time order. */
  readonly traceField: FieldDescriptor;
  /** Layout-1 f64 grid, x fastest, including one ghost layer and even X stride as reported by pressureLayout. */
  readonly pressureField: FieldDescriptor;
  #state?: RoomState;
  #pool?: NativePhasePool;
  #work?: RoomWaveWorkCounts;
  #disposed = false;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    private readonly excitation: boolean,
    id: string,
  ) {
    if (typeof id !== 'string' || id.length === 0) throw invalid('Choose a nonempty room sound solver id.');
    this.id = id;
    this.excitationField = descriptor(`${id}:excitation`, 'scalarSeries', 'acousticPressureIncrement');
    this.traceField = descriptor(`${id}:trace`, 'scalarSeries', 'acousticReceiverPressure');
    this.pressureField = descriptor(`${id}:pressure`, 'uniformGrid', 'acousticPressure');
  }

  /** Load the native room-sound entry and optional shared-memory helpers. */
  static load({ id, excitation, signal }?: RoomSoundOptions): Promise<RoomSoundSolver>;
  static async load(options: RoomSoundOptions = {}): Promise<RoomSoundSolver> {
    if (!options || typeof options !== 'object') throw invalid('Pass a room sound options object or omit it.');
    const { id = 'roomSound', excitation = false, signal, threads = 1 } = options;
    if (threads !== 1 && threads !== 2 && threads !== 4) throw invalid('Use 1, 2 or 4 native room sound participants.');
    const [plain, shared] = await Promise.all([
      load(new URL(/* @vite-ignore */ './room-sound-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? load(new URL(/* @vite-ignore */ './room-sound-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    const solver = new RoomSoundSolver(plain, shared, excitation, id);
    if (threads > 1) {
      if (!shared)
        throw new MargoError('unsupported', 'Room sound helpers need shared memory. Use threads: 1 on this host.');
      const { createNativePhasePool } = await import('../native-phase-pool.js');
      solver.#pool = await createNativePhasePool(threads, {
        subject: 'Room acoustics',
        phaseExport: 'acoustic_wave_thread_phase',
        phase: 'pressure stencil',
        signal,
      });
    }
    return solver;
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = [
      { field: this.traceField, access: 'write' },
      { field: this.pressureField, access: 'write' },
    ];
    if (this.excitation) fields.push({ field: this.excitationField, access: 'read' });
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, params: RoomSoundParams): void {
    if (this.#disposed) throw new MargoError('disposed', 'Room sound solver is disposed. Load a new solver.');
    if (this.#state) throw new MargoError('attached', 'Load a new room sound solver for each world.');
    if (!params) throw invalid('Provide a room grid, source and receiver.');
    const { grid, source, receiver, initialPressure } = params;
    const d = dimensions(grid);
    const count = d[0] * d[1] * d[2];
    const row = d[0] + 2 + (d[0] % 2);
    const plane = row * (d[1] + 2);
    const volume = plane * (d[2] + 2);
    const { air } = grid;
    const reflection = grid.reflection ?? 0.85;
    const speed = finite(params.speedOfSound ?? METER_SOUND_SPEED, 'speed of sound', Number.MIN_VALUE);
    const spacing = finite(grid.spacing, 'spacing', Number.MIN_VALUE);
    const airLoss = finite(params.airDamping ?? 0, 'damping rate', 0);
    const impulse = finite(params.impulse ?? (this.excitation ? 0 : 1), 'impulse');
    if (air != null && air.length !== count)
      throw invalid('Provide one acoustic air-mask value per logical grid cell.');
    if (initialPressure != null && initialPressure.length !== count)
      throw invalid('Provide one initial pressure value per logical grid cell.');
    if (typeof reflection !== 'number' && reflection.length !== count)
      throw invalid('Provide either one reflection coefficient or one per logical grid cell.');
    const sourceIndex = index(source, d, 'source');
    const receiverIndex = index(receiver, d, 'receiver');
    if (air && (air[sourceIndex] !== 1 || air[receiverIndex] !== 1))
      throw invalid('Set the room sound source and receiver in air cells.');
    const intervalWidth = BASE_RATE * spacing;
    let lambda = Number.isFinite(intervalWidth) ? speed / intervalWidth : speed / spacing / BASE_RATE;
    let steps = 1;
    if (!Number.isFinite(lambda)) throw invalid('Increase voxel spacing to obtain a finite acoustic time step.');
    const bytesAvailable = MAX_MEMORY_PAGES * 65536;
    while (lambda * ROOT_THREE > 1 && steps * BYTES * 3 < bytesAvailable) {
      lambda *= 0.5;
      steps *= 2;
    }
    if (!(volume > 0 && Number.isSafeInteger(volume) && (7 * volume + 3 * steps + 2) * BYTES < bytesAvailable))
      throw invalid('The acoustic grid will not fit in Wasm memory. Reduce the volume or increase voxel spacing.');
    const lambda2 = finite(lambda * lambda, 'squared Courant number', Number.MIN_VALUE);
    const shared = isShared(host.memory);
    if (this.#pool && !shared)
      throw new MargoError(
        'unsupported',
        'Room sound helpers need shared world memory. Use worldMemory(true) or threads: 1.',
      );
    const module = shared ? this.shared : this.plain;
    if (!module)
      throw new MargoError('unsupported', 'Use plain world memory when shared acoustic Wasm is unavailable.');
    const reserve = (name: string, words: number) => host.allocate(`room-sound-${name}`, words * BYTES, 'f64', LAYOUT);
    const state: Omit<RoomState, 'native'> = {
      host,
      dimensions: d,
      row,
      plane,
      volume,
      impulse,
      steps,
      lambda2,
      source: offsets(source, row, plane),
      receiver: offsets(receiver, row, plane),
      pressure: [reserve('pressure-current', volume), reserve('pressure-past', volume)],
      candidatePressure: [reserve('candidate-current', volume), reserve('candidate-past', volume)],
      clock: reserve('clock', 2),
      trace: reserve('receiver', steps),
      candidateTrace: reserve('candidate-receiver', steps),
      coefficients: reserve('coefficients', 3 * volume),
      forcing: reserve('forcing', steps),
    };

    const current = regionData(state, state.pressure[0]);
    const past = regionData(state, state.pressure[1]);
    const coefficients = regionData(state, state.coefficients);
    const [nx, ny, nz] = d;
    const logicalPlane = nx * ny;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const logical = x + nx * y + logicalPlane * z;
          const active = air ? air[logical] : 1;
          if (active !== 0 && active !== 1) throw invalid('Set each acoustic air-mask cell to either zero or one.');
          if (!active) continue;
          const p = x + 1 + (y + 1) * row + (z + 1) * plane;
          const r = finite(typeof reflection === 'number' ? reflection : reflection[logical]!, 'reflection', 0, 1);
          const open =
            Number(x > 0 && (air?.[logical - 1] ?? 1) > 0) +
            Number(x < nx - 1 && (air?.[logical + 1] ?? 1) > 0) +
            Number(y > 0 && (air?.[logical - nx] ?? 1) > 0) +
            Number(y < ny - 1 && (air?.[logical + nx] ?? 1) > 0) +
            Number(z > 0 && (air?.[logical - logicalPlane] ?? 1) > 0) +
            Number(z < nz - 1 && (air?.[logical + logicalPlane] ?? 1) > 0);
          const loss = (lambda * (6 - open) * (1 - r)) / (2 * (1 + r)) + airLoss / (BASE_RATE * steps);
          coefficients[p] = 2 - state.lambda2 * open;
          coefficients[p + volume] = loss - 1;
          coefficients[p + 2 * volume] = 1 / (1 + loss);
          current[p] = finite(initialPressure ? initialPressure[logical]! : 0, 'initial pressure');
          past[p] = current[p]!;
        }
      }
    }
    this.#state = { ...state, native: bindRoomWaveKernel(host, module, this.#pool) };
  }

  step(context: StepContext): void {
    const s = this.#live();
    const clock = regionData(s, s.clock);
    const end = clock[0]! + s.steps;
    if (!Number.isSafeInteger(clock[0]) || clock[0]! < 0 || !Number.isSafeInteger(end))
      throw invalid('The room sound sample clock exceeds exact range. Continue from a shorter acoustic segment.');
    const at = clock[1];
    if (at !== 0 && at !== 1)
      throw invalid('The room sound snapshot has an invalid pressure phase. Restore a compatible snapshot.');
    const forcing = regionData(s, s.forcing);
    const port = context.inputs.get(this.excitationField.name);
    if (port) {
      const { region } = port;
      const a = context.cell;
      const b = port.cell;
      if (
        !region ||
        region.layout !== LAYOUT ||
        region.type !== 'f64' ||
        (region.byteLength !== BYTES && region.byteLength !== BYTES * s.steps) ||
        b?.length !== 3 ||
        b[0] !== a[0] ||
        b[1] !== a[1] ||
        b[2] !== a[2]
      )
        throw invalid('Provide a layout-1 room impulse or one f64 pressure increment per sample in the room cell.');
      const values = regionData(s, region);
      for (const value of values) finite(value, 'source pressure');
      forcing.fill(0);
      forcing.set(values);
    } else {
      forcing.fill(0);
    }
    if (clock[0] === 0) forcing[0] = finite(forcing[0]! + s.impulse, 'combined first source impulse');
    const accepted = [regionData(s, s.pressure[0]), regionData(s, s.pressure[1])] as const;
    const candidate = [regionData(s, s.candidatePressure[0]), regionData(s, s.candidatePressure[1])] as const;
    candidate[0].set(accepted[0]);
    candidate[1].set(accepted[1]);
    const work = s.native.step(
      s.candidatePressure[at].byteOffset,
      s.candidatePressure[1 - at]!.byteOffset,
      s.coefficients.byteOffset,
      s.forcing.byteOffset,
      s.candidateTrace.byteOffset,
      s.volume,
      s.row,
      s.plane,
      s.source,
      s.receiver,
      s.steps,
      s.lambda2,
    );
    accepted[0].set(candidate[0]);
    accepted[1].set(candidate[1]);
    regionData(s, s.trace).set(regionData(s, s.candidateTrace));
    clock[0] = end;
    clock[1] = (at + s.steps) % 2;
    this.#work = work;
  }

  /** Copy the receiver's latest samples. */
  readTrace(): RoomSoundTrace {
    const s = this.#live();
    const last = regionData(s, s.clock)[0]!;
    return {
      sampleRate: BASE_RATE * s.steps,
      firstSample: last === 0 ? 1 : last - s.steps + 1,
      values: last === 0 ? new Float64Array(0) : regionData(s, s.trace).slice(),
    };
  }

  /** Read pressure in Pa at a logical grid cell; solid cells return zero. */
  pressureAt(cell: AcousticVoxel): number {
    const s = this.#live();
    index(cell, s.dimensions, 'sample');
    const at = regionData(s, s.clock)[1] === 0 ? 0 : 1;
    return regionData(s, s.pressure[at])[offsets(cell, s.row, s.plane)]!;
  }

  /** Word offset of [0, 0, 0] and strides along the y and z axes. X stride is one word. */
  get pressureLayout(): {
    readonly first: number;
    readonly yStride: number;
    readonly zStride: number;
    readonly dimensions: AcousticVoxel;
  } {
    const s = this.#live();
    return { first: 1 + s.row + s.plane, yStride: s.row, zStride: s.plane, dimensions: [...s.dimensions] };
  }

  exportPorts(tick: number): readonly Port[] {
    const s = this.#live();
    const at = regionData(s, s.clock)[1] === 0 ? 0 : 1;
    const cell = s.host.cell;
    return [
      { field: this.traceField.name, region: s.trace, tick, cell },
      { field: this.pressureField.name, region: s.pressure[at], tick, cell },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const s = this.#live();
    return [...s.pressure, s.clock, s.trace];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Work from the latest accepted pressure step computed by this instance. */
  workCounts(): RoomWaveWorkCounts | undefined {
    this.#live();
    return this.#work;
  }

  /** Release optional helpers after the world's final room sound step. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pool?.close();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #live(): RoomState {
    if (this.#disposed) throw new MargoError('disposed', 'Room sound solver is disposed. Load a new solver.');
    if (!this.#state) throw new MargoError('state', 'Add the room sound solver to a PhysicsWorld before reading it.');
    return this.#state;
  }
}
