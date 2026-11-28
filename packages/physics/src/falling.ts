import { DRY_AIR_GAS_CONSTANT, SEA_LEVEL_PRESSURE, SEA_LEVEL_TEMPERATURE } from '@margoengine/math/atmosphere';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import { hypot } from '@margoengine/math/pinned';
import { collideSphere, type FallingBoundary } from './falling/boundary.js';
import { fallingError } from './falling/errors.js';
import { type FallingBuilds, type FallingWorkCounts, fallingStep, loadFallingBuilds } from './falling/kernel.js';
import {
  AIR_WORDS,
  dot,
  finiteVector,
  type FallingBody,
  type FallingFrame,
  type FallingSphereSetup,
  indexError,
  MODEL_WORDS,
  fallingRotation,
  prepareFalling,
  type Rotation,
  SECTION_WORDS,
  STATE_WORDS,
  type Vector,
  worldVector,
} from './falling/model.js';
import {
  checkCell,
  type FieldDescriptor,
  type Port,
  RATE_LEVELS,
  type RateLevel,
  rateOf,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from './world/solver.js';

export { type FallingBoundary, type FallingHit, fallingBoundaryFromPhysics } from './falling/boundary.js';
export type { FallingWorkCounts, FallingWorkerWork } from './falling/kernel.js';
export type {
  FallingBladeSection,
  FallingBody,
  FallingDragSample,
  FallingPlate,
  FallingSamara,
  FallingSphere,
} from './falling/model.js';

/** f64 pose record: position xyz, orientation xyzw, linear velocity xyz and angular velocity xyz. */
export const FALLING_BODY_WORDS = 13;

/** f32 sphere draw row: centre xyz, radius, velocity xyz and padding. */
export const FALLING_SPHERE_DRAW_WORDS = 8;

/** Sets the solver ID and the dyadic rate before adding it to a world. */
export interface FallingLoadOptions {
  /** Unique solver ID and prefix for its output field. Defaults to 'falling'. */
  readonly id?: string;
  /** Preferred dyadic world rate. Defaults to 2 (240 Hz). Each body may use finer local steps. */
  readonly rate?: RateLevel;
  /** Cancels fetching or compiling the Wasm assets. */
  readonly signal?: AbortSignal;
  /** Actual native participants, including the caller. Choose 1 (default), 2 or 4. */
  readonly threads?: number;
}

/** Falling body setup. Body indices and field rows share the input array's order. */
export interface FallingParams {
  /** Plates, winged seeds or rounded objects, in stable port order. */
  readonly bodies: readonly FallingBody[];
  /** Air velocity, temperature and density on the world clock. Defaults to still standard sea-level air. */
  readonly wind?: Wind;
  /** Static scene boundary for rounded grains. Omit for unbounded flight. */
  readonly boundary?: FallingBoundary;
  /** The containing world's origin-cell size in metres. Defaults to 4096. */
  readonly cellSize?: number;
}

/** A body pose and its derivatives on world axes, in its solver's origin cell. */
export interface FallingPose {
  readonly position: Vector;
  readonly rotation: Rotation;
  readonly velocity: Vector;
  readonly angularVelocity: Vector;
}

interface Data {
  readonly host: SolverHost;
  readonly native: ReturnType<typeof fallingStep>;
  readonly dynamic: Region;
  readonly trial: Region;
  readonly models: Region;
  readonly bladeGeometry: Region;
  readonly samples: Region;
  readonly poses: Region;
  readonly poseCandidate: Float64Array;
  readonly drawCandidate: Float32Array;
  readonly frames: readonly FallingFrame[];
  readonly wind: Wind | undefined;
  readonly boundary: FallingBoundary | undefined;
  readonly spheres: readonly (FallingSphereSetup | undefined)[];
  readonly sphereCount: number;
  readonly customDrag: boolean;
  readonly gravity: number;
  readonly cellSize: number;
}

const LAYOUT = 1;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const STILL = SEA_LEVEL_PRESSURE / (DRY_AIR_GAS_CONSTANT * SEA_LEVEL_TEMPERATURE);
const CENTRE = [0, 0, 0] as const;

function requireCell(cell: Vector): void {
  try {
    checkCell(cell);
  } catch (cause) {
    throw fallingError('Use three signed 32-bit integer coordinates for each falling origin.', 'state', cause);
  }
}

function cellDelta(from: Vector, to: Vector, size: number): Vector {
  return [(from[0] - to[0]) * size, (from[1] - to[1]) * size, (from[2] - to[2]) * size];
}

function words(host: SolverHost, region: Region): Float64Array {
  return new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / F64);
}

