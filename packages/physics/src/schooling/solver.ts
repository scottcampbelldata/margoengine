import type { MutableVec3, Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { FlowField, FlowSample } from '@margoengine/math/fields';
import { hypot } from '@margoengine/math/pinned';
import { pointMotion, pointVelocity } from '../../../shared/point-motion.js';
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
import { loadSchoolKernel, schoolKernel } from './kernel.js';

/** Layout version of the school ports. Kinematics rows are six f64 words. Intent rows are three f64 words. */
export const SCHOOL_LAYOUT = 1;
/** School member input for an intent-only solver. Rows are x, y, z, vx, vy, vz in the writer's cell. */
export const SCHOOL_KINEMATICS_FIELD: FieldDescriptor = Object.freeze({
  name: 'schoolKinematics',
  kind: 'particleSet',
  centring: 'particle',
  quantity: 'position and linear velocity',
  unit: 'm, m/s',
});
/** Predators: rows are x, y, z, vx, vy, vz in the writer's cell. */
export const SCHOOL_PREDATORS_FIELD: FieldDescriptor = Object.freeze({
  ...SCHOOL_KINEMATICS_FIELD,
  name: 'schoolPredators',
});
/** Desired medium-relative velocity, three f64 words per member in input row order. */
export const SCHOOL_INTENT_FIELD: FieldDescriptor = Object.freeze({
  name: 'schoolIntent',
  kind: 'particleSet',
  centring: 'particle',
  quantity: 'velocity',
  unit: 'm/s',
});

const BODY_WORDS = 6;
const INTENT_WORDS = 3;
const MEDIUM_WORDS = 4;
const ORIGIN: Cell = [0, 0, 0];

/** A member or predator positioned within the origin cell. Velocity is in world axes. */
export interface SchoolBody {
  readonly position: Vec3;
  readonly velocity: Vec3;
}

/** A member's starting state and, in point-mass mode, its locomotion parameters. */
export interface SchoolMember extends SchoolBody {
  /** Inertial mass, kg (default 1). */
  readonly mass?: number;
  /** Drag coefficient times the reference area, m² (default 0). */
  readonly dragArea?: number;
  /** Peak thrust, N (default 1). */
  readonly maxThrust?: number;
  /** Maximum lateral acceleration relative to the medium, m/s² (default 2). */
  readonly maxLateralAcceleration?: number;
  /** Minimum local radius of a propulsive turn, m (default 0.2). */
  readonly minimumTurnRadius?: number;
}

/** School settings, declared before the solver is added to the world. */
export interface SchoolOptions {
  /** Unique solver id (default 'school'). */
  readonly id?: string;
  /** 60 * 2^level ticks per second (default 0). */
  readonly level?: RateLevel;
  /** 'point-mass' simulates locomotion. 'intent' reads the kinematics port and leaves locomotion to the body solver. */
  readonly mode?: 'point-mass' | 'intent';
  /** Declare and use the predators port instead of the static state in params (default false). */
  readonly readPredators?: boolean;
  /** Override registry field names when several groups have their own ports. */
  readonly fields?: { readonly intent?: string; readonly kinematics?: string; readonly predators?: string };
  /** Cancellation for loading and compiling the optional Wasm asset. */
  readonly signal?: AbortSignal;
}

/** Initial rows and rules. Distances are in metres, speeds in m/s. */
export interface SchoolParams {
  readonly members: readonly SchoolMember[];
  /** Predators of constant velocity, initialized at the time the solver is added. */
  readonly predators?: readonly SchoolBody[];
  /** Number of predator rows on the optional port (default 0). */
  readonly predatorCount?: number;
  /** Priority repulsion inside this radius (default 0.5). */
  readonly repulsionRadius?: number;
  /** Heading alignment between the repulsion and orientation radii (default 2). */
  readonly orientationRadius?: number;
  /** Cohesion outside the orientation radius out to this sensing radius (default 6). */
  readonly attractionRadius?: number;
  /** Maximum eligible social neighbours. Defaults to all members inside the sensing zone. */
  readonly neighbours?: number;
  /** Cosine of the half-angle of the field of view for social neighbours (default -1, full view). */
  readonly visionDot?: number;
  /** Escape when predicted closest distance is below this radius (default 2). */
  readonly predatorRadius?: number;
  /** Time ahead searched for a predator encounter, seconds (default 1). */
  readonly predictionSeconds?: number;
  /** Desired cruise speed relative to the medium (default 1). */
  readonly cruiseSpeed?: number;
  /** Velocity response time for the thrust controller in seconds (default 0.5). */
  readonly responseSeconds?: number;
  /** Local medium used for orientation and field of view. Point-mass dynamics also read its drag and velocity. */
  readonly flow?: FlowField;
  /** Fallback medium density, kg/m³, if flow is absent (default 1.225). */
  readonly density?: number;
  /** Must match the world when a flow/port has another origin cell. Defaults to 4096 m. */
  readonly cellSize?: number;
}

/** A copied member reading. Vectors can be reused across reads. */
export interface SchoolReading {
  position: MutableVec3;
  velocity: MutableVec3;
  intent: MutableVec3;
}

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(name + ' must be finite and nonnegative. See SchoolParams and SchoolMember in the README.');
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || !(value > 0))
    throw new RangeError(name + ' must be finite and positive. See SchoolParams and SchoolMember in the README.');
  return value;
}

