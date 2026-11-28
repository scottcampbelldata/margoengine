import { cos, hypot, pow, sin } from '@margoengine/math/pinned';
import type {
  GroundAnimalContact,
  GroundAnimalPose,
  GroundGaitFoot,
  GroundLocomotionOptions,
  GroundLocomotionParams,
  LocomotionWorkCounts,
  SmallLeggedBody,
} from '../locomotion/index.js';
import { GROUND_CONTACT_FIELD, GROUND_POSE_FIELD, GroundLocomotion } from '../locomotion/index.js';
import { BODIES_FIELD, BODY_IMPULSES_FIELD, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import { DeckBed, type LeggedDeck } from './deck.js';
import { leggedError } from './errors.js';
export type { LeggedDeck } from './deck.js';
import type {
  FieldDescriptor,
  FieldUse,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';

type V = readonly [number, number, number];
const ZERO: V = [0, 0, 0];
const TARGET_WORDS = 2;
const FORCE_WORDS = 3;
const GAIT_WORDS = 5;

/** Version of the legged motion input and gait-status layouts. */
export const LEGGED_LAYOUT = 1;

/** F64 body rows: desired speed (m/s) and heading about +Y (radians). */
export const LEGGED_INTENT_FIELD: FieldDescriptor = {
  name: 'leggedIntent',
  kind: 'bodySet',
  quantity: 'locomotion command',
  unit: 'm/s, rad',
  centring: 'particle',
};

/** F64 body rows: external world-space force XYZ, in newtons. */
export const LEGGED_LOAD_FIELD: FieldDescriptor = {
  name: 'leggedLoad',
  kind: 'bodySet',
  quantity: 'force',
  unit: 'N',
  centring: 'particle',
};

/** COM pose rows, using the GroundLocomotion body layout. */
export const LEGGED_POSE_FIELD: FieldDescriptor = { ...GROUND_POSE_FIELD, name: 'leggedPose' };

/** Per-foot and torso samples, using the GroundLocomotion contact layout. */
export const LEGGED_CONTACT_FIELD: FieldDescriptor = { ...GROUND_CONTACT_FIELD, name: 'leggedContact' };

/** F64 body rows: gait code, leg cycles/s, stride length, duty factor, torso-contact flag. */
export const LEGGED_GAIT_FIELD: FieldDescriptor = {
  name: 'leggedGait',
  kind: 'bodySet',
  quantity: 'gait status',
  unit: '1, Hz, m, 1, 1',
  centring: 'particle',
};

/** Gait codes in ascending order in the versioned gait field. */
export const LEGGED_GAITS = ['stand', 'walk', 'trot', 'canter', 'gallop', 'run'] as const;

/** The measured or selected gait. */
export type LeggedGait = (typeof LEGGED_GAITS)[number];

/** A requested horizontal speed and heading in the body's origin cell. */
export interface LeggedTarget {
  /** Ground speed in m/s. Default zero when omitted from the initial body. */
  readonly speed: number;
  /** Heading about positive Y in radians. Default zero (+Z). */
  readonly heading: number;
}

/** A biped or quadruped's physical dimensions and initial control. */
export interface LeggedBody {
  readonly kind: 'biped' | 'quadruped';
  /** Initial COM in origin-cell metres. With no position, the animal begins standing on the bed. */
  readonly position?: V;
  /** Initial velocity in m/s, default zero. */
  readonly velocity?: V;
  /** Body mass in kg, default 75 for the biped and 500 for the quadruped. */
  readonly mass?: number;
  /** Mass carried in kg, default zero. */
  readonly loadMass?: number;
  /** Uncompressed leg length in m, default 0.9 for biped and 1.08 for quadruped. */
  readonly legLength?: number;
  /** Left-to-right hip width in m, default 0.3 for biped and 0.44 for quadruped. */
  readonly width?: number;
  /** Distance between hip rows in m for quadrupeds, default 1.42. */
  readonly length?: number;
  /** Coefficient of friction at a contacting foot. Default 0.6. */
  readonly friction?: number;
  /** Initial target, default { speed: 0, heading: 0 }. */
  readonly target?: LeggedTarget;
}

/** One or more independently actuated legged bodies and their surface. */
export interface LeggedParams extends Omit<GroundLocomotionParams, 'bodies'> {
  readonly bodies: readonly LeggedBody[];
}

/** Optional kernel loading and explicit port readers. */
export interface LeggedOptions extends Pick<GroundLocomotionOptions, 'id' | 'bedShape' | 'cellSize' | 'signal'> {
  /** Native participants for independent bodies. Defaults to one. */
  readonly threads?: 1 | 2 | 4;
  /** Reads a writer on the LEGGED_INTENT_FIELD where present. Default false. */
  readonly readIntent?: boolean;
  /** Reads a writer on the LEGGED_LOAD_FIELD where present. Default false. */
  readonly readLoad?: boolean;
  /** Optional moving rigid support. Add the RigidSolver first and couple the two solvers in staggered order. */
  readonly deck?: LeggedDeck;
}

/** Observable physical gait state after a tick. */
export interface LeggedStatus extends GroundAnimalPose {
  readonly gait: LeggedGait;
  readonly frequency: number;
  readonly strideLength: number;
  readonly duty: number;
  /** True when the torso has ground contact. */
  readonly fallen: boolean;
}

interface Character {
  readonly leg: number;
  readonly biped: boolean;
  readonly friction: number;
  readonly body: SmallLeggedBody;
  readonly target: LeggedTarget;
}

interface GaitPattern {
  readonly phases: readonly number[];
  readonly duty: readonly [number, number];
  readonly transition: readonly [number, number];
}

const STAND = { duty: [0.9, 0.9], transition: [0, 1] } as const;
const QUAD_PATTERNS: readonly GaitPattern[] = [
  { ...STAND, phases: [0, 0, 0, 0] },
  { phases: [0.75, 0.25, 0, 0.5], duty: [0.75, 0.6], transition: [0, 0.4] },
  { phases: [0.5, 0, 0, 0.5], duty: [0.48, 0.36], transition: [0.4, 2.4] },
  { phases: [0.5, 0.72, 0.76, 0], duty: [0.46, 0.36], transition: [2.4, 6.5] },
  { phases: [0.53, 0.64, 0.89, 0], duty: [0.32, 0.22], transition: [6.5, 40] },
];
const BIPED_STAND: GaitPattern = { ...STAND, phases: [0, 0] };
const BIPED_WALK: GaitPattern = { phases: [0, 0.5], duty: [0.65, 0.55], transition: [0, 0.5] };
const BIPED_RUN: GaitPattern = { phases: [0, 0.5], duty: [0.49, 0.35], transition: [0.5, 2.4] };

function length(value: number, label: string): number {
  if (!(value > 0) || !Number.isFinite(value))
    throw leggedError('Pass a finite positive ' + label + ' for legged locomotion.');
  return value;
}

function command(target: LeggedTarget): LeggedTarget {
  if (!(target?.speed >= 0) || !Number.isFinite(target.speed) || !Number.isFinite(target.heading))
    throw leggedError('Pass nonnegative speed in metres per second and a finite heading in radians.');
  return target;
}

function model(options: LeggedBody, gravity: number): Character {
  const biped = options.kind === 'biped';
  if (!biped && options.kind !== 'quadruped') throw leggedError('Choose a biped or quadruped body.');
  const leg = length(options.legLength ?? (biped ? 0.9 : 1.08), 'rest leg length');
  const width = length(options.width ?? (biped ? 0.3 : 0.44), 'hip width');
  const base = length(options.length ?? (biped ? 0.4 : 1.42), 'body length');
  const mass = length(options.mass ?? (biped ? 75 : 500), 'body mass');
  const carried = options.loadMass ?? 0;
  if (!(carried >= 0) || !Number.isFinite(carried)) throw leggedError('Pass finite nonnegative carried kilograms.');
  const target = command(options.target ?? { speed: 0, heading: 0 });
  const feet: GroundGaitFoot[] = [];
  for (const z of biped ? [0] : [base / 2, -base / 2]) {
    for (const x of [-width / 2, width / 2]) feet.push({ hip: [x, 0, z], rest: [x, z], phase: 0 });
  }
  const totalMass = mass + carried;
  const friction = options.friction ?? 0.6;
  const inertia = (totalMass * (4 * leg * leg + base * base + width * width)) / 12;
  const posture = gravity > 0 ? Math.sqrt(inertia / (totalMass * gravity * leg)) : 0;
  return {
    biped,
    leg,
    friction,
    target,
    body: {
      kind: 'lizard',
      feet,
      mass: totalMass,
      length: base,
      width,
      legLength: leg,
      position: options.position,
      velocity: options.velocity,
      heading: target.heading,
      inertia,
      postureResponse: posture,
      placementResponse: 0,
      stride: 0,
      frequency: 4,
      duty: 0.55,
      friction,
      bodyRadius: 0.3 * leg,
    },
  };
}

function gaitFor(biped: boolean, froude: number, previous: number, turning: boolean): number {
  if (froude === 0 && !turning) return 0;
  if (biped) return froude > (previous === 5 ? 0.475 : 0.525) ? 5 : 1;
  for (let gait = 1; gait < 4; gait++) {
    const upper = QUAD_PATTERNS[gait]!.transition[1];
    if (froude < upper * (previous > gait ? 0.95 : 1.05)) return gait;
  }
  return 4;
}

function words(host: SolverHost, region: Region): Float64Array {
  return new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / 8);
}

function input(
  host: SolverHost,
  port: Port | undefined,
  field: FieldDescriptor,
  count: number,
  width: number,
): Float64Array | undefined {
  if (!port) return undefined;
  const region = port.region;
  const size = count * width * 8;
  if (
    port.field !== field.name ||
    region.type !== 'f64' ||
    region.layout !== LEGGED_LAYOUT ||
    region.byteLength !== size
  )
    throw leggedError('Provide matching f64 legged rows in the documented layout.', 'version');
  const memory = region.memory ?? host.memory;
  const offset = region.byteOffset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 8 !== 0 || offset > memory.buffer.byteLength - size)
    throw leggedError('Publish legged intent and load rows at aligned offsets within their owning memory.');
  return new Float64Array(memory.buffer, offset, count * width);
}