function publishPoses(state: Float64Array, frames: readonly FallingFrame[], out: Float64Array): void {
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!;
    const i = index * STATE_WORDS;
    const o = index * FALLING_BODY_WORDS;
    out.set(worldVector(frame, state[i]!, state[i + 1]!, state[i + 6]!), o);
    out.set(fallingRotation(frame, state[i + 4]!), o + 3);
    out.set(worldVector(frame, state[i + 2]!, state[i + 3]!, state[i + 7]!), o + 7);
    const spin = state[i + 5]!;
    out[o + 10] = frame.z[0] * spin;
    out[o + 11] = frame.z[1] * spin;
    out[o + 12] = frame.z[2] * spin;
    for (let word = o; word < o + FALLING_BODY_WORDS; word++) {
      if (!Number.isFinite(out[word])) throw indexError(index);
    }
  }
}

/** Simulates falling, fluttering and tumbling plates, winged seeds and rounded grains on the deterministic world clock. */
export class FallingSolver implements Solver<FallingParams> {
  /** Unique solver ID. */
  readonly id: string;
  /** Layout-1 pose port. See {@link FALLING_BODY_WORDS}. */
  readonly poseField: FieldDescriptor;
  readonly #rate: RateLevel;
  readonly #builds: FallingBuilds;
  readonly #sample: FlowSample = { velocity: [0, 0, 0], temperature: SEA_LEVEL_TEMPERATURE, density: STILL };
  readonly #dragAir = { temperature: SEA_LEVEL_TEMPERATURE, density: STILL, gravity: 0 };
  #data?: Data;
  #nativeWork?: FallingWorkCounts;
  #disposed = false;
  #running = false;

  private constructor(id: string, rate: RateLevel, builds: FallingBuilds) {
    this.id = id;
    this.#rate = rate;
    this.#builds = builds;
    this.poseField = Object.freeze({
      name: id + '/poses',
      kind: 'particleSet',
      quantity: 'bodyPose',
      unit: 'm, 1, m/s, rad/s',
      centring: 'particle',
    });
  }

  /** Fetches and compiles the optional kernel. Add the result to a world to start it. */
  static async load(options: FallingLoadOptions = {}): Promise<FallingSolver> {
    if (!options) throw fallingError('Pass falling load options as an object, or omit them.');
    const id = options.id ?? 'falling';
    const rate = options.rate ?? 2;
    if (typeof id !== 'string' || id.trim().length === 0)
      throw fallingError('Falling solver ID is empty. Provide a nonempty ID.');
    if (!Number.isInteger(rate) || rate < 0 || rate >= RATE_LEVELS)
      throw fallingError('Falling solver rate is invalid. Pass one of the world rate levels 0 to 7.');
    return new FallingSolver(id, rate, await loadFallingBuilds(options.signal, options.threads));
  }