function count(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 0xffff_ffff)
    throw new RangeError(name + ' must be a row count at least ' + minimum + ' and fit in a Wasm index.');
  return value;
}

function writeBody(array: Float64Array, index: number, body: SchoolBody): void {
  const { position, velocity } = body;
  if (
    !position ||
    position.length !== 3 ||
    ![...position].every((x) => Number.isFinite(Math.fround(x))) ||
    !velocity ||
    velocity.length !== 3 ||
    ![...velocity].every((x) => Number.isFinite(Math.fround(x)))
  )
    throw new RangeError('School bodies need finite position and velocity triples in simulation units.');
  array.set(position, index);
  array.set(velocity, index + 3);
}

function words(host: SolverHost, region: Region): Float64Array {
  return new Float64Array((region.memory ?? host.memory).buffer, region.byteOffset, region.byteLength / 8);
}

function readRows(
  host: SolverHost,
  port: Port | undefined,
  rows: Float64Array,
  cell: Cell,
  cellSize: number,
  field: FieldDescriptor,
): void {
  if (!port) throw new MargoError('state', 'Connect a writer for ' + field.name + ' before stepping the school.');
  if (port.region.type !== 'f64' || port.region.layout !== SCHOOL_LAYOUT || port.region.byteLength !== rows.byteLength)
    throw new RangeError(field.name + ' needs SCHOOL_LAYOUT and exactly one six-f64 row per configured body.');
  const source = words(host, port.region);
  const tx = (port.cell[0] - cell[0]) * cellSize;
  const ty = (port.cell[1] - cell[1]) * cellSize;
  const tz = (port.cell[2] - cell[2]) * cellSize;
  rows.set(source);
  for (let j = 0; j < rows.length; j += BODY_WORDS) {
    rows[j]! += tx;
    rows[j + 1]! += ty;
    rows[j + 2]! += tz;
    for (let k = 0; k < BODY_WORDS; k++)
      if (!Number.isFinite(Math.fround(rows[j + k]!)))
        throw new RangeError(field.name + ' must provide finite body rows in simulation units.');
  }
}

/** Collective animal motion with local sensing, predictive predator avoidance and optional SI point-mass dynamics. */
export class SchoolSolver implements Solver<SchoolParams> {
  private host: SolverHost | undefined;
  private stepKernel: ReturnType<typeof schoolKernel> | undefined;
  private readonly fields: { intent: FieldDescriptor; kinematics: FieldDescriptor; predators: FieldDescriptor };
  private readonly options: Required<Pick<SchoolOptions, 'id' | 'level' | 'mode' | 'readPredators'>>;
  private motion: Region | undefined;
  private intent: Region | undefined;
  private predatorState: Region | undefined;
  private nextMotion: Region | undefined;
  private nextIntent: Region | undefined;
  private nextPredators: Region | undefined;
  private nextMedium: Region | undefined;
  private schoolSize = 0;
  private predatorSize = 0;
  private rules: [number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0];
  private response = 0.5;
  private cruiseSpeed = 1;
  private density = 1.225;
  private cellSize = 4096;
  private flow: FlowField | undefined;
  private dynamics: { settings: ReturnType<typeof pointMotion>; thrust: number; area: number }[] = [];
  private readonly flowSample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly force: MutableVec3 = [0, 0, 0];
  private readonly velocity: MutableVec3 = [0, 0, 0];
  private readonly ambient: MutableVec3 = [0, 0, 0];

