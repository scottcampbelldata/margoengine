import { MargoError } from '@margoengine/math/errors';
import { cos, hypot, sin } from '@margoengine/math/pinned';
import type { Physics, Vehicle, VehicleInput } from '@margoengine/physics';
import type {
  Cell,
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
  PhysicsWorld,
} from '@margoengine/physics/world';
import {
  lookAhead,
  nearest,
  numberIn,
  plannedSpeed,
  sampleRoute,
  type DrivePoint,
  type RoadDrivePath,
  type SampledRoute,
} from './drive-path.js';
import { roadGrip, type RoadTraction } from './road-surface.js';

const ZERO: Cell = [0, 0, 0];
const LAYOUT = 1;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const STEER = 0;
const THROTTLE = 1;
const BRAKE = 2;
const TARGET = 3;
const SPEED = 4;
const PROGRESS = 5;
const WETNESS = 6;
const CURSOR = 7;

/** One fixed-stride row of normalized controls and navigation telemetry per configured vehicle. */
export const ROAD_DRIVER_WORDS = 8;
/** Command port layout. Each row is steer, throttle, brake, target/current speed, progress, wetness and segment index. */
export const ROAD_DRIVER_LAYOUT = 1;

/** A forward lane driver and the rigid body that follows its lane. */
export interface RoadDriverVehicle {
  readonly body: number;
  readonly path: RoadDrivePath;
  readonly traction: RoadTraction;
  /** Maximum approach speed on dry straight sections, m/s. Default 13.9. */
  readonly maxSpeed?: number;
  /** Wheelbase in metres, measured between front and rear axle. */
  readonly wheelbase: number;
  /** Offset of the tracking point from the chassis origin along its forward axis, m. Default 0. */
  readonly rearOffset?: number;
  /** Local units of chassis forward. Default +Z. */
  readonly forward?: DrivePoint;
  /** Full steering angle in radians, matching Vehicle; default 0.5. */
  readonly maxSteer?: number;
  /** Minimum look-ahead distance in metres. Default 2. */
  readonly lookAhead?: number;
  /** Extra look-ahead seconds applied to forward speed. Default 0.35. */
  readonly lookAheadTime?: number;
  /** Longitudinal acceleration for full throttle, m/s². Default 3. */
  readonly acceleration?: number;
  /** Comfort braking acceleration, m/s². Default 4, reduced by the available traction. */
  readonly deceleration?: number;
  /** Time constant for speed convergence, seconds. Default 0.75. */
  readonly speedResponse?: number;
  /** Relative wetness without a bound port. Default 0. */
  readonly wetness?: number;
  /** Index of the relative wetness in the bound layout-1 f64 port. Default 0. */
  readonly wetnessWord?: number;
  /** Optional existing vehicle attachment. Bind it after add() to retain its wheel and drivetrain state. */
  readonly attachment?: Vehicle;
}

/** Drivers share one origin cell and the world's gravity and 60 Hz physics clock. */
export interface RoadDriverParams {
  readonly vehicles: readonly RoadDriverVehicle[];
  /** Required if rigid body positions and this lane are in different world cells. */
  readonly cellSize?: number;
}

export interface RoadDriverOptions {
  /** Registry prefix. Default 'road-driver'. */
  readonly id?: string;
  /** ATMO-09 layout-1 f64 relative wetness, or another producer of the same declared quantity. */
  readonly wetnessField?: FieldDescriptor;
}

/** Data copied from the live command port. */
export interface RoadDriveCommand extends Required<Pick<VehicleInput, 'steer' | 'throttle' | 'brake'>> {
  readonly targetSpeed: number;
  readonly speed: number;
  readonly progress: number;
  readonly wetness: number;
  readonly segment: number;
}

interface Driver extends Required<Omit<RoadDriverVehicle, 'path' | 'attachment'>> {
  readonly route: SampledRoute;
  readonly attachment: Vehicle | undefined;
  readonly motionOffset: number;
}

interface State {
  readonly host: SolverHost;
  readonly commands: Region;
  readonly motion: Region | undefined;
  readonly drivers: readonly Driver[];
  readonly cellSize: number | undefined;
  readonly gravity: number;
}

function unit([x, y, z]: DrivePoint): DrivePoint {
  const len = numberIn(hypot(x, y, z), 'forward length', Number.MIN_VALUE);
  return [x / len, y / len, z / len]; // float division: normalized forward
}