  /** Releases native helpers after the containing world finishes using this solver. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#requireIdle();
    this.#disposed = true;
    this.#builds[Symbol.dispose]();
  }

  #requireIdle(): void {
    if (this.#disposed) throw fallingError('This falling solver was disposed. Load a new instance.', 'disposed');
    if (this.#running) throw fallingError('Call the solver between steps. Use read-only air and boundary callbacks.');
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [{ field: this.poseField, access: 'write' }],
      rate: this.#rate,
      stableRate: () => this.#rate,
    };
  }

  init(host: SolverHost, params: FallingParams): void {
    this.#requireIdle();
    if (this.#data) throw fallingError('This falling solver belongs to a world. Load a new instance.', 'attached');
    this.#running = true;
    try {
      this.#initialize(host, params);
    } catch (cause) {
      if (this.#builds.pool) {
        this.#disposed = true;
        this.#builds[Symbol.dispose]();
      }
      throw cause;
    } finally {
      this.#running = false;
    }
  }

  #initialize(host: SolverHost, params: FallingParams): void {
    const { bodies, wind, boundary, cellSize = 4096 } = params ?? {};
    if (!Array.isArray(bodies) || bodies.length === 0)
      throw fallingError('There are no falling bodies. Supply an array with at least one body.');
    if (wind) {
      if (wind.medium !== 'air' || typeof wind.sample !== 'function')
        throw fallingError(
          'Falling solver wind is invalid. Use an air Wind with a sampler and an integer origin cell.',
        );
      requireCell(wind.cell);
    }
    if (boundary) {
      if (typeof boundary.sweep !== 'function')
        throw fallingError('Invalid falling boundary. Provide a swept-sphere query and an integer origin cell.');
      requireCell(boundary.cell);
    }
    if (!Number.isSafeInteger(cellSize) || cellSize < 1 || cellSize > 1048576 || (cellSize & (cellSize - 1)) !== 0)
      throw fallingError('Falling solver cell size is invalid. Pass the containing world’s power-of-two cell size.');
    let sectionWords = 0;
    const prepared = Array.from(bodies, (body) => {
      const model = prepareFalling(body, host.gravity, sectionWords / SECTION_WORDS);
      sectionWords += model.sections.length;
      return model;
    });
    const make = (name: string, width: number) => host.allocate(name, width * prepared.length * F64, 'f64', LAYOUT);
    const dynamic = make('falling-state', STATE_WORDS);
    const trial = make('falling-next', STATE_WORDS);
    const models = make('falling-model', MODEL_WORDS);
    const samples = make('falling-air', AIR_WORDS);
    const poses = make('falling-poses', FALLING_BODY_WORDS);
    const bladeGeometry = host.allocate('falling-blades', sectionWords * F64, 'f64', LAYOUT);
    const native = fallingStep(host, this.#builds);
    const state = words(host, dynamic);
    const model = words(host, models);
    const air = words(host, samples);
    const blade = words(host, bladeGeometry);
    let start = 0;
    const frames = prepared.map(({ frame, initial, parameters, sections }, index) => {
      blade.set(sections, start);
      start += sections.length;
      state.set(initial, index * STATE_WORDS);
      model.set(parameters, index * MODEL_WORDS);
      air[index * AIR_WORDS + 3] = STILL;
      air[index * AIR_WORDS + 4] = parameters[5]!;
      return frame;
    });
    publishPoses(state, frames, words(host, poses));
    const spheres = prepared.map(({ sphere }) => sphere);
    const sphereCount = spheres.filter((sphere) => sphere !== undefined).length;
    const customDrag = spheres.some((sphere) => typeof sphere?.drag === 'function');
    const gravity = hypot(...host.gravity);
    this.#data = {
      host,
      native,
      dynamic,
      trial,
      models,
      bladeGeometry,
      samples,
      poses,
      poseCandidate: new Float64Array(frames.length * FALLING_BODY_WORDS),
      drawCandidate: new Float32Array(sphereCount * FALLING_SPHERE_DRAW_WORDS),
      frames,
      wind,
      boundary,
      spheres,
      sphereCount,
      customDrag,
      gravity,
      cellSize,
    };
  }

  #ready(): Data {
    if (!this.#data) throw fallingError('Falling solver has no world. Add it before reading or stepping bodies.');
    return this.#data;
  }

  #sampleAir(data: Data, context: StepContext, dt: number): void {
    const { wind, customDrag, frames, host, dynamic, samples, cellSize, spheres, gravity } = data;
    if (!wind && !customDrag) return;
    if (wind) requireCell(wind.cell);
    const [dx, dy, dz] = wind ? cellDelta(context.cell, wind.cell, cellSize) : CENTRE;
    const half = dt / 2;
    const time = context.tick / rateOf(context.level) + half;
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]!;
      let velocity: Vector = CENTRE;
      let density = STILL;
      let temperature = SEA_LEVEL_TEMPERATURE;
      if (wind) {
        const i = index * STATE_WORDS;
        const p = words(host, dynamic);
        const [x, y, z] = worldVector(
          frame,
          p[i]! + half * p[i + 2]!,
          p[i + 1]! + half * p[i + 3]!,
          p[i + 6]! + half * p[i + 7]!,
        );
        if (!finiteVector([x + dx, y + dy, z + dz]) || !Number.isFinite(time))
          throw fallingError('Falling air sample overflows. Use local origins and a finite world step.', 'failed');
        const air = wind.sample(x + dx, y + dy, z + dz, time, this.#sample);
        if (
          !finiteVector(air?.velocity) ||
          !Number.isFinite(air.density) ||
          air.density < 0 ||
          !(Number.isFinite(air.temperature) && air.temperature > 0)
        )
          throw fallingError(
            'Falling solver sampled invalid air. Use a sampler that returns finite velocity, nonnegative density and positive kelvin.',
          );
        ({ velocity, density, temperature } = air);
      }
      const o = index * AIR_WORDS;
      const sphere = spheres[index];
      if (sphere && typeof sphere.drag === 'function' && density > 0) {
        const sample = this.#dragAir;
        sample.density = density;
        sample.temperature = temperature;
        sample.gravity = gravity;
        const coefficient = sphere.drag(sample);
        if (!Number.isFinite(coefficient) || coefficient < 0)
          throw fallingError('Falling solver drag law is invalid. Provide a finite nonnegative coefficient.');
        const area = sphere.area * coefficient;
        if (!Number.isFinite(area))
          throw fallingError('Falling drag area overflows. Use a smaller diameter or drag coefficient.');
        words(host, samples)[o + 4] = area;
      }
      const air = words(host, samples);
      air[o] = dot(velocity, frame.x);
      air[o + 1] = dot(velocity, frame.y);
      air[o + 2] = dot(velocity, frame.z);
      air[o + 3] = density;
    }
  }

  #contact(data: Data, context: StepContext): void {
    const { boundary, spheres, host, dynamic, trial, cellSize } = data;
    if (!boundary) return;
    requireCell(boundary.cell);
    const originShift = cellDelta(context.cell, boundary.cell, cellSize);
    for (let body = 0; body < spheres.length; body++) {
      const sphere = spheres[body];
      if (!sphere) continue;
      const at = body * STATE_WORDS;
      const previous = words(host, dynamic);
      const next = words(host, trial);
      // Spheres use the identity frame. Translate in the boundary's origin
      // cell so narrow-phase f32 does not subtract a large world offset.
      const contact = collideSphere(
        boundary,
        sphere.radius,
        sphere.restitution,
        [previous[at]!, previous[at + 1]!, previous[at + 6]!],
        [next[at]!, next[at + 1]!, next[at + 6]!],
        [next[at + 2]!, next[at + 3]!, next[at + 7]!],
        originShift,
      );
      const [x, y, z] = contact.centre;
      const output = words(host, trial);
      output[at] = x;
      output[at + 1] = y;
      output[at + 6] = z;
      output[at + 2] = contact.velocity[0];
      output[at + 3] = contact.velocity[1];
      output[at + 7] = contact.velocity[2];
    }
  }

  step(context: StepContext, dt: number): void {
    this.#requireIdle();
    if (!Number.isFinite(dt) || dt < 0) throw fallingError('Pass a finite nonnegative falling step in seconds.');
    requireCell(context.cell);
    this.#running = true;
    try {
      this.#advance(context, dt);
    } finally {
      this.#running = false;
    }
  }

  #advance(context: StepContext, dt: number): void {
    const data = this.#ready();
    this.#sampleAir(data, context, dt);
    const { host, dynamic, trial, models, bladeGeometry, samples, poses, poseCandidate, frames } = data;
    const code = data.native.run(
      models.byteOffset,
      bladeGeometry.byteOffset,
      samples.byteOffset,
      dynamic.byteOffset,
      trial.byteOffset,
      frames.length,
      dt,
    );
    if (code) throw indexError(code - 1);
    this.#contact(data, context);
    const next = words(host, trial);
    publishPoses(next, frames, poseCandidate);
    words(host, poses).set(poseCandidate);
    words(host, dynamic).set(next);
    this.#nativeWork = data.native.workCounts();
  }

  /** Copies actual native work from the last accepted step. A receipt is not part of a physics snapshot. */
  readNativeWork(): FallingWorkCounts | undefined {
    const work = this.#nativeWork;
    return work && { ...work, workers: work.workers.map((part) => ({ ...part })) };
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const { host, poses } = this.#ready();
    return [{ field: this.poseField.name, region: poses, tick, cell: host.cell }];
  }

