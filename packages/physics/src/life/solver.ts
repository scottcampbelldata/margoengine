import type { MutableVec3, Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { FlowCell, FlowSample, SeaSurface, SeaSurfaceSample, SeaWater } from '@margoengine/math/fields';
import { cos, hypot, ln, sin } from '@margoengine/math/pinned';
import { SCHOOL_INTENT_FIELD, SCHOOL_KINEMATICS_FIELD, SCHOOL_LAYOUT } from '../schooling/ports.js';
import {
  type Cell,
  type FieldDescriptor,
  isRateLevel,
  type Port,
  rateOf,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { instantiateSwimKernel, loadSwimKernel, type SwimKernelBuilds } from './kernel.js';
import {
  ellipsoidArea,
  finite,
  positive,
  recoil,
  rotate,
  spine,
  submerged,
  TAU,
  vector,
  ZERO,
  type SwimSpinePoint,
  type SwimTail,
} from './model.js';
import { SWIM_WAKE_FIELD, SWIM_WAKE_LAYOUT, SWIM_WAKE_WORDS } from './wake.js';

export { SWIM_WAKE_FIELD, SWIM_WAKE_LAYOUT } from './wake.js';

const ORIGIN: Cell = [0, 0, 0];
const BODY_WORDS = 19;
const PARAMETER_WORDS = 28;
const MEDIUM_WORDS = 28;
const COMMAND_WORDS = 6;
const CONTACT_WORDS = 6;
const KINEMATICS_WORDS = 6;
const LOG_10 = ln(10);
const RESOLUTION = 32;

/** Layout of the swimmer contact port. One row of six f64 components per swimmer. */
export const SWIM_CONTACT_LAYOUT = 1;
/** World-space contact force and moment about the swimmer's centre of mass, held over the coupling interval. */
export const SWIM_CONTACT_FIELD: FieldDescriptor = Object.freeze({
  name: 'swimContactWrench',
  kind: 'bodySet',
  centring: 'particle',
  quantity: 'force and torque',
  unit: 'N, N m',
});

/** Nondeforming pectoral actuators. Total area is the sum of the two fins in m². */
export interface SwimFins {
  readonly area: number;
  /** Maximum lift coefficient (default 1). */
  readonly liftCoefficient?: number;
  /** Normal drag coefficient for the power stroke (default 1). */
  readonly dragCoefficient?: number;
  /** One-sided tip displacement while sculling, m (default 0). */
  readonly strokeAmplitude?: number;
  /** Scull cycles per second (default 0). */
  readonly strokeFrequency?: number;
  /** Magnitude of the fore-aft moment arm, m (default one-quarter body length). */
  readonly momentArm?: number;
  /** Left or right moment arm from the body's centreline, m (default half body width). */
  readonly halfSpacing?: number;
}

/** A spatial target; linear velocities are on world axes. Positions use the solver's cell. */
export type SwimTarget = { readonly position: Vec3 } | { readonly velocity: Vec3; readonly relativeToWater?: boolean };

/** The initial body, dimensions and gait. Local +z is forward, +y is dorsal and +x is the right side. */
export interface SwimBody {
  readonly position: Vec3;
  /** Initial absolute velocity, m/s (default zero). */
  readonly velocity?: Vec3;
  /** Initial body-to-world [x,y,z,w] quaternion (default identity). */
  readonly orientation?: readonly [number, number, number, number];
  /** Initial angular velocity on body axes, radians per second (default zero). */
  readonly angularVelocity?: Vec3;
  readonly mass: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  /** Displaced volume when submerged, m³ (default ellipsoid volume). */
  readonly volume?: number;
  /** Centre of buoyancy offset from the centre of mass, m on body axes (default zero). */
  readonly buoyancyCentre?: Vec3;
  /** Wetted skin area, m² (default ellipsoid area). */
  readonly wettedArea?: number;
  /** Form-drag coefficient times frontal area, m² (default 0.1 times frontal area). */
  readonly formDragArea?: number;
  /** Transverse drag coefficients on the x/y axes (defaults 1 and 1). */
  readonly crossflowDrag?: readonly [number, number];
  /** Axial added mass / displaced water mass (default 0, the slender-body approximation). */
  readonly axialAddedMassRatio?: number;
  readonly tail: SwimTail;
  /** Open-loop tail cycles per second (default 0). */
  readonly frequency?: number;
  /** Maximum feedback-controlled tail frequency, Hz (default the greater of the open-loop frequency and 3). */
  readonly maximumFrequency?: number;
  /** Seconds in the powered part of a repeated burst-and-coast period (default no periodic coasting). */
  readonly burstSeconds?: number;
  /** Seconds in the unpowered part (default 0). */
  readonly coastSeconds?: number;
  readonly fins?: SwimFins;
  /** Manual x/y lift and forward sculling commands, each from -1 to 1 (default zero). */
  readonly steering?: Vec3;
  /** Characteristic proportional control response in seconds (default one). */
  readonly responseSeconds?: number;
  readonly target?: SwimTarget;
}

/** Physics fields and medium values for a group of swimmers. */
export interface SwimParams {
  readonly bodies: readonly SwimBody[];
  /** Live surface with its subsurface flow; enables displacement, entry and breaching. */
  readonly sea?: SeaSurface;
  /** Pure all-domain water velocity and density. Use sea instead for a free surface. */
  readonly flow?: SeaWater;
  /** Uniform density for standalone swimmers, kg/m³ (default 1025). Ignored when sampling water. */
  readonly density?: number;
  /** Kinematic water viscosity, m²/s (default 1.05e-6). */
  readonly kinematicViscosity?: number;
  /** Start of the laminar-to-ITTC-57 transition in Reynolds number (default 5e5). */
  readonly transitionReynolds?: number;
  /** Origin-cell side length, m. Match the world's setting when fields live in different cells (default 4096). */
  readonly cellSize?: number;
}

/** Static choices made before registering this solver in a world. */
export interface SwimOptions {
  /** Unique solver id (default 'swim'). */
  readonly id?: string;
  /** Preferred dyadic rate level from 0–7 (default 0). */
  readonly level?: RateLevel;
  /** Read one medium-relative desired velocity per swimmer from the school port (default false). */
  readonly readSchoolIntent?: boolean;
  /** Read externally computed contact forces and torques while swimming (default false). */
  readonly readContacts?: boolean;
  /** Field names when more than one group registers ports (default names match SchoolSolver). */
  readonly fields?: {
    readonly kinematics?: string;
    readonly intent?: string;
    readonly wake?: string;
    readonly contacts?: string;
  };
  readonly signal?: AbortSignal;
}

/** Snapshot-backed control changes. Omitted values keep their current values. */
export interface SwimControl {
  /** Tail effort as a fraction of its open-loop or target-driven value (0 to 1). */
  readonly effort?: number;
  /** Displaced-volume multiplier (e.g. ballast or a diver's buoyancy device), nonnegative. */
  readonly buoyancy?: number;
  /** A new tracking target, or null to fall back to school intent or the open-loop gait. */
  readonly target?: SwimTarget | null;
}

/** A copied state reading, in SI units. */
export interface SwimReading {
  position: MutableVec3;
  velocity: MutableVec3;
  orientation: [number, number, number, number];
  angularVelocity: MutableVec3;
  /** Current oscillator phase, cycles in [0,1). */
  phase: number;
  frequency: number;
  thrust: number;
  wetFraction: number;
  /** Instantaneous pectoral stroke displacement in metres. */
  finDisplacement: number;
}

interface BodyConfiguration {
  readonly parameters: readonly number[];
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly orientation: readonly [number, number, number, number];
  readonly angular: Vec3;
  readonly tail: SwimTail;
  readonly finFrequency: number;
  readonly finAmplitude: number;
  readonly recoil: readonly [number, number];
  readonly burst: number;
  readonly coast: number;
  readonly targets: readonly number[];
}

function configure(body: SwimBody): BodyConfiguration {
  const { tail, fins } = body;
  if (!tail || (tail.plane !== undefined && tail.plane !== 'lateral' && tail.plane !== 'vertical'))
    throw new RangeError('Give each swimmer a tail with a lateral or vertical deformation plane.');
  const mass = positive(body.mass, 'mass');
  const length = positive(body.length, 'length');
  const width = positive(body.width, 'width');
  const height = positive(body.height, 'height');
  const frontalArea = (Math.PI * width * height) / 4;
  const orientation = body.orientation ?? [0, 0, 0, 1];
  const norm = hypot(hypot(orientation[0], orientation[1], orientation[2]), orientation[3]);
  if (orientation.length !== 4 || !orientation.every(Number.isFinite) || !Number.isFinite(norm) || !(norm > 0))
    throw new RangeError('Pass a nonzero finite orientation quaternion for the swimmer.');
  const manual = finite(body.frequency ?? 0, 'frequency', 0);
  const maximum = finite(body.maximumFrequency ?? Math.max(manual, 3), 'maximumFrequency', manual);
  const finFrequency = finite(fins?.strokeFrequency ?? 0, 'fins.strokeFrequency', 0);
  if (Math.max(maximum, finFrequency) * RESOLUTION > rateOf(7))
    throw new RangeError(
      'Reduce the requested beat frequency so the world clock can resolve at least 32 samples per cycle.',
    );
  const steering = vector(body.steering ?? ZERO, 'steering');
  if (steering.some((axis) => Math.abs(axis) > 1))
    throw new RangeError('Set each steering component between -1 and 1.');
  const burst = finite(body.burstSeconds ?? 0, 'burstSeconds', 0);
  const coast = finite(body.coastSeconds ?? 0, 'coastSeconds', 0);
  if (coast && !burst) throw new RangeError('Set burstSeconds to a positive duration when enabling periodic coasting.');
  const [cx = 1, cy = 1] = body.crossflowDrag ?? [];
  return {
    parameters: [
      mass,
      length,
      width,
      height,
      positive(body.volume ?? (2 / 3) * frontalArea * length, 'volume'),
      finite(body.wettedArea ?? ellipsoidArea(width / 2, height / 2, length / 2), 'wettedArea', 0),
      finite(body.formDragArea ?? 0.1 * frontalArea, 'formDragArea', 0),
      finite(cx, 'crossflowDrag[0]', 0),
      finite(cy, 'crossflowDrag[1]', 0),
      finite(body.axialAddedMassRatio ?? 0, 'axialAddedMassRatio', 0),
      finite(tail.amplitude, 'tail.amplitude', 0),
      positive(tail.span, 'tail.span'),
      positive(tail.wavelength, 'tail.wavelength'),
      manual,
      maximum,
      finite(fins?.area ?? 0, 'fins.area', 0),
      finite(fins?.liftCoefficient ?? 1, 'fins.liftCoefficient', 0),
      finite(fins?.dragCoefficient ?? 1, 'fins.dragCoefficient', 0),
      TAU * finFrequency * finite(fins?.strokeAmplitude ?? 0, 'fins.strokeAmplitude', 0),
      finite(fins?.momentArm ?? length / 4, 'fins.momentArm', 0),
      finite(fins?.halfSpacing ?? width / 2, 'fins.halfSpacing', 0),
      positive(body.responseSeconds ?? 1, 'responseSeconds'),
      ...vector(body.buoyancyCentre ?? ZERO, 'buoyancyCentre'),
      ...steering,
    ],
    position: vector(body.position, 'position'),
    velocity: vector(body.velocity ?? ZERO, 'velocity'),
    orientation: [orientation[0] / norm, orientation[1] / norm, orientation[2] / norm, orientation[3] / norm],
    angular: vector(body.angularVelocity ?? ZERO, 'angularVelocity'),
    tail: { ...tail },
    finFrequency,
    finAmplitude: fins?.strokeAmplitude ?? 0,
    recoil: recoil((TAU * length) / tail.wavelength),
    burst,
    coast,
    targets: targetWords(body.target ?? null),
  };
}

function targetWords(target: SwimTarget | null): readonly number[] {
  if (target === null) return [0, 0, 0, 0];
  if ('position' in target) {
    const position = vector(target.position, 'target.position');
    return [3, ...position];
  }
  return [target.relativeToWater ? 1 : 2, ...vector(target.velocity, 'target.velocity')];
}

function words(host: SolverHost, region: Region): Float64Array {
  return new Float64Array((region.memory ?? host.memory).buffer, region.byteOffset, region.byteLength / 8);
}

function fieldCell(cell: FlowCell): void {
  if (!cell || cell.length !== 3 || !cell.every(Number.isSafeInteger))
    throw new RangeError('Use a water field with three integer origin-cell coordinates.');
}

function skinFriction(reynolds: number, transition: number): number {
  if (!(reynolds > 0)) return 0;
  const laminar = 1.328 / Math.sqrt(reynolds);
  if (reynolds <= transition) return laminar;
  const denominator = ln(reynolds) / LOG_10 - 2;
  const turbulent = 0.075 / (denominator * denominator);
  const s = Math.min(1, reynolds / transition - 1);
  return laminar + s * s * (3 - 2 * s) * (turbulent - laminar);
}

type Lease = ReturnType<typeof allocate>;
function allocate(
  host: SolverHost,
  count: number,
): {
  bodies: Region;
  next: Region;
  medium: Region;
  parameters: Region;
  command: Region;
  kinematics: Region;
  nextKinematics: Region;
  wake: Region;
  nextWake: Region;
} {
  const rows = (name: string, width: number, layout = 1) => host.allocate(name, width * count * 8, 'f64', layout);
  return {
    bodies: rows('swim-body', BODY_WORDS),
    next: rows('swim-body-next', BODY_WORDS),
    medium: rows('swim-water-scratch', MEDIUM_WORDS),
    parameters: rows('swim-settings-scratch', PARAMETER_WORDS),
    command: rows('swim-commands', COMMAND_WORDS),
    kinematics: rows('swim-kinematics', KINEMATICS_WORDS, SCHOOL_LAYOUT),
    nextKinematics: rows('swim-kinematics-next', KINEMATICS_WORDS, SCHOOL_LAYOUT),
    wake: rows('swim-wake', 2 * SWIM_WAKE_WORDS, SWIM_WAKE_LAYOUT),
    nextWake: rows('swim-wake-next', 2 * SWIM_WAKE_WORDS, SWIM_WAKE_LAYOUT),
  };
}

/** Six-degree-of-freedom swimmers driven by body waves and fins, with water-relative loads and a momentum wake. */
export class SwimSolver implements Solver<SwimParams> {
  private host?: SolverHost;
  private lease?: Lease;
  private kernel?: ReturnType<typeof instantiateSwimKernel>;
  private models: readonly BodyConfiguration[] = [];
  private sea?: SeaSurface;
  private flow?: SeaWater;
  private density = 1025;
  private viscosity = 1.05e-6;
  private transition = 5e5;
  private cellSize = 4096;
  private readonly preferred: RateLevel;
  private readonly id: string;
  private readonly readSchoolIntent: boolean;
  private readonly readContacts: boolean;
  private readonly fields: {
    kinematics: FieldDescriptor;
    intent: FieldDescriptor;
    wake: FieldDescriptor;
    contacts: FieldDescriptor;
  };
  private readonly surface: SeaSurfaceSample = {
    height: 0,
    normal: [0, 1, 0],
    velocity: [0, 0, 0],
    current: [0, 0, 0],
    depth: 0,
    density: 0,
  };
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly later: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly localNormal: MutableVec3 = [0, 0, 0];
  private readonly worldBuoyancy: MutableVec3 = [0, 0, 0];
  private readonly waterPosition: MutableVec3 = [0, 0, 0];
  private readonly wetOffset: MutableVec3 = [0, 0, 0];

  private constructor(
    private readonly builds: SwimKernelBuilds,
    options: SwimOptions,
  ) {
    const { id = 'swim', level = 0, fields, readSchoolIntent = false, readContacts = false } = options;
    if (!isRateLevel(level)) throw new RangeError('Choose a swim rate level from 0 to 7.');
    this.id = id;
    this.preferred = level;
    this.readSchoolIntent = readSchoolIntent;
    this.readContacts = readContacts;
    this.fields = {
      kinematics:
        fields?.kinematics === undefined
          ? SCHOOL_KINEMATICS_FIELD
          : { ...SCHOOL_KINEMATICS_FIELD, name: fields.kinematics },
      intent: fields?.intent === undefined ? SCHOOL_INTENT_FIELD : { ...SCHOOL_INTENT_FIELD, name: fields.intent },
      wake: fields?.wake === undefined ? SWIM_WAKE_FIELD : { ...SWIM_WAKE_FIELD, name: fields.wake },
      contacts: fields?.contacts === undefined ? SWIM_CONTACT_FIELD : { ...SWIM_CONTACT_FIELD, name: fields.contacts },
    };
  }

  /** Loads the optional kernel. Add the result to a PhysicsWorld with SwimParams. */
  static async load(options: SwimOptions = {}): Promise<SwimSolver> {
    return new SwimSolver(await loadSwimKernel(options.signal), options);
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.preferred,
      stableRate: () => this.stableRate(),
      fields: [
        { field: this.fields.kinematics, access: 'write' },
        { field: this.fields.wake, access: 'write' },
        ...(this.readSchoolIntent ? [{ field: this.fields.intent, access: 'read' as const }] : []),
        ...(this.readContacts ? [{ field: this.fields.contacts, access: 'read' as const }] : []),
      ],
    };
  }

  private stableRate(): RateLevel {
    if (!this.host || !this.lease) return this.preferred;
    const bodies = words(this.host, this.lease.bodies);
    const commands = words(this.host, this.lease.command);
    let required = 0;
    for (let row = 0; row < this.models.length; row++) {
      const index = row * BODY_WORDS;
      const model = this.models[row]!;
      const angular = hypot(bodies[index + 10]!, bodies[index + 11]!, bodies[index + 12]!);
      const maximumBeat =
        (commands[row * COMMAND_WORDS + 2]! || this.readSchoolIntent ? model.parameters[14]! : model.parameters[13]!) *
        commands[row * COMMAND_WORDS]!;
      required = Math.max(required, RESOLUTION * Math.max(maximumBeat, model.finFrequency, angular / TAU));
    }
    let level = this.preferred;
    while (level < 7 && rateOf(level) < required) level = (level + 1) as RateLevel;
    return level;
  }

  init(host: SolverHost, params: SwimParams): void {
    if (this.host) throw new MargoError('state', 'The swimmer already belongs to a world. Load another instance.');
    const { bodies, sea, flow = sea?.water } = params;
    if (!Array.isArray(bodies) || bodies.length === 0) throw new RangeError('Configure at least one swimmer body.');
    if (sea && params.flow)
      throw new RangeError('Pass sea alone for a free surface or flow alone for an all-water domain.');
    if (sea) {
      fieldCell(sea.cell);
      if (typeof sea.sample !== 'function' || !flow)
        throw new RangeError('Pass a SeaSurface exposing both surface and water samplers.');
    }
    if (flow) {
      fieldCell(flow.cell);
      if (flow.medium !== 'water' || typeof flow.sample !== 'function')
        throw new RangeError('Pass a water FlowField for the swimming medium.');
    }
    const models = bodies.map(configure);
    const density = finite(params.density ?? 1025, 'density', 0);
    this.viscosity = positive(params.kinematicViscosity ?? 1.05e-6, 'kinematicViscosity');
    const transition = positive(params.transitionReynolds ?? 5e5, 'transitionReynolds');
    if (transition < 1e5)
      throw new RangeError('Set the skin-friction transition at Reynolds number 100,000 or greater.');
    this.transition = transition;
    this.cellSize = positive(params.cellSize ?? 4096, 'cellSize');
    this.density = density;
    this.sea = sea;
    this.flow = flow;
    const kernel = instantiateSwimKernel(host, this.builds);
    const lease = allocate(host, models.length);
    const bodyWords = words(host, lease.bodies);
    const motion = words(host, lease.kinematics);
    const commands = words(host, lease.command);
    models.forEach((model, row) => {
      const { position, velocity, orientation, angular, targets, tail } = model;
      const frequency = model.parameters[13]!;
      bodyWords.set(
        [
          ...position,
          ...velocity,
          ...orientation,
          ...angular,
          0,
          frequency,
          frequency ? tail.amplitude : 0,
          0,
          density ? 1 : 0,
          0,
        ],
        row * BODY_WORDS,
      );
      motion.set(position, row * KINEMATICS_WORDS);
      motion.set(velocity, row * KINEMATICS_WORDS + 3);
      commands.set([1, 1, ...targets], row * COMMAND_WORDS);
    });
    this.models = models;
    this.lease = lease;
    this.kernel = kernel;
    this.host = host;
  }

  /** Copies kinematics and pose as of the most recent completed tick. */
  read(
    row: number,
    out: SwimReading = {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      orientation: [0, 0, 0, 1],
      angularVelocity: [0, 0, 0],
      phase: 0,
      frequency: 0,
      thrust: 0,
      wetFraction: 0,
      finDisplacement: 0,
    },
  ): SwimReading {
    const { host, lease, model } = this.member(row);
    const values = words(host, lease.bodies);
    const offset = row * BODY_WORDS;
    for (let axis = 0; axis < 3; axis++) {
      out.position[axis] = values[offset + axis]!;
      out.velocity[axis] = values[offset + 3 + axis]!;
      out.orientation[axis] = values[offset + 6 + axis]!;
      out.angularVelocity[axis] = values[offset + 10 + axis]!;
    }
    out.orientation[3] = values[offset + 9]!;
    out.phase = values[offset + 13]!;
    out.frequency = values[offset + 14]!;
    out.thrust = values[offset + 16]!;
    out.wetFraction = values[offset + 17]!;
    out.finDisplacement = model.finAmplitude * sin(TAU * values[offset + 18]!);
    return out;
  }

  /** Copies local deformed spine geometry at a fraction from head (0) to tail (1). */
  sampleSpine(
    row: number,
    fraction: number,
    out: SwimSpinePoint = { position: [0, 0, 0], tangent: [0, 0, -1] },
  ): SwimSpinePoint {
    const { host, lease, model } = this.member(row);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
      throw new RangeError('Sample the spine at a fraction between the head (0) and tail (1).');
    const values = words(host, lease.bodies);
    const offset = row * BODY_WORDS;
    return spine(
      model.parameters[1]!,
      model.tail,
      values[offset + 13]!,
      values[offset + 15]!,
      model.recoil,
      fraction,
      out,
    );
  }

  /** Updates a command between advances. These values are part of world snapshots and hashes. */
  setControl(row: number, control: SwimControl): void {
    const { host, lease } = this.member(row);
    const values = words(host, lease.command);
    const at = row * COMMAND_WORDS;
    const effort = finite(control.effort ?? values[at]!, 'effort', 0);
    if (effort > 1) throw new RangeError('Set effort to a fraction between 0 and 1.');
    const buoyancy = finite(control.buoyancy ?? values[at + 1]!, 'buoyancy', 0);
    const target = control.target === undefined ? undefined : targetWords(control.target);
    values[at] = effort;
    values[at + 1] = buoyancy;
    if (target) values.set(target, at + 2);
  }

  private member(row: number): { host: SolverHost; lease: Lease; model: BodyConfiguration } {
    const { host, lease } = this;
    if (!host || !lease) throw new MargoError('state', 'Add the swimmer to a PhysicsWorld first.');
    const model = this.models[row];
    if (!Number.isInteger(row) || !model) throw new RangeError('Use the index of a configured swimmer body.');
    return { host, lease, model };
  }

  step(context: StepContext, dt: number): void {
    const { host, lease, kernel, models } = this;
    if (!host || !lease || !kernel) throw new MargoError('state', 'Add the swimmer to a PhysicsWorld before stepping.');
    const input = context.inputs.get(this.fields.intent.name);
    if (
      this.readSchoolIntent &&
      (!input ||
        input.region.layout !== SCHOOL_LAYOUT ||
        input.region.type !== 'f64' ||
        input.region.byteLength !== models.length * 24)
    )
      throw new MargoError('state', 'Add a SCHOOL_LAYOUT intent writer with exactly three f64 velocities per swimmer.');
    const intent = input ? words(host, input.region) : undefined;
    const contactPort = context.inputs.get(this.fields.contacts.name);
    if (
      this.readContacts &&
      (!contactPort ||
        contactPort.region.layout !== SWIM_CONTACT_LAYOUT ||
        contactPort.region.type !== 'f64' ||
        contactPort.region.byteLength !== models.length * CONTACT_WORDS * 8)
    )
      throw new MargoError('state', 'Add a SWIM_CONTACT_LAYOUT writer with six f64 components per swimmer.');
    const contacts = contactPort ? words(host, contactPort.region) : undefined;
    const current = words(host, lease.bodies);
    const medium = words(host, lease.medium);
    const parameters = words(host, lease.parameters);
    const command = words(host, lease.command);
    const t = context.tick / rateOf(context.level);
    for (let row = 0; row < models.length; row++) {
      const bodyAt = row * BODY_WORDS;
      const mediumAt = row * MEDIUM_WORDS;
      const paramAt = row * PARAMETER_WORDS;
      const commandAt = row * COMMAND_WORDS;
      const model = models[row]!;
      medium.set(host.gravity, mediumAt + 6);
      this.water(context.cell, current, bodyAt, medium, mediumAt, model, t, dt);
      parameters.set(model.parameters, paramAt);
      parameters[paramAt + 4]! *= command[commandAt + 1]!;
      let powered = command[commandAt]!;
      if (model.coast && (t + dt / 2) % (model.burst + model.coast) >= model.burst) powered = 0;
      medium[mediumAt + 15] = powered;
      medium[mediumAt + 16] = cos(TAU * model.finFrequency * (t + dt / 2));
      const mode = command[commandAt + 2]!;
      for (let axis = 0; axis < 3; axis++) {
        const value = command[commandAt + 3 + axis]!;
        const flow = medium[mediumAt + axis]!;
        const target =
          mode === 3
            ? (value - current[bodyAt + axis]!) / model.parameters[21]! - flow
            : mode === 2
              ? value - flow
              : mode === 1
                ? value
                : (intent?.[3 * row + axis] ?? 0);
        medium[mediumAt + 17 + axis] = finite(target, 'swim target velocity');
      }
      medium[mediumAt + 20] = mode || intent ? 1 : 0;
      medium[mediumAt + 21] = ((t + dt) * model.finFrequency) % 1;
      for (let component = 0; component < CONTACT_WORDS; component++)
        medium[mediumAt + 22 + component] = finite(contacts?.[row * CONTACT_WORDS + component] ?? 0, 'contact wrench');
    }
    const status = kernel(
      lease.bodies.byteOffset,
      lease.parameters.byteOffset,
      lease.medium.byteOffset,
      lease.next.byteOffset,
      lease.nextKinematics.byteOffset,
      lease.nextWake.byteOffset,
      models.length,
      dt,
    );
    if (status)
      throw new RangeError(
        'Swimming integration exceeded its numeric range. Use smaller loads or consistent swimmer dimensions in SI units.',
      );
    words(host, lease.bodies).set(words(host, lease.next));
    words(host, lease.kinematics).set(words(host, lease.nextKinematics));
    words(host, lease.wake).set(words(host, lease.nextWake));
  }

  private water(
    cell: Cell,
    body: Float64Array,
    at: number,
    result: Float64Array,
    offset: number,
    model: BodyConfiguration,
    t: number,
    dt: number,
  ): void {
    const { flow, sea, waterPosition: position, localNormal, worldBuoyancy, wetOffset, cellSize } = this;
    const x = body[at]!;
    const y = body[at + 1]!;
    const z = body[at + 2]!;
    wetOffset.fill(0);
    worldBuoyancy.fill(0);
    let wet = 1;
    if (sea) {
      const surfaceX = x + (cell[0] - sea.cell[0]) * cellSize;
      const surfaceY = y + (cell[1] - sea.cell[1]) * cellSize;
      const surfaceZ = z + (cell[2] - sea.cell[2]) * cellSize;
      const { height, normal } = sea.sample(surfaceX, surfaceZ, t, this.surface);
      const nx = normal[0],
        ny = normal[1],
        nz = normal[2];
      if (!Number.isFinite(height) || ![nx, ny, nz].every(Number.isFinite) || !(ny > 0))
        throw new RangeError('Provide a finite sea elevation and an upward surface normal.');
      const qx = body[at + 6]!,
        qy = body[at + 7]!,
        qz = body[at + 8]!,
        qw = body[at + 9]!;
      rotate(-qx, -qy, -qz, qw, nx, ny, nz, localNormal);
      const rx = model.parameters[2]! / 2,
        ry = model.parameters[3]! / 2,
        rz = model.parameters[1]! / 2;
      const support = hypot(rx * localNormal[0], ry * localNormal[1], rz * localNormal[2]);
      const cut = ((height - surfaceY) * ny) / support;
      wet = submerged(cut);
      if (wet > 0 && wet < 1) {
        const centroid = (-3 * (1 - cut) * (1 - cut)) / (4 * (2 + cut) * support);
        wetOffset[0] = centroid * localNormal[0] * rx * rx;
        wetOffset[1] = centroid * localNormal[1] * ry * ry;
        wetOffset[2] = centroid * localNormal[2] * rz * rz;
        rotate(qx, qy, qz, qw, ...wetOffset, worldBuoyancy);
      }
    }
    let density = this.density;
    result.fill(0, offset, offset + 6);
    if (flow && wet > 0) {
      position[0] = x + worldBuoyancy[0] + (cell[0] - flow.cell[0]) * cellSize;
      position[1] = y + worldBuoyancy[1] + (cell[1] - flow.cell[1]) * cellSize;
      position[2] = z + worldBuoyancy[2] + (cell[2] - flow.cell[2]) * cellSize;
      const first = flow.sample(...position, t, this.sample);
      const u = finite(first.velocity[0], 'water velocity');
      const v = finite(first.velocity[1], 'water velocity');
      const w = finite(first.velocity[2], 'water velocity');
      density = finite(first.density, 'water density', 0);
      result.set([u, v, w], offset);
      if (density > 0) {
        const second = flow.sample(
          position[0] + dt * u,
          position[1] + dt * v,
          position[2] + dt * w,
          t + dt,
          this.later,
        );
        if (finite(second.density, 'water density', 0) > 0) {
          result[offset + 3] = (finite(second.velocity[0], 'water velocity') - u) / dt;
          result[offset + 4] = (finite(second.velocity[1], 'water velocity') - v) / dt;
          result[offset + 5] = (finite(second.velocity[2], 'water velocity') - w) / dt;
        }
      }
    }
    if (density === 0) wet = 0;
    result.set(wetOffset, offset + 9);
    result[offset + 12] = density;
    result[offset + 13] = wet;
    const speed = hypot(
      body[at + 3]! - result[offset]!,
      body[at + 4]! - result[offset + 1]!,
      body[at + 5]! - result[offset + 2]!,
    );
    result[offset + 14] = model.parameters[5]
      ? skinFriction((speed * model.parameters[1]!) / this.viscosity, this.transition)
      : 0;
  }

  exportPorts(tick: number): readonly Port[] {
    const { lease, fields } = this;
    return lease
      ? [
          { field: fields.kinematics.name, region: lease.kinematics, tick, cell: ORIGIN },
          { field: fields.wake.name, region: lease.wake, tick, cell: ORIGIN },
        ]
      : [];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    const { lease } = this;
    return lease ? [lease.bodies, lease.command, lease.kinematics, lease.wake] : [];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