  private constructor(
    private readonly module: WebAssembly.Module,
    options: SchoolOptions,
  ) {
    const { id = 'school', level = 0, mode = 'point-mass', readPredators = false, fields } = options;
    if (!isRateLevel(level) || (mode !== 'point-mass' && mode !== 'intent'))
      throw new RangeError('Use rate level 0–7 and mode point-mass or intent for a school.');
    this.options = { id, level, mode, readPredators };
    this.fields = {
      intent: fields?.intent === undefined ? SCHOOL_INTENT_FIELD : { ...SCHOOL_INTENT_FIELD, name: fields.intent },
      kinematics:
        fields?.kinematics === undefined
          ? SCHOOL_KINEMATICS_FIELD
          : { ...SCHOOL_KINEMATICS_FIELD, name: fields.kinematics },
      predators:
        fields?.predators === undefined
          ? SCHOOL_PREDATORS_FIELD
          : { ...SCHOOL_PREDATORS_FIELD, name: fields.predators },
    };
  }

  /** Loads the optional Wasm and creates a solver. Add it to a PhysicsWorld with SchoolParams. */
  static async load(options: SchoolOptions = {}): Promise<SchoolSolver> {
    return new SchoolSolver(await loadSchoolKernel(options.signal), options);
  }

  describe(): SolverDescription {
    const { id, level, mode, readPredators } = this.options;
    return {
      id,
      rate: level,
      stableRate: () => level,
      fields: [
        { field: this.fields.intent, access: 'write' },
        ...(mode === 'intent' ? [{ field: this.fields.kinematics, access: 'read' as const }] : []),
        ...(readPredators ? [{ field: this.fields.predators, access: 'read' as const }] : []),
      ],
    };
  }