function driverOf(value: RoadDriverVehicle, motionOffset: number): Driver {
  const body = numberIn(value.body, 'body row', 0);
  const wetnessWord = numberIn(value.wetnessWord ?? 0, 'wetness word', 0);
  if (
    !Number.isSafeInteger(wetnessWord) ||
    !Number.isSafeInteger(body) ||
    (value.attachment && value.attachment.chassis.row !== body)
  )
    throw new MargoError('state', 'Choose integer body and rainfall rows and match the attachment chassis row.');
  const wetness = value.wetness ?? 0;
  roadGrip(value.traction, wetness);
  return {
    body,
    wetnessWord,
    wetness,
    motionOffset,
    attachment: value.attachment,
    route: sampleRoute(value.path),
    traction: { ...value.traction },
    maxSpeed: numberIn(value.maxSpeed ?? 13.9, 'maximum speed', Number.MIN_VALUE),
    wheelbase: numberIn(value.wheelbase, 'wheelbase', Number.MIN_VALUE),
    rearOffset: numberIn(value.rearOffset ?? 0, 'rear offset', -Number.MAX_VALUE),
    forward: unit(value.forward ?? [0, 0, 1]),
    maxSteer: numberIn(
      value.maxSteer ?? value.attachment?.maxSteeringAngle ?? 0.5,
      'steering angle',
      Number.MIN_VALUE,
      Math.PI / 2,
    ),
    lookAhead: numberIn(value.lookAhead ?? 2, 'look-ahead distance', Number.MIN_VALUE),
    lookAheadTime: numberIn(value.lookAheadTime ?? 0.35, 'look-ahead time', 0),
    acceleration: numberIn(value.acceleration ?? 3, 'acceleration', Number.MIN_VALUE),
    deceleration: numberIn(value.deceleration ?? 4, 'braking acceleration', Number.MIN_VALUE),
    speedResponse: numberIn(value.speedResponse ?? 0.75, 'speed response time', Number.MIN_VALUE),
  };
}

function output(table: Float64Array, index: number): RoadDriveCommand {
  const at = index * ROAD_DRIVER_WORDS;
  return {
    steer: table[at + STEER]!,
    throttle: table[at + THROTTLE]!,
    brake: table[at + BRAKE]!,
    targetSpeed: table[at + TARGET]!,
    speed: table[at + SPEED]!,
    progress: table[at + PROGRESS]!,
    wetness: table[at + WETNESS]!,
    segment: table[at + CURSOR]!,
  };
}

function steering(curvature: number, wheelbase: number, cap: number): number {
  if (curvature === 0) return 0;
  const slope = Math.abs(curvature) * wheelbase;
  let low = 0;
  let high = cap;
  if (sin(cap) < slope * cos(cap)) return Math.sign(curvature);
  // tan(delta) = wheelbase * curvature. Sine and cosine comparisons stay finite up to full lock.
  for (let i = 0; i < 30; i++) {
    const angle = 0.5 * (low + high);
    if (sin(angle) < slope * cos(angle)) low = angle;
    else high = angle;
  }
  return Math.sign(curvature) * ((low + high) / (2 * cap)); // float division: normalized steering
}

function bodyForward(body: Float32Array, at: number, [x, y, z]: DrivePoint): DrivePoint {
  const a = body[at + 3]!,
    b = body[at + 4]!,
    c = body[at + 5]!,
    w = body[at + 6]!;
  const n = a * a + b * b + c * c + w * w;
  if (!(n > 0)) throw new MargoError('state', 'Choose a live rigid body row for every road driver.');
  const gain = 2 / n; // float division: normalized quaternion transform
  const u = gain * (b * z - c * y),
    v = gain * (c * x - a * z),
    t = gain * (a * y - b * x);
  return [x + w * u + b * t - c * v, y + w * v + c * u - a * t, z + w * t + a * v - b * u];
}