/** World-registered quadruped and biped locomotion driven by persistent stance contacts. */
export class LeggedLocomotion implements Solver<LeggedParams> {
  private host?: SolverHost;
  private commands?: Region;
  private gait?: Region;
  private nextGait?: Region;
  private reactions?: Region;
  private nextReactions?: Float64Array;
  private driveBackups: readonly { region: Region; previous: Float64Array }[] = [];
  private stepping = false;
  private disposed = false;
  private deck?: DeckBed;
  private rows: readonly Character[] = [];
  private gravity = 0;
  private readonly reads: readonly FieldUse[];
  private readonly support?: LeggedDeck;
  private readonly cellSize: number;
  private readonly pose: GroundAnimalPose = {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    angularMomentum: [0, 0, 0],
    phase: 0,
  };
  private readonly contact: GroundAnimalContact = {
    position: [0, 0, 0],
    axis: [0, 0, 1],
    force: [0, 0, 0],
    couple: [0, 0, 0],
    stance: false,
  };
  private readonly force: [number, number, number] = [0, 0, 0];

  private constructor(
    private readonly ground: GroundLocomotion,
    options: LeggedOptions,
  ) {
    const reads: FieldUse[] = [];
    if (options.readIntent) reads.push({ field: LEGGED_INTENT_FIELD, access: 'read' });
    if (options.readLoad) reads.push({ field: LEGGED_LOAD_FIELD, access: 'read' });
    this.support = options.deck && { ...options.deck };
    this.cellSize = options.cellSize ?? 1024;
    if (this.support) {
      reads.push({ field: BODIES_FIELD, access: 'read' }, { field: BODY_IMPULSES_FIELD, access: 'accumulate' });
    }
    this.reads = reads;
  }

