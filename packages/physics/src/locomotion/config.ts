import type { Bed, BedSample } from '@margoengine/math/fields';
import { cos, hypot, sin } from '@margoengine/math/pinned';
import type { BedShape } from '../earth/bed.js';
import type { Cell } from '../world/solver.js';
import { locomotionError } from './errors.js';

type V = readonly [number, number, number];

/** An authored foot and its clock phase in a body-local frame (Y up, Z forward). */
export interface GroundGaitFoot {
  /** Leg attachment relative to the COM, m. */
  readonly hip: V;
  /** Nominal horizontal foothold relative to the body, m. Only X and Z are used. */
  readonly rest: readonly [number, number];
  /** Phase offset in cycles, in [0, 1). Zero begins stance. */
  readonly phase: number;
}

interface BodyOptions {
  /** Initial COM in metres relative to the solver's origin cell. The preset starts on a plane at Y=0. */
  readonly position?: V;
  /** Initial linear velocity in m/s. Default zero. */
  readonly velocity?: V;
  /** Heading around +Y in radians. Default zero (+Z). */
  readonly heading?: number;
  /** Body mass in kg. Default 0.4 for snake, otherwise the gait preset's reference mass. */
  readonly mass?: number;
  /** Uniform body inertia in kg m². Default mass × length² / 12, plus the snake's distributed mass. */
  readonly inertia?: number;
  /** Cycles/s. Default 1 for snake, otherwise the gait preset's frequency. Zero holds the current shape. */
  readonly frequency?: number;
  /** Initial gait phase in cycles, in [0, 1). Default zero. */
  readonly phase?: number;
  /** Normal stiffness in N/m (whole snake or per leg). Defaults to support of the body's weight. */
  readonly stiffness?: number;
  /** Damping in N s/m (whole snake or per leg). Default damping ratio 0.7. */
  readonly damping?: number;
  /** Cohesionless friction coefficient. Default 0.11 forward for snake and 0.8 for legs. */
  readonly friction?: number;
}

/** A body that crawls with prescribed lateral undulation. */
export interface SlitheringBody extends BodyOptions {
  readonly kind: 'snake';
  /** Tail-to-head chain length in m, default 1. */
  readonly length?: number;
  /** Number of inextensible links, default 32. */
  readonly links?: number;
  /** Radius of each link in m, default 0.025. */
  readonly radius?: number;
  /** Maximum tangent bend at a link in radians, default 0.48. */
  readonly bend?: number;
  /** Number of traveling waves along the chain, default 2. */
  readonly waves?: number;
  /** Friction coefficient for backwards motion along a link, default 0.14. */
  readonly reverseFriction?: number;
  /** Friction coefficient across a link, default 0.19. */
  readonly lateralFriction?: number;
  /** Slip speed in m/s below which the friction is regularized linearly, default 0.06. */
  readonly slipSpeed?: number;
}

/** A small legged animal with compression springs and clocked foot placement. */
export interface SmallLeggedBody extends BodyOptions {
  readonly kind: 'lizard' | 'insect' | 'spider' | 'crab';
  /** Distance between first and last hip pairs in m, default from the preset. */
  readonly length?: number;
  /** Left to right hip width in m, default from the preset. */
  readonly width?: number;
  /** Uncompressed leg length in m, default from the preset. */
  readonly legLength?: number;
  /** Desired travel per cycle, m. Default 0.35 × leg length. */
  readonly stride?: number;
  /** Swing clearance above the local bed, m. Default 0.28 × leg length. */
  readonly swingHeight?: number;
  /** Fraction of each cycle in stance, in (0, 1). Default 0.58. */
  readonly duty?: number;
  /** Final stance extension as a fraction of leg length, default 0.04. */
  readonly push?: number;
  /** Foot-placement response in seconds. Default the inverted-pendulum timescale of a nominal leg. */
  readonly placementResponse?: number;
  /** Grounded horizontal velocity response time in seconds. Default the inverted-pendulum timescale. Zero uses passive axial springs. */
  readonly tractionResponse?: number;
  /** Grounded angular righting response time in seconds. Default the inverted-pendulum timescale. Zero uses passive angular dynamics. */
  readonly postureResponse?: number;
  /** Torso ground-contact radius in m. Default one quarter of the nominal leg length. */
  readonly bodyRadius?: number;
  /** Local XZ gait direction. Default +X for crab, +Z elsewhere. The length is normalized. */
  readonly direction?: readonly [number, number];
  /** Custom feet in output order. Defaults to the preset's diagonal, tripod or tetrapod gait. */
  readonly feet?: readonly GroundGaitFoot[];
}