  init(host: SolverHost, params: SchoolParams): void {
    if (this.host) throw new MargoError('state', 'This school already belongs to a world. Load another instance.');
    const { members, predators = [], flow } = params;
    if (!Array.isArray(members) || members.length === 0)
      throw new RangeError('A school needs at least one member position and velocity.');
    if (!Array.isArray(predators) || (this.options.readPredators && predators.length !== 0))
      throw new RangeError('Provide constant-velocity predators in params or read the predator port.');
    if (
      flow &&
      (typeof flow.sample !== 'function' ||
        !flow.cell ||
        flow.cell.length !== 3 ||
        !flow.cell.every(Number.isSafeInteger))
    )
      throw new RangeError('The school flow must implement the FlowField sampling and cell contract.');

    const repulsion = nonnegative(params.repulsionRadius ?? 0.5, 'repulsionRadius');
    const orientation = nonnegative(params.orientationRadius ?? 2, 'orientationRadius');
    const attraction = positive(params.attractionRadius ?? 6, 'attractionRadius');
    const vision = params.visionDot ?? -1;
    if (
      repulsion > orientation ||
      orientation > attraction ||
      !(Math.fround(attraction * 2) > 0 && Number.isFinite(Math.fround(attraction * 2)))
    )
      throw new RangeError(
        'Set positive attraction and nonnegative repulsion and orientation radii in ascending order.',
      );
    if (!(Number.isFinite(vision) && vision >= -1 && vision <= 1))
      throw new RangeError('Set visionDot to a cosine from -1 to 1.');
    const neighbours = count(params.neighbours ?? members.length, 'neighbours', 1);
    const threat = nonnegative(params.predatorRadius ?? 2, 'predatorRadius');
    const prediction = nonnegative(params.predictionSeconds ?? 1, 'predictionSeconds');
    const cellSize = positive(params.cellSize ?? 4096, 'cellSize');
    this.rules = [repulsion, orientation, attraction, vision, neighbours, threat, prediction];
    this.response = positive(params.responseSeconds ?? 0.5, 'responseSeconds');
    this.cruiseSpeed = nonnegative(params.cruiseSpeed ?? 1, 'cruiseSpeed');
    this.density = nonnegative(params.density ?? 1.225, 'density');
    this.cellSize = cellSize;
    this.flow = flow;
    this.schoolSize = count(members.length, 'members', 1);
    this.predatorSize = this.options.readPredators
      ? count(params.predatorCount ?? 0, 'predatorCount', 0)
      : predators.length;
    this.dynamics =
      this.options.mode === 'point-mass'
        ? members.map((member: SchoolMember) => ({
            settings: pointMotion({
              mass: member.mass ?? 1,
              maxLateralAcceleration: member.maxLateralAcceleration ?? 2,
              minimumTurnRadius: member.minimumTurnRadius ?? 0.2,
            }),
            thrust: nonnegative(member.maxThrust ?? 1, 'maxThrust'),
            area: nonnegative(member.dragArea ?? 0, 'dragArea'),
          }))
        : [];

    const bodyBytes = members.length * BODY_WORDS * 8;
    const intentBytes = members.length * INTENT_WORDS * 8;
    const predatorBytes = this.predatorSize * BODY_WORDS * 8;
    this.stepKernel = schoolKernel(this.module, host, this.schoolSize);
    this.motion = host.allocate('school-motion', bodyBytes, 'f64', SCHOOL_LAYOUT);
    this.intent = host.allocate('school-intent', intentBytes, 'f64', SCHOOL_LAYOUT);
    this.predatorState = host.allocate('school-predators', predatorBytes, 'f64', SCHOOL_LAYOUT);
    this.nextMotion = host.allocate('school-motion-next', bodyBytes, 'f64', SCHOOL_LAYOUT);
    this.nextIntent = host.allocate('school-intent-next', intentBytes, 'f64', SCHOOL_LAYOUT);
    this.nextPredators = host.allocate('school-predators-next', predatorBytes, 'f64', SCHOOL_LAYOUT);
    this.nextMedium = host.allocate('school-medium-next', members.length * MEDIUM_WORDS * 8, 'f64', SCHOOL_LAYOUT);
    const initial = words(host, this.motion);
    const predatorWords = words(host, this.predatorState);
    members.forEach((member, i) => writeBody(initial, i * BODY_WORDS, member));
    predators.forEach((predator, i) => writeBody(predatorWords, i * BODY_WORDS, predator));
    this.host = host;
  }

  step(context: StepContext, dt: number): void {
    const { host, motion, intent, predatorState, nextMotion, nextIntent, nextPredators, nextMedium, stepKernel } = this;
    if (
      !host ||
      !motion ||
      !intent ||
      !predatorState ||
      !nextMotion ||
      !nextIntent ||
      !nextPredators ||
      !nextMedium ||
      !stepKernel
    )
      throw new MargoError('state', 'Add the school to a PhysicsWorld before stepping.');
    const rows = words(host, nextMotion);
    const predatorRows = words(host, nextPredators);
    if (this.options.mode === 'intent')
      readRows(
        host,
        context.inputs.get(this.fields.kinematics.name),
        rows,
        context.cell,
        this.cellSize,
        this.fields.kinematics,
      );
    else rows.set(words(host, motion));

    if (this.options.readPredators && predatorRows.length > 0)
      readRows(
        host,
        context.inputs.get(this.fields.predators.name),
        predatorRows,
        context.cell,
        this.cellSize,
        this.fields.predators,
      );
    else predatorRows.set(words(host, predatorState));

    const medium = words(host, nextMedium);
    this.sampleMedium(context, rows, medium);
    const status = stepKernel(
      nextMotion.byteOffset,
      this.schoolSize,
      nextMedium.byteOffset,
      nextPredators.byteOffset,
      this.predatorSize,
      nextIntent.byteOffset,
      ...this.rules,
    );
    if (status !== 0)
      throw new RangeError('School members do not fit the neighbour grid. Use a consistent simulation scale.');
    const desired = words(host, nextIntent);
    for (let i = 0; i < desired.length; i++) desired[i]! *= this.cruiseSpeed;
    if (this.options.mode === 'point-mass') this.move(dt, rows, desired, medium);
    if (!this.options.readPredators) {
      for (let j = 0; j < predatorRows.length; j += BODY_WORDS)
        for (let k = 0; k < 3; k++) predatorRows[j + k]! += predatorRows[j + 3 + k]! * dt;
    }
    words(host, motion).set(rows);
    words(host, intent).set(desired);
    words(host, predatorState).set(predatorRows);
  }