  /** Loads only the optional ground contact kernel. */
  static async load(options: LeggedOptions = {}): Promise<LeggedLocomotion> {
    if (options.deck && options.bedShape)
      throw leggedError('Pass a fixed Bed fallback instead of live bed geometry with a rigid deck.');
    const ground = await GroundLocomotion.load({
      ...options,
      id: options.id ?? 'legged-locomotion',
      controlled: true,
      poseField: LEGGED_POSE_FIELD.name,
      contactField: LEGGED_CONTACT_FIELD.name,
    });
    return new LeggedLocomotion(ground, options);
  }

  /** Release the optional locomotion helpers after stopping the world. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.requireIdle();
    this.disposed = true;
    this.ground[Symbol.dispose]();
  }

  /** Native contact work of the most recent accepted step. */
  readNativeWork(): LocomotionWorkCounts | undefined {
    return this.ground.readNativeWork();
  }

  describe(): SolverDescription {
    const base = this.ground.describe();
    return {
      ...base,
      fields: [...base.fields, ...this.reads, { field: LEGGED_GAIT_FIELD, access: 'write' }],
    };
  }

  init(host: SolverHost, params: LeggedParams): void {
    this.requireIdle();
    if (this.host) throw leggedError('Load an independent legged solver for each PhysicsWorld.', 'attached');
    if (!params?.bodies?.length) throw leggedError('Supply at least one biped or quadruped body.');
    const gravity = hypot(...host.gravity);
    const rows = params.bodies.map((body) => model(body, gravity));
    const initial = host.allocate('legged-drives', rows.length * TARGET_WORDS * 8, 'f64', LEGGED_LAYOUT);
    const gait = host.allocate('legged-status', rows.length * GAIT_WORDS * 8, 'f64', LEGGED_LAYOUT);
    const next = host.allocate('legged-next-status', rows.length * GAIT_WORDS * 8, 'f64', LEGGED_LAYOUT);
    const cell = params.originCell ?? host.cell;
    const deck = this.support
      ? new DeckBed(this.support, this.cellSize, cell, params.bed, params.groundHeight ?? 0)
      : undefined;
    const reactions = deck
      ? host.allocate(
          'legged-reactions',
          deck.refresh(host, host.port(BODIES_FIELD.name), cell) * IMPULSE_WORDS * 8,
          'f64',
          1,
        )
      : undefined;
    this.ground.init(host, { ...params, bed: deck ?? params.bed, bodies: rows.map((row) => row.body) });
    const commands = words(host, initial);
    const status = words(host, gait);
    for (const [i, { target }] of rows.entries()) {
      commands.set([target.speed, target.heading], i * TARGET_WORDS);
      status.set([0, 0, 0, 0.9, 0], i * GAIT_WORDS);
    }
    this.host = host;
    this.commands = initial;
    this.gait = gait;
    this.nextGait = next;
    this.deck = deck;
    this.reactions = reactions;
    this.nextReactions = reactions && new Float64Array(reactions.byteLength / 8);
    this.driveBackups = this.ground.extraState().map((region) => ({
      region,
      previous: new Float64Array(region.byteLength / 8),
    }));
    this.rows = rows;
    this.gravity = gravity;
  }