/** A separate body row of the small-animal world solver. */
export type GroundAnimal = SlitheringBody | SmallLeggedBody;

/** A live leg drive command. The caller supplies SI targets and a footfall clock. */
export interface GroundLeggedDrive {
  /** Desired travel speed in m/s. The contact solver limits the delivered acceleration. */
  readonly speed: number;
  /** Desired heading about +Y in radians. */
  readonly heading: number;
  /** Gait cycles per second. Zero leaves the phase fixed. */
  readonly frequency: number;
  /** Fraction of each cycle in stance, in (0, 1). */
  readonly duty: number;
  /** One offset in cycles per foot, in layout order. */
  readonly phases: readonly number[];
  /** Optional net external force through the COM, expressed in world coordinates, N. */
  readonly force?: V;
  /** Adapt the stance orientation to the combined ground slope and acceleration. Default false. */
  readonly lean?: boolean;
  /** Optional support velocity at the COM, world-axis m/s. Default stationary ground. */
  readonly supportVelocity?: V;
}

/** Configuration for a group's initial state. */
export interface GroundLocomotionParams {
  /** Independent body rows, in port order. */
  readonly bodies: readonly GroundAnimal[];
  /** Fixed terrain implementing the shared Bed contract. Used when no live bed port is requested. */
  readonly bed?: Bed;
  /** Initial solver cell. Defaults to the cell passed to PhysicsWorld.add and must match it if supplied. */
  readonly originCell?: Cell;
  /** Flat ground height over the solver's datum, m, when neither bed option is used. Default zero. */
  readonly groundHeight?: number;
}

/** Configures the optional kernel load and live terrain input. */
export interface GroundLocomotionOptions {
  /** Solver id in the world, default 'ground-locomotion'. */
  readonly id?: string;
  /** Origin cell length in metres when bridging a nonzero bed cell. Use the world's cell size (default 1024 m). */
  readonly cellSize?: number;
  /** Matching geometry of a TerrainBed. Configuring it declares the live bed input. */
  readonly bedShape?: BedShape;
  /** Make leg drive commands part of the snapshot state, default false. */
  readonly controlled?: boolean;
  /** Override the pose field's registry name for an independent group. */
  readonly poseField?: string;
  /** Override the contact field's registry name for an independent group. */
  readonly contactField?: string;
  /** Native participants including the caller. Use 1 (default), 2 or 4. */
  readonly threads?: 1 | 2 | 4;
  /** Cancels kernel loading. */
  readonly signal?: AbortSignal;
}

interface Preset {
  readonly pairs: number;
  readonly mass: number;
  readonly length: number;
  readonly width: number;
  readonly leg: number;
  readonly frequency: number;
}

const PRESETS: Record<SmallLeggedBody['kind'], Preset> = {
  lizard: { pairs: 2, mass: 0.035, length: 0.11, width: 0.04, leg: 0.06, frequency: 3 },
  insect: { pairs: 3, mass: 0.003, length: 0.037, width: 0.015, leg: 0.023, frequency: 6 },
  spider: { pairs: 4, mass: 0.02, length: 0.048, width: 0.034, leg: 0.045, frequency: 4 },
  crab: { pairs: 4, mass: 0.06, length: 0.052, width: 0.08, leg: 0.048, frequency: 4 },
};

export interface Model {
  readonly body: readonly number[];
  readonly profile: readonly number[];
  readonly actuators: readonly number[];
  readonly count: number;
  readonly autoHeight: boolean;
  readonly minimumHz: number;
}

export function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw locomotionError('Pass a finite ground locomotion ' + name + '.');
  return value;
}

function nonnegative(value: number, name: string): number {
  if (finite(value, name) < 0) throw locomotionError('Pass a nonnegative ground locomotion ' + name + '.');
  return value;
}

export function positive(value: number, name: string): number {
  if (finite(value, name) <= 0) throw locomotionError('Pass a positive ground locomotion ' + name + '.');
  return value;
}