  private sampleMedium(context: StepContext, rows: Float64Array, medium: Float64Array): void {
    const { flow, density, cellSize } = this;
    const t = context.tick / rateOf(context.level);
    const shift = flow ? context.cell.map((value, i) => (value - flow.cell[i]!) * cellSize) : ORIGIN;
    for (let i = 0; i < this.schoolSize; i++) {
      const j = i * BODY_WORDS;
      const ambientAt = i * MEDIUM_WORDS;
      const sample = flow?.sample(
        rows[j]! + shift[0]!,
        rows[j + 1]! + shift[1]!,
        rows[j + 2]! + shift[2]!,
        t,
        this.flowSample,
      );
      const ambient = sample?.velocity ?? ORIGIN;
      const rho = sample ? nonnegative(sample.density, 'flow density') : density;
      if (ambient.length !== 3 || !ambient.every((x) => Number.isFinite(Math.fround(x))))
        throw new RangeError(
          'The school flow sampled a non-finite velocity. Provide a finite velocity triple from FlowField.sample.',
        );
      medium.set(ambient, ambientAt);
      medium[ambientAt + 3] = rho;
    }
  }

  private move(dt: number, rows: Float64Array, intent: Float64Array, medium: Float64Array): void {
    const { response, force, velocity, ambient } = this;
    for (let i = 0; i < this.schoolSize; i++) {
      const j = i * BODY_WORDS;
      const k = i * INTENT_WORDS;
      const ambientAt = i * MEDIUM_WORDS;
      const { settings, thrust, area } = this.dynamics[i]!;
      const drag = 0.5 * medium[ambientAt + 3]! * area;
      for (let axis = 0; axis < 3; axis++) ambient[axis] = medium[ambientAt + axis]!;
      settings.dragRate = nonnegative(drag / settings.mass, 'specific drag');
      settings.fluidVelocity = ambient;
      const dragAtCruise = drag * hypot(intent[k]!, intent[k + 1]!, intent[k + 2]!);
      for (let axis = 0; axis < 3; axis++) {
        velocity[axis] = rows[j + axis + 3]!;
        const target = intent[k + axis]!;
        force[axis] = (settings.mass * (target - velocity[axis]! + ambient[axis]!)) / response + dragAtCruise * target;
      }
      const total = hypot(force[0], force[1], force[2]);
      if (total > thrust) {
        const scale = thrust / total;
        force[0] *= scale;
        force[1] *= scale;
        force[2] *= scale;
      }
      pointVelocity(velocity, force, dt, settings, Infinity, velocity);
      for (let axis = 0; axis < 3; axis++) {
        rows[j + axis]! += velocity[axis]! * dt;
        rows[j + axis + 3] = velocity[axis]!;
        if (!Number.isFinite(Math.fround(rows[j + axis]!)))
          throw new RangeError(
            'A school member moved outside its numerical range. Use an origin cell closer to the member and consistent simulation units.',
          );
      }
    }
  }

  /** Copies one member's current state and desired medium-relative velocity. */
  read(
    row: number,
    out: SchoolReading = { position: [0, 0, 0], velocity: [0, 0, 0], intent: [0, 0, 0] },
  ): SchoolReading {
    const { host, motion, intent } = this;
    if (!host || !motion || !intent) throw new MargoError('state', 'Add the school to a PhysicsWorld before reading.');
    if (!Number.isInteger(row) || row < 0 || row >= this.schoolSize)
      throw new RangeError('School row must name a configured member.');
    const bodies = words(host, motion);
    const targets = words(host, intent);
    for (let axis = 0; axis < 3; axis++) {
      out.position[axis] = bodies[row * BODY_WORDS + axis]!;
      out.velocity[axis] = bodies[row * BODY_WORDS + axis + 3]!;
      out.intent[axis] = targets[row * INTENT_WORDS + axis]!;
    }
    return out;
  }

  exportPorts(tick: number): readonly Port[] {
    return this.intent ? [{ field: this.fields.intent.name, region: this.intent, tick, cell: ORIGIN }] : [];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    return this.motion && this.intent && this.predatorState ? [this.motion, this.intent, this.predatorState] : [];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