  /** Stores a target in the world's snapshot state. A live intent port takes priority when present. */
  setTarget(row: number, target: LeggedTarget): void {
    this.requireIdle();
    this.checkRow(row);
    const { speed, heading } = command(target);
    words(this.host!, this.commands!).set([speed, heading], row * TARGET_WORDS);
  }

  private checkRow(row: number): void {
    if (!Number.isInteger(row) || row < 0 || row >= this.rows.length)
      throw leggedError('Use the row index of a configured legged body.');
  }

  private requireIdle(): void {
    if (this.disposed) throw leggedError('Load a new legged solver after disposing its helpers.', 'disposed');
    if (this.stepping) throw leggedError('Update, dispose or step legged locomotion after the current step finishes.');
  }

  /** Latest pose and physical gait. */
  read(row: number): LeggedStatus {
    this.checkRow(row);
    const status = words(this.host!, this.gait!);
    const at = row * GAIT_WORDS;
    return {
      ...this.ground.read(row),
      gait: LEGGED_GAITS[status[at]!]!,
      frequency: status[at + 1]!,
      strideLength: status[at + 2]!,
      duty: status[at + 3]!,
      fallen: status[at + 4] === 1,
    };
  }

  /** Reads a foot row, or the torso in the last row (two feet for bipeds, four for quadrupeds). */
  readContact(row: number, foot: number, out?: GroundAnimalContact): GroundAnimalContact {
    this.checkRow(row);
    return this.ground.readContact(row, foot, out);
  }

  step(context: StepContext, dt: number): void {
    this.requireIdle();
    const { host, commands, gait, nextGait, deck, reactions, nextReactions } = this;
    if (!host || !commands || !gait || !nextGait)
      throw leggedError('Add the legged locomotion solver to a PhysicsWorld before stepping.');
    if (!Number.isFinite(dt) || dt < 0) throw leggedError('Pass a finite nonnegative legged step in seconds.');
    for (const { region, previous } of this.driveBackups) previous.set(words(host, region));
    this.stepping = true;
    try {
      if (deck) deck.refresh(host, context.inputs.get(BODIES_FIELD.name), context.cell);
      this.configure(context, host, commands, gait, nextGait);
      this.ground.stepWithContacts(context, dt, (read) => {
        const gaitTrial = words(host, nextGait);
        nextReactions?.fill(0);
        for (const [i, row] of this.rows.entries()) {
          const feet = row.biped ? 2 : 4;
          const torso = read(i, feet, this.contact);
          gaitTrial[i * GAIT_WORDS + 4] = torso.stance ? 1 : 0;
          if (deck && nextReactions) {
            deck.react(nextReactions, torso, dt);
            for (let foot = 0; foot < feet; foot++) deck.react(nextReactions, read(i, foot, this.contact), dt);
          }
        }
        if (nextReactions && !nextReactions.every(Number.isFinite))
          throw leggedError('Reduce the deck offset, contact force or step duration to keep the reaction finite.');
      });
      words(host, gait).set(words(host, nextGait));
      if (reactions && nextReactions) words(host, reactions).set(nextReactions);
    } catch (cause) {
      for (const { region, previous } of this.driveBackups) words(host, region).set(previous);
      throw cause;
    } finally {
      this.stepping = false;
    }
  }

