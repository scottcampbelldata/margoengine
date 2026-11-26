import { DRY_AIR_GAS_CONSTANT, SEA_LEVEL_PRESSURE, SEA_LEVEL_TEMPERATURE } from '@margoengine/math/atmosphere';
import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import { hypot } from '@margoengine/math/pinned';
import { collideSphere, type FallingBoundary } from './falling/boundary.js';
import { type FallingBuilds, fallingStep, loadFallingBuilds } from './falling/kernel.js';
import {
  AIR_WORDS,
  dot,
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
  readonly run: ReturnType<typeof fallingStep>;
  readonly dynamic: Region;
  readonly trial: Region;
  readonly models: Region;
  readonly bladeGeometry: Region;
  readonly samples: Region;
  readonly poses: Region;
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
    const id = options.id ?? 'falling';
    const rate = options.rate ?? 2;
    if (typeof id !== 'string' || id.trim().length === 0)
      throw new TypeError('Falling solver ID is empty. Provide a nonempty ID.');
    if (!Number.isInteger(rate) || rate < 0 || rate >= RATE_LEVELS)
      throw new RangeError('Falling solver rate is invalid. Pass one of the world rate levels 0 to 7.');
    return new FallingSolver(id, rate, await loadFallingBuilds(options.signal));
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
    if (this.#data) throw new MargoError('state', 'This falling solver belongs to a world. Load a new instance.');
    const { bodies, wind, boundary, cellSize = 4096 } = params;
    if (!Array.isArray(bodies) || bodies.length === 0)
      throw new RangeError('There are no falling bodies. Supply an array with at least one body.');
    if (
      wind &&
      (wind.medium !== 'air' ||
        typeof wind.sample !== 'function' ||
        wind.cell?.length !== 3 ||
        !wind.cell.every(Number.isSafeInteger))
    )
      throw new TypeError('Falling solver wind is invalid. Use an air Wind with a sampler and an integer origin cell.');
    if (
      boundary &&
      (typeof boundary.sweep !== 'function' ||
        boundary.cell?.length !== 3 ||
        !boundary.cell.every(Number.isSafeInteger))
    )
      throw new TypeError('Invalid falling boundary. Provide a swept-sphere query and an integer origin cell.');
    if (!Number.isSafeInteger(cellSize) || cellSize < 1 || cellSize > 1048576 || (cellSize & (cellSize - 1)) !== 0)
      throw new RangeError('Falling solver cell size is invalid. Pass the containing world’s power-of-two cell size.');
    let sectionWords = 0;
    const prepared = Array.from(bodies, (body) => {
      const model = prepareFalling(body, host.gravity, sectionWords / SECTION_WORDS);
      sectionWords += model.sections.length;
      return model;
    });
    const run = fallingStep(host, this.#builds);
    const make = (name: string, width: number) => host.allocate(name, width * prepared.length * F64, 'f64', LAYOUT);
    const dynamic = make('falling-state', STATE_WORDS);
    const trial = make('falling-next', STATE_WORDS);
    const models = make('falling-model', MODEL_WORDS);
    const samples = make('falling-air', AIR_WORDS);
    const poses = make('falling-poses', FALLING_BODY_WORDS);
    const bladeGeometry = host.allocate('falling-blades', sectionWords * F64, 'f64', LAYOUT);
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
      run,
      dynamic,
      trial,
      models,
      bladeGeometry,
      samples,
      poses,
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
    if (!this.#data)
      throw new MargoError('state', 'Falling solver has no world. Add it before reading or stepping bodies.');
    return this.#data;
  }

  #sampleAir(data: Data, context: StepContext, dt: number): void {
    const { wind, customDrag, frames, host, dynamic, samples, cellSize, spheres, gravity } = data;
    if (!wind && !customDrag) return;
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
        ({ velocity, density, temperature } = wind.sample(x + dx, y + dy, z + dz, time, this.#sample));
        if (
          velocity?.length !== 3 ||
          !velocity.every(Number.isFinite) ||
          !Number.isFinite(density) ||
          density < 0 ||
          !(Number.isFinite(temperature) && temperature > 0)
        )
          throw new RangeError(
            'Falling solver sampled invalid air. Use a sampler that returns finite velocity, nonnegative density and positive kelvin.',
          );
      }
      const o = index * AIR_WORDS;
      const sphere = spheres[index];
      if (sphere && typeof sphere.drag === 'function' && density > 0) {
        const sample = this.#dragAir;
        sample.density = density;
        sample.temperature = temperature;
        sample.gravity = gravity;
        const area = sphere.area * sphere.drag(sample);
        if (!Number.isFinite(area) || area < 0)
          throw new RangeError('Falling solver drag law is invalid. Provide a finite nonnegative coefficient.');
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
    const data = this.#ready();
    this.#sampleAir(data, context, dt);
    const { host, dynamic, trial, models, bladeGeometry, samples, poses, frames } = data;
    const code = data.run(
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
    publishPoses(next, frames, words(host, poses));
    words(host, dynamic).set(next);
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: this.poseField.name, region: this.#ready().poses, tick, cell: CENTRE }];
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
    const { host, poses, spheres, sphereCount } = this.#ready();
    const count = out.length / FALLING_SPHERE_DRAW_WORDS;
    if (
      !(out instanceof Float32Array) ||
      !Number.isInteger(count) ||
      count > sphereCount ||
      offset?.length !== 3 ||
      !offset.every(Number.isFinite)
    )
      throw new RangeError(
        'Invalid falling sphere draw buffer. Pass eight f32 words per requested sphere and a finite xyz offset.',
      );
    const values = words(host, poses);
    let emitted = 0;
    for (let index = 0; index < spheres.length && emitted < count; index++) {
      const shape = spheres[index];
      if (!shape) continue;
      const at = index * FALLING_BODY_WORDS;
      const target = emitted * FALLING_SPHERE_DRAW_WORDS;
      out[target] = values[at]! + offset[0];
      out[target + 1] = values[at + 1]! + offset[1];
      out[target + 2] = values[at + 2]! + offset[2];
      out[target + 3] = shape.radius;
      out[target + 4] = values[at + 7]!;
      out[target + 5] = values[at + 8]!;
      out[target + 6] = values[at + 9]!;
      out[target + 7] = 0;
      emitted++;
    }
  }

  /** Copies the latest pose of the indexed body. */
  pose(index: number): FallingPose {
    const { host, poses, frames } = this.#ready();
    if (!Number.isSafeInteger(index) || index < 0 || index >= frames.length)
      throw new RangeError('Falling body index is outside the port. Use an index from the supplied bodies array.');
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