function controller(
  driver: Driver,
  state: State,
  index: number,
  table: Float64Array,
  body: Float32Array,
  weather: Float64Array | undefined,
  offset: DrivePoint,
  bodyWords: number,
): void {
  const at = driver.body * bodyWords;
  if (at + bodyWords > body.length)
    throw new MargoError('state', 'Choose a road chassis row within the published RigidSolver capacity.');
  const field = index * ROAD_DRIVER_WORDS;
  const forward = bodyForward(body, at, driver.forward);
  const planar = hypot(forward[0], forward[2]);
  if (!(planar > 0)) {
    table[field + THROTTLE] = 0;
    table[field + BRAKE] = 1;
    return;
  }
  const hx = forward[0] / planar,
    hz = forward[2] / planar; // float division: horizontal heading
  const x = body[at]! + offset[0] + forward[0] * driver.rearOffset;
  const z = body[at + 2]! + offset[2] + forward[2] * driver.rearOffset;
  const speed = body[at + 10]! * hx + body[at + 12]! * hz;
  const from = nearest(driver.route, x, z, table[field + CURSOR]!);
  const ahead = driver.lookAhead + Math.max(0, speed) * driver.lookAheadTime;
  const [px, , pz] = lookAhead(driver.route, from, x, z, ahead);
  const dx = px - x,
    dz = pz - z;
  const range = dx * dx + dz * dz;
  const follow = range > 0 ? (2 * (hz * dx - hx * dz)) / range : 0; // float division: Coulter curvature in the car frame
  const wetness = weather ? weather[driver.wetnessWord] : driver.wetness;
  if (wetness === undefined) throw new MargoError('state', 'Use a road wetness index within the published field.');
  const mu = roadGrip(driver.traction, wetness);
  const brakeAcceleration = Math.min(driver.deceleration, mu * state.gravity);
  const target = plannedSpeed(driver.route, from, driver.maxSpeed, brakeAcceleration, mu, state.gravity);
  const request = (target - speed) / driver.speedResponse; // float division: proportional speed response
  const throttle = Math.max(0, Math.min(1, request / driver.acceleration)); // float division: normalized engine demand
  const brake = Math.max(0, Math.min(1, -request / driver.deceleration)); // float division: normalized brake demand
  table.set(
    [
      steering(follow, driver.wheelbase, driver.maxSteer),
      throttle,
      brake,
      target,
      speed,
      from.progress,
      wetness,
      from.segment,
    ],
    field,
  );
}

type BodyPort = Pick<typeof import('@margoengine/physics/world'), 'BODIES_FIELD' | 'BODY_WORDS' | 'regionWords'>;

/** Deterministic 60 Hz lane pursuit and traction-limited braking of actual rigid road vehicles. */
export class RoadDriver implements Solver<RoadDriverParams> {
  readonly id: string;
  readonly commandsField: FieldDescriptor;
  private readonly rainfall: FieldDescriptor | undefined;
  private state: State | undefined;
  private readonly bound = new Set<number>();

  /** Load the existing rigid body port only when constructing a clocked driver. */
  static async create(options: RoadDriverOptions = {}, signal?: AbortSignal): Promise<RoadDriver> {
    signal?.throwIfAborted();
    const port = await import('@margoengine/physics/world');
    signal?.throwIfAborted();
    return new RoadDriver(port, options);
  }