function cycle(value: number, name: string): number {
  if (nonnegative(value, name) >= 1) throw locomotionError('Pass ' + name + ' as a phase in [0, 1) cycles.');
  return value;
}

function vector(value: V, name: string): V {
  if (value?.length !== 3 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || !Number.isFinite(value[2]))
    throw locomotionError('Pass three finite Cartesian components for ' + name + '.');
  return value;
}

function defaultFeet(pairs: number, length: number, width: number, leg: number): GroundGaitFoot[] {
  const feet: GroundGaitFoot[] = [];
  for (let pair = 0; pair < pairs; pair++) {
    const z = length * (0.5 - pair / (pairs - 1));
    for (let side = 0; side < 2; side++) {
      const x = (side === 0 ? -1 : 1) * 0.5 * width;
      feet.push({ hip: [x, 0, z], rest: [x + Math.sign(x) * 0.25 * leg, z], phase: ((pair + side) % 2) * 0.5 });
    }
  }
  return feet;
}

function legSettings(animal: SmallLeggedBody, preset: Preset, length: number) {
  const size = positive(animal.legLength ?? preset.leg, 'rest leg length');
  const width = positive(animal.width ?? preset.width, 'body width');
  const feet = animal.feet ?? defaultFeet(preset.pairs, length, width, size);
  if (typeof feet.flatMap !== 'function' || !feet.length)
    throw locomotionError('Give a legged body at least one foot.');
  const duty = positive(animal.duty ?? 0.58, 'stance duty');
  if (duty >= 1) throw locomotionError('Pass a stance duty strictly between zero and one.');
  const direction = animal.direction ?? (animal.kind === 'crab' ? [1, 0] : [0, 1]);
  if (direction.length !== 2 || !direction.every(Number.isFinite))
    throw locomotionError('Pass a gait direction with two finite X and Z components.');
  const axis = positive(hypot(direction[0], direction[1]), 'gait direction length');
  const actuators = feet.flatMap((foot) => {
    if (foot?.rest?.length !== 2) throw locomotionError('Pass a foot rest with X and Z offsets.');
    return [
      ...vector(foot.hip, 'hip position'),
      finite(foot.rest[0], 'foot X'),
      0,
      finite(foot.rest[1], 'foot Z'),
      cycle(foot.phase, 'foot phase'),
    ];
  });
  return {
    size,
    width,
    count: feet.length,
    duty,
    direction: [direction[0] / axis, 0, direction[1] / axis],
    actuators,
    stride: nonnegative(animal.stride ?? 0.35 * size, 'stride'),
    swing: nonnegative(animal.swingHeight ?? 0.28 * size, 'swing clearance'),
    push: nonnegative(animal.push ?? 0.04, 'stance extension'),
    response: animal.placementResponse,
    traction: animal.tractionResponse,
    posture: animal.postureResponse,
    bodyRadius: positive(animal.bodyRadius ?? 0.25 * size, 'torso radius'),
    arm: feet.reduce((arm, foot) => Math.max(arm, hypot(...foot.hip)), 0),
  };
}