  private configure(context: StepContext, host: SolverHost, commands: Region, gait: Region, nextGait: Region): void {
    const { deck, rows } = this;
    const controls =
      input(host, context.inputs.get(LEGGED_INTENT_FIELD.name), LEGGED_INTENT_FIELD, rows.length, TARGET_WORDS) ??
      words(host, commands);
    const loads = input(host, context.inputs.get(LEGGED_LOAD_FIELD.name), LEGGED_LOAD_FIELD, rows.length, FORCE_WORDS);
    for (let i = 0; i < rows.length; i++) {
      command({ speed: controls[i * TARGET_WORDS]!, heading: controls[i * TARGET_WORDS + 1]! });
    }
    if (loads?.some((force) => !Number.isFinite(force))) throw leggedError('Pass finite external legged forces.');
    const status = words(host, gait);
    const prospective = words(host, nextGait);
    const gravity = this.gravity;
    for (const [i, row] of rows.entries()) {
      const use = i * TARGET_WORDS;
      const at = i * GAIT_WORDS;
      const target = { speed: controls[use]!, heading: controls[use + 1]! };
      const body = this.ground.read(i, this.pose);
      const support = deck?.velocity(body.position[0], body.position[2]) ?? ZERO;
      const actual = hypot(body.velocity[0] - support[0], body.velocity[2] - support[2]);
      const waveSpeed = Math.sqrt(gravity * row.leg);
      const speed = actual < 0.01 * waveSpeed ? 0 : actual;
      const froude = waveSpeed > 0 ? (speed * speed) / (waveSpeed * waveSpeed) : 0;
      const [qx, qy, qz, qw] = body.rotation;
      const facing =
        sin(target.heading) * 2 * (qx * qz + qw * qy) + cos(target.heading) * (1 - 2 * (qx * qx + qy * qy));
      const pivot = speed === 0 && target.speed === 0 && facing < 0.999;
      const gaitCode = gaitFor(row.biped, froude, status[at]!, pivot);
      const pattern = row.biped
        ? gaitCode === 0
          ? BIPED_STAND
          : gaitCode === 5
            ? BIPED_RUN
            : BIPED_WALK
        : QUAD_PATTERNS[gaitCode]!;
      const [min, max] = pattern.transition;
      const progress = Math.max(0, Math.min(1, (froude - min) / (max - min)));
      const duty = pattern.duty[0] + (pattern.duty[1] - pattern.duty[0]) * progress;
      const empirical = froude > 0 ? 2.3 * row.leg * pow(froude, 0.3) : 0;
      const geometricReach = Math.sqrt(1 - 0.87 * 0.87);
      // A single support foot must also balance the moment of the normal
      // reaction around the COM. Its available couple is mu N times the support lever.
      const oneFootReach = row.friction > 0 ? Math.min(geometricReach, row.friction * 0.5) : geometricReach;
      const reach = row.leg * (row.biped ? oneFootReach : geometricReach);
      const stride = Math.min(empirical, (2 * reach) / duty);
      const frequency = stride > 0 ? speed / stride : pivot ? waveSpeed / (2 * Math.PI * row.leg) : 0;
      for (let axis = 0; axis < 3; axis++) this.force[axis] = loads?.[3 * i + axis] ?? ZERO[axis]!;
      this.ground.setLeggedDrive(i, {
        ...target,
        frequency,
        duty,
        phases: pattern.phases,
        force: this.force,
        lean: true,
        supportVelocity: support,
      });
      prospective.set([gaitCode, frequency, stride, duty], at);
    }
  }

  exportPorts(tick: number): readonly Port[] {
    const base = this.ground.exportPorts(tick);
    if (!this.host) return base;
    const cell = this.host.cell;
    const extra: Port[] = [];
    if (this.gait) extra.push({ field: LEGGED_GAIT_FIELD.name, region: this.gait, tick, cell });
    if (this.reactions) extra.push({ field: BODY_IMPULSES_FIELD.name, region: this.reactions, tick, cell });
    return [...base, ...extra];
  }

  importPorts(tick: number): void {
    this.ground.importPorts(tick);
  }

  stateRegions(): readonly Region[] {
    const base = this.ground.stateRegions();
    return this.commands && this.gait ? [...base, this.commands, this.gait] : base;
  }

  extraState(): readonly Region[] {
    const base = this.ground.extraState();
    return this.reactions ? [...base, this.reactions] : base;
  }
}