  private constructor(
    private readonly port: BodyPort,
    { id = 'road-driver', wetnessField }: RoadDriverOptions,
  ) {
    if (wetnessField && wetnessField.unit !== '1')
      throw new MargoError('state', 'Use a dimensionless relative wetness field for the road driver.');
    this.id = id;
    this.rainfall = wetnessField && { ...wetnessField };
    this.commandsField = {
      name: `${id}:commands`,
      kind: 'bodySet',
      quantity: 'roadDriveCommand',
      unit: '1, m/s, m',
      centring: 'particle',
    };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: this.port.BODIES_FIELD, access: 'read' },
        { field: this.commandsField, access: 'write' },
        ...(this.rainfall ? [{ field: this.rainfall, access: 'read' as const }] : []),
      ],
    };
  }

  init(host: SolverHost, params: RoadDriverParams): void {
    if (!params.vehicles?.length) throw new MargoError('state', 'Provide at least one road driver vehicle.');
    let count = 0;
    const bodies = new Set<number>();
    const drivers = params.vehicles.map((vehicle) => {
      const driver = driverOf(vehicle, count);
      if (bodies.has(driver.body)) throw new MargoError('state', 'Use only one road driver per rigid chassis.');
      bodies.add(driver.body);
      count += driver.attachment?.motionStateWords ?? 0;
      return driver;
    });
    const state: State = {
      host,
      drivers,
      gravity: hypot(...host.gravity),
      cellSize:
        params.cellSize === undefined ? undefined : numberIn(params.cellSize, 'world cell size', Number.MIN_VALUE),
      commands: host.allocate('road-controls', drivers.length * ROAD_DRIVER_WORDS * F64, 'f64', LAYOUT),
      motion: count ? host.allocate('vehicle-motion', count * F64, 'f64', LAYOUT) : undefined,
    };
    const table = this.port.regionWords(host.memory, state.commands) as Float64Array;
    for (let i = 0; i < drivers.length; i++) {
      table[i * ROAD_DRIVER_WORDS + CURSOR] = -1;
      table[i * ROAD_DRIVER_WORDS + WETNESS] = drivers[i]!.wetness;
      const driver = drivers[i]!;
      if (driver.attachment) driver.attachment.writeMotionState(this.motion(state, driver));
    }
    this.state = state;
  }

  step(context: StepContext): void {
    const state = this.requireState();
    const source = context.inputs.get(this.port.BODIES_FIELD.name);
    if (!source) return;
    const { region } = source;
    if (
      region.type !== 'f32' ||
      region.layout !== 2 ||
      region.byteLength % (this.port.BODY_WORDS * Float32Array.BYTES_PER_ELEMENT)
    )
      throw new MargoError('state', 'Use the RigidSolver layout-2 bodies port for road driving.');
    const offset = source.cell.map((value, axis) => value - context.cell[axis]!) as [number, number, number];
    if (state.cellSize) for (let i = 0; i < 3; i++) offset[i] = offset[i]! * state.cellSize;
    else if (offset.some((value) => value !== 0))
      throw new MargoError('state', 'Set the road driver world cell size for cross-cell queries.');
    const weather = this.rainfall ? context.inputs.get(this.rainfall.name) : undefined;
    if (weather && (weather.region.type !== 'f64' || weather.region.layout !== LAYOUT))
      throw new MargoError('state', 'Use a layout-1 f64 relative wetness port from the weather solver.');
    const table = this.port.regionWords(state.host.memory, state.commands) as Float64Array;
    const bodies = this.port.regionWords(state.host.memory, region) as Float32Array;
    const wet = weather ? (this.port.regionWords(state.host.memory, weather.region) as Float64Array) : undefined;
    for (let i = 0; i < state.drivers.length; i++) controller(state.drivers[i]!, state, i, table, bodies, wet, offset, this.port.BODY_WORDS);
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: this.commandsField.name, region: this.requireState().commands, tick, cell: ZERO }];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    return [this.requireState().commands];
  }

  extraState(): readonly Region[] {
    const { motion } = this.requireState();
    return motion ? [motion] : [];
  }

  /** Copy the current command of one vehicle. */
  read(index: number): RoadDriveCommand {
    const state = this.requireState();
    this.driver(state, index);
    return output(this.port.regionWords(state.host.memory, state.commands) as Float64Array, index);
  }

  /** Drive the registered Vehicle at pre-step from the published world port. Returns an unbind function. */
  bindVehicle(world: PhysicsWorld, physics: Physics, index: number): () => void {
    const state = this.requireState();
    const driver = this.driver(state, index);
    const attachment = driver.attachment;
    if (!attachment || !physics.owns(attachment.chassis) || world.memory !== state.host.memory || this.bound.has(index))
      throw new MargoError(
        'state',
        'Use each configured road attachment once on its original PhysicsWorld and Physics body.',
      );
    this.bound.add(index);
    const before = physics.on('beforestep', () => {
      if (!attachment.valid) return;
      const commands = world.fields.port(this.commandsField.name);
      attachment.readMotionState(this.motion(state, driver));
      if (commands) attachment.setInput(output(this.port.regionWords(world.memory, commands.region) as Float64Array, index));
    });
    const after = physics.on('afterstep', () => {
      if (attachment.valid) attachment.writeMotionState(this.motion(state, driver));
    });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      before();
      after();
      this.bound.delete(index);
    };
  }

  private motion(state: State, driver: Driver): Float64Array {
    const region = this.port.regionWords(state.host.memory, state.motion!) as Float64Array;
    return region.subarray(driver.motionOffset, driver.motionOffset + driver.attachment!.motionStateWords);
  }

  private driver(state: State, index: number): Driver {
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.drivers.length)
      throw new MargoError('state', 'Use an index in the configured road drivers.');
    return state.drivers[index]!;
  }

  private requireState(): State {
    if (!this.state) throw new MargoError('state', 'Add RoadDriver to a PhysicsWorld before reading or binding it.');
    return this.state;
  }
}