export function makeModel(animal: GroundAnimal, gravity: number): Model {
  if (!animal) throw locomotionError('Supply an animal configuration with its gait kind.');
  const snake = animal.kind === 'snake' ? animal : undefined;
  const preset = animal.kind !== 'snake' && Object.hasOwn(PRESETS, animal.kind) ? PRESETS[animal.kind] : undefined;
  if (!snake && !preset) throw locomotionError('Choose a snake, lizard, insect, spider or crab gait.');
  const length = positive(animal.length ?? preset?.length ?? 1, 'body length');
  const mass = positive(animal.mass ?? preset?.mass ?? 0.4, 'mass');
  const frequency = nonnegative(animal.frequency ?? preset?.frequency ?? 1, 'gait frequency');
  const friction = nonnegative(animal.friction ?? (snake ? 0.11 : 0.8), 'friction');
  const phase = cycle(animal.phase ?? 0, 'body phase');
  const yaw = finite(animal.heading ?? 0, 'heading');
  const legs = animal.kind !== 'snake' && preset ? legSettings(animal, preset, length) : undefined;
  const count = legs ? legs.count + 1 : (snake?.links ?? 32);
  if (!Number.isSafeInteger(count) || count < 1)
    throw locomotionError('Pass a positive safe integer number of links or feet.');
  const radius = snake ? positive(snake.radius ?? 0.025, 'link radius') : 0;
  const size = legs?.size ?? length;
  const inertia = positive(
    animal.inertia ?? (mass * (snake ? radius * radius : length * length + legs!.width * legs!.width)) / 12,
    'inertia',
  );
  const loadLegs = legs ? Math.max(1, legs.count * 0.5) : 1;
  const modalMass = mass / loadLegs;
  const clearance = snake ? radius * 0.15 : size * 0.08;
  const stiffness = nonnegative(
    animal.stiffness ?? Math.max((modalMass * gravity) / clearance, modalMass * frequency * frequency),
    'stiffness',
  );
  const damping = nonnegative(animal.damping ?? 1.4 * Math.sqrt(stiffness * modalMass), 'damping');
  const slip = snake ? positive(snake.slipSpeed ?? 0.06, 'slip speed') : 1;
  const lateral = snake ? nonnegative(snake.lateralFriction ?? 0.19, 'lateral friction') : 0;
  const backward = snake ? nonnegative(snake.reverseFriction ?? 0.14, 'reverse friction') : 0;
  const waves = snake ? positive(snake.waves ?? 2, 'wave count') : 0;
  const angle = snake ? nonnegative(snake.bend ?? 0.48, 'bend') : 0;
  const arm = legs ? Math.max(legs.arm, legs.bodyRadius) : 0;
  const contactModes = legs ? 2 * legs.count * (1 / mass + (arm * arm) / inertia) : 1 / mass;
  const time = legs && gravity > 0 && frequency > 0 ? Math.sqrt((0.87 * size) / gravity) : 0;
  const placement = nonnegative(legs?.response ?? time, 'foot placement response');
  const traction = nonnegative(legs?.traction ?? time, 'traction response');
  const posture = nonnegative(legs?.posture ?? time, 'posture response');
  const frictionRate = snake ? (Math.max(friction, backward, lateral) * stiffness * radius) / (mass * slip) : 0;
  const gaitRate = 4 * frequency * (legs ? 1 / Math.min(legs.duty, 1 - legs.duty) : 1);
  const minimumHz = Math.max(
    2 * Math.sqrt(stiffness * contactModes) + 2 * damping * contactModes,
    frictionRate,
    gaitRate,
    traction > 0 ? 2 / traction : 0,
    posture > 0 ? 4 / posture : 0,
  );
  const position = vector(animal.position ?? [0, snake ? radius - clearance : 0.87 * size, 0], 'initial position');
  return {
    body: [
      ...position,
      ...vector(animal.velocity ?? [0, 0, 0], 'initial velocity'),
      0,
      sin(yaw * 0.5),
      0,
      cos(yaw * 0.5),
      0,
      0,
      0,
      phase,
    ],
    profile: [
      snake ? 1 : 0,
      mass,
      inertia,
      stiffness,
      damping,
      friction,
      frequency,
      size,
      legs?.stride ?? radius,
      legs?.swing ?? 0,
      legs?.duty ?? 0.5,
      ...(legs?.direction ?? [0, 0, 1]),
      angle,
      waves,
      lateral,
      backward,
      slip,
      legs?.push ?? 0,
      placement,
      legs?.bodyRadius ?? 0,
      traction,
      posture,
      sin(yaw * 0.5),
      cos(yaw * 0.5),
      (legs?.stride ?? 0) * frequency,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ],
    actuators: legs?.actuators ?? [],
    count,
    autoHeight: animal.position === undefined,
    minimumHz,
  };
}

export function sampleBed(bed: Bed, x: number, z: number, out: BedSample): BedSample {
  const point = bed.sample(x, z, out);
  const normal = point?.normal;
  if (normal?.length !== 3 || !Number.isFinite(point.elevation) || !(normal[1] > 0))
    throw locomotionError('Provide finite bed elevations and finite upward normals for ground locomotion.');
  const length = hypot(...normal);
  if (!Number.isFinite(length) || length <= 0)
    throw locomotionError('Provide finite upward normals with a nonzero length for ground locomotion.');
  out.elevation = point.elevation;
  out.normal[0] = normal[0] / length;
  out.normal[1] = normal[1] / length;
  out.normal[2] = normal[2] / length;
  return out;
}