  stateRegions(): readonly Region[] {
    const { dynamic, models, bladeGeometry, poses } = this.#ready();
    return [dynamic, models, bladeGeometry, poses];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Rounded bodies, ordered as supplied at setup. */
  get sphereCount(): number {
    return this.#ready().sphereCount;
  }

  /**
   * Fills a renderer's f32 buffer with the leading sphere poses in draw order.
   * Set offset to the solver cell's origin in the rendering coordinate system.
   */
  writeSpheres(out: Float32Array, offset: Vector = CENTRE): void {
    const { host, poses, spheres, sphereCount, drawCandidate } = this.#ready();
    const count = out instanceof Float32Array ? out.length / FALLING_SPHERE_DRAW_WORDS : -1;
    if (count < 0 || !Number.isInteger(count) || count > sphereCount || !finiteVector(offset))
      throw fallingError(
        'Invalid falling sphere draw buffer. Pass eight f32 words per requested sphere and a finite xyz offset.',
      );
    const values = words(host, poses);
    let emitted = 0;
    for (let index = 0; index < spheres.length && emitted < count; index++) {
      const shape = spheres[index];
      if (!shape) continue;
      const at = index * FALLING_BODY_WORDS;
      const target = emitted * FALLING_SPHERE_DRAW_WORDS;
      drawCandidate[target] = values[at]! + offset[0];
      drawCandidate[target + 1] = values[at + 1]! + offset[1];
      drawCandidate[target + 2] = values[at + 2]! + offset[2];
      drawCandidate[target + 3] = shape.radius;
      drawCandidate[target + 4] = values[at + 7]!;
      drawCandidate[target + 5] = values[at + 8]!;
      drawCandidate[target + 6] = values[at + 9]!;
      drawCandidate[target + 7] = 0;
      for (let word = target; word < target + FALLING_SPHERE_DRAW_WORDS - 1; word++) {
        if (!Number.isFinite(drawCandidate[word]))
          throw fallingError(
            'Sphere draw data exceeds f32 range. Use a nearby render origin and smaller local speeds.',
          );
      }
      emitted++;
    }
    out.set(drawCandidate.subarray(0, out.length));
  }

  /** Copies the latest pose of the indexed body. */
  pose(index: number): FallingPose {
    const { host, poses, frames } = this.#ready();
    if (!Number.isSafeInteger(index) || index < 0 || index >= frames.length)
      throw fallingError('Falling body index is outside the port. Use an index from the supplied bodies array.');
    const values = words(host, poses);
    const at = index * FALLING_BODY_WORDS;
    return {
      position: [values[at]!, values[at + 1]!, values[at + 2]!],
      rotation: [values[at + 3]!, values[at + 4]!, values[at + 5]!, values[at + 6]!],
      velocity: [values[at + 7]!, values[at + 8]!, values[at + 9]!],
      angularVelocity: [values[at + 10]!, values[at + 11]!, values[at + 12]!],
    };
  }
}
