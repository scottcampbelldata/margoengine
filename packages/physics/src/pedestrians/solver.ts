import type { MutableVec2, MutableVec3, Vec2, Vec3 } from '@margoengine/math';
import { hypot } from '@margoengine/math/pinned';
import {
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
import { pedestrianError } from './errors.js';
import {
  instantiatePedestrianKernel,
  loadPedestrianKernel,
  type PedestrianKernelBuilds,
  type PedestrianWorkCounts,
} from './kernel.js';

const BODY_WORDS = 13;
const PROFILE_WORDS = 6;
const COMMAND_WORDS = 4;
const TARGET_WORDS = 4;
const KINEMATICS_WORDS = 9;
const CONTACT_WORDS = 6;
const ZERO: Vec2 = [0, 0];
const FORWARD: Vec2 = [0, 1];

/** Shared f64 layout of the pedestrian input and output ports. */
export const PEDESTRIAN_LAYOUT = 1;

/** Per walker [x, y, z, vx, vy, vz, headingX, headingZ, strideMetres]. */
export const PEDESTRIAN_KINEMATICS_FIELD: FieldDescriptor = Object.freeze({
  name: 'pedestrianKinematics',
  kind: 'particleSet',
  centring: 'particle',
  quantity: 'position, velocity, heading and distance',
  unit: 'm, m/s, 1, m',
});

/** Per walker [fx, fz, compressiveLoad, peoplePerSquareMetre, avoidanceFx, avoidanceFz]. */
export const PEDESTRIAN_CONTACT_FIELD: FieldDescriptor = Object.freeze({
  name: 'pedestrianContact',
  kind: 'bodySet',
  centring: 'particle',
  quantity: 'contact force, compressive load, density and anticipatory force',
  unit: 'N, N, 1/m², N',
});

/** A writer may guide the walkers with one row [vx, vz] of desired world-axis velocity. */
export const PEDESTRIAN_INTENT_FIELD: FieldDescriptor = Object.freeze({
  name: 'pedestrianIntent',
  kind: 'particleSet',
  centring: 'particle',
  quantity: 'velocity',
  unit: 'm/s',
});

/** A writer may push the walkers with one row [fx, fz] of force in world axes. */
export const PEDESTRIAN_FORCE_FIELD: FieldDescriptor = Object.freeze({
  name: 'pedestrianPush',
  kind: 'bodySet',
  centring: 'particle',
  quantity: 'force',
  unit: 'N',
});

/** The two endpoints of a wall or aperture, in the solver's local horizontal XZ plane. */
export type PedestrianSegment = readonly [Vec2, Vec2];

/** The height-query subset of a NavMesh or a tiled NavSurface, in the solver's origin cell. */
export interface PedestrianGround {
  locate(position: Vec3): number;
  heightAt(index: number, x: number, z: number): number;
}

/** Initial state, body dimensions and locomotor actuation for a walker. */
export interface PedestrianBody {
  /** Location of the feet in the solver's cell. */
  readonly position: Vec3;
  /** Initial horizontal world velocity [vx,vz], m/s (default zero). */
  readonly velocity?: Vec2;
  /** Initial horizontal forward unit vector (default +z). */
  readonly heading?: Vec2;
  /** Actual inertial mass in kg (default 75). */
  readonly mass?: number;
  /** Full elliptical shoulder width in m (default 0.46). */
  readonly width?: number;
  /** Full fore-aft depth in m (default 0.28). */
  readonly depth?: number;
  /** Time to regain the preferred velocity, s (default 0.5). */
  readonly responseSeconds?: number;
  /** Maximum self-propelled acceleration, m/s² (default 3). External and contact forces act independently. */
  readonly driveAcceleration?: number;
  /** Maximum shoulder turn rate, rad/s (default π). */
  readonly turnRate?: number;
  /** Free speed along a preferred path, m/s (default 1.34). */
  readonly speed?: number;
  /** Radius, m, inside which the solver advances to the following waypoint or completes a route (default 0.1). */
  readonly arrivalDistance?: number;
  /** Path, e.g. the points returned by NavMesh.route, in the solver's origin cell. */
  readonly path?: readonly Vec3[];
  /** Preferred horizontal velocity if the walker has no path (default stationary). */
  readonly preferredVelocity?: Vec2;
}

/** Geometry and common material and perception parameters for a pedestrian group. */
export interface PedestrianParams {
  readonly bodies: readonly PedestrianBody[];
  /** Solid wall segments in the XZ plane. */
  readonly walls?: readonly PedestrianSegment[];
  /** Traversable gaps with their clear edge endpoints. Walkers can turn their shoulders only as much as needed. */
  readonly apertures?: readonly PedestrianSegment[];
  /** A walkable height surface, conventionally a NavMesh (default fixed starting elevation). */
  readonly ground?: PedestrianGround;
  /** Normal compression stiffness, N/m (default 120,000). */
  readonly stiffness?: number;
  /** Normal damping on approach, N s/m (default 0). */
  readonly damping?: number;
  /** Sliding damping per metre of penetration, N s/m² (default 240,000). */
  readonly sliding?: number;
  /** Time-to-collision energy coefficient, J s² (default 1). Use zero for contact-only motion. */
  readonly anticipation?: number;
  /** Time-to-collision interaction decay, s (default 3). */
  readonly anticipationDecay?: number;
  /** Time horizon for perceiving a potential collision, s (default 6). */
  readonly observationSeconds?: number;
  /** Positive time added to near-time collisions to model finite reaction, s (default 0.15). */
  readonly reactionSeconds?: number;
  /** Radius of the normalized area-density kernel, m (default 1). */
  readonly densityRadius?: number;
  /** Packing density above which self-propelled walking slows, people/m² (default 5.4, zero disables). */
  readonly packingDensity?: number;
  /** Strength of the one-sided reduction above packingDensity (default 1). */
  readonly densityResponse?: number;
  /** Clearance on either side of a shoulder at an aperture, m (default 0.01). */
  readonly apertureMargin?: number;
}

/** Fixed choices made before adding the solver to a world. */
export interface PedestrianOptions {
  /** Unique solver id (default 'pedestrians'). */
  readonly id?: string;
  /** Preferred dyadic rate level (default 0). */
  readonly level?: RateLevel;
  /** Native participants for independent walking and wall phases. Defaults to one. */
  readonly threads?: 1 | 2 | 4;
  /** Read a declared desired-velocity port per walker (default false). */
  readonly readIntent?: boolean;
  /** Read a declared external-force port per walker (default false). */
  readonly readForces?: boolean;
  /** Optional field names for multiple independent groups. */
  readonly fields?: {
    readonly kinematics?: string;
    readonly contact?: string;
    readonly intent?: string;
    readonly force?: string;
  };
  readonly signal?: AbortSignal;
}

/** Copied state for a walker. Angles are implicit in the normalized XZ heading. */
export interface PedestrianReading {
  position: MutableVec3;
  velocity: MutableVec3;
  heading: MutableVec2;
  contactForce: MutableVec2;
  anticipationForce: MutableVec2;
  normalLoad: number;
  density: number;
  distanceTravelled: number;
}

interface Model {
  readonly position: Vec3;
  readonly velocity: Vec2;
  readonly heading: Vec2;
  readonly profile: readonly number[];
  readonly preferred: Vec2;
  readonly path: readonly Vec3[];
  readonly speed: number;
  readonly stop: number;
}

function number(value: number, name: string, zero = false): number {
  if (!Number.isFinite(value) || (zero ? value < 0 : value <= 0))
    throw pedestrianError(
      'Set ' + name + ' to a finite ' + (zero ? 'nonnegative' : 'positive') + ' number in SI units.',
    );
  return value;
}

function horizontal(value: Vec2, name: string): Vec2 {
  if (value?.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]))
    throw pedestrianError('Pass two finite XZ values for ' + name + '.');
  return [value[0], value[1]];
}

function point(value: Vec3): Vec3 {
  if (value?.length !== 3 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || !Number.isFinite(value[2]))
    throw pedestrianError('Pass finite [x,y,z] positions in the crowd solver cell.');
  return [value[0], value[1], value[2]];
}

function model(body: PedestrianBody): Model {
  if (!body) throw pedestrianError('Supply a pedestrian body and finite [x,y,z] position for every row.');
  const heading = horizontal(body.heading ?? FORWARD, 'heading');
  const magnitude = number(hypot(...heading), 'heading length');
  return {
    position: point(body.position),
    velocity: horizontal(body.velocity ?? ZERO, 'velocity'),
    heading: [heading[0] / magnitude, heading[1] / magnitude],
    profile: [
      1 / number(body.mass ?? 75, 'mass'),
      number(body.width ?? 0.46, 'width') / 2,
      number(body.depth ?? 0.28, 'depth') / 2,
      number(body.responseSeconds ?? 0.5, 'responseSeconds'),
      number(body.driveAcceleration ?? 3, 'driveAcceleration', true),
      number(body.turnRate ?? Math.PI, 'turnRate', true),
    ],
    preferred: horizontal(body.preferredVelocity ?? ZERO, 'preferredVelocity'),
    path: (body.path ?? []).map(point),
    speed: number(body.speed ?? 1.34, 'speed', true),
    stop: number(body.arrivalDistance ?? 0.1, 'arrivalDistance'),
  };
}

function flatten(edges: readonly PedestrianSegment[]): readonly number[] {
  return edges.flatMap(([a, b]) => {
    const first = horizontal(a, 'segment start');
    const last = horizontal(b, 'segment end');
    if (!(hypot(last[0] - first[0], last[1] - first[1]) > 0))
      throw pedestrianError('Give each wall and aperture two distinct finite endpoints.');
    return [...first, ...last];
  });
}

function words(host: SolverHost, region: Region): Float64Array {
  return new Float64Array((region.memory ?? host.memory).buffer, region.byteOffset, region.byteLength / 8);
}

function allocate(host: SolverHost, count: number, wallWords: number, gateWords: number) {
  const rows = (name: string, width: number, height = count) =>
    host.allocate(name, width * height * 8, 'f64', PEDESTRIAN_LAYOUT);
  return {
    body: rows('pedestrian-body', BODY_WORDS),
    next: rows('pedestrian-body-next', BODY_WORDS),
    profile: rows('pedestrian-profile', PROFILE_WORDS),
    command: rows('pedestrian-command-scratch', COMMAND_WORDS),
    settings: rows('pedestrian-settings', 12, 1),
    walls: rows('pedestrian-walls', wallWords, 1),
    apertures: rows('pedestrian-apertures', gateWords, 1),
    grid: host.allocate('pedestrian-grid-scratch', 12 * count, 'u8', PEDESTRIAN_LAYOUT),
    targets: rows('pedestrian-targets', TARGET_WORDS),
    nextTargets: rows('pedestrian-targets-next', TARGET_WORDS),
    kinematics: rows('pedestrian-kinematics', KINEMATICS_WORDS),
    contact: rows('pedestrian-contact', CONTACT_WORDS),
    nextKinematics: rows('pedestrian-kinematics-next', KINEMATICS_WORDS),
    nextContact: rows('pedestrian-contact-next', CONTACT_WORDS),
  };
}

type Lease = ReturnType<typeof allocate>;

function named(field: FieldDescriptor, name: string | undefined): FieldDescriptor {
  return name === undefined ? field : { ...field, name };
}

function input(host: SolverHost, port: Port | undefined, field: FieldDescriptor, count: number): Float64Array {
  const region = port?.region;
  const size = count * 16;
  if (
    !region ||
    port?.field !== field.name ||
    region.layout !== PEDESTRIAN_LAYOUT ||
    region.type !== 'f64' ||
    region.byteLength !== size
  )
    throw pedestrianError(
      'Add the declared pedestrian input writer with two layout-1 f64 values per walker.',
      'version',
    );
  const memory = region.memory ?? host.memory;
  const offset = region.byteOffset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 8 !== 0 || offset > memory.buffer.byteLength - size)
    throw pedestrianError('Publish aligned pedestrian input rows within the memory that owns them.');
  return new Float64Array(memory.buffer, offset, count * 2);
}

/** Force-based pedestrian motion with anticipatory avoidance, elliptical contact and turnable shoulders. */
export class PedestrianCrowd implements Solver<PedestrianParams> {
  private host?: SolverHost;
  private lease?: Lease;
  private kernel?: ReturnType<typeof instantiatePedestrianKernel>;
  private readonly id: string;
  private readonly level: RateLevel;
  private readonly wantsIntent: boolean;
  private readonly wantsPush: boolean;
  private readonly fields: {
    kinematics: FieldDescriptor;
    contact: FieldDescriptor;
    intent: FieldDescriptor;
    force: FieldDescriptor;
  };
  private models: readonly Model[] = [];
  private ground?: PedestrianGround;
  private oscillationRate = 0;
  private shortestRadius = 0;
  private running = false;
  private disposed = false;
  private readonly groundPoint: MutableVec3 = [0, 0, 0];

  private constructor(
    private readonly builds: PedestrianKernelBuilds,
    options: PedestrianOptions,
  ) {
    const { id = 'pedestrians', level = 0, readIntent = false, readForces = false, fields } = options;
    this.id = id;
    this.level = level;
    this.wantsIntent = readIntent;
    this.wantsPush = readForces;
    this.fields = {
      kinematics: named(PEDESTRIAN_KINEMATICS_FIELD, fields?.kinematics),
      contact: named(PEDESTRIAN_CONTACT_FIELD, fields?.contact),
      intent: named(PEDESTRIAN_INTENT_FIELD, fields?.intent),
      force: named(PEDESTRIAN_FORCE_FIELD, fields?.force),
    };
  }

  /** Loads the optional SIMD kernel. Use a new instance for each group in a PhysicsWorld. */
  static async load(options: PedestrianOptions = {}): Promise<PedestrianCrowd> {
    if (typeof (options.id ?? 'pedestrians') !== 'string' || options.id === '' || !isRateLevel(options.level ?? 0))
      throw pedestrianError('Choose a nonempty pedestrian solver id and a rate level from 0 to 7.');
    return new PedestrianCrowd(await loadPedestrianKernel(options.signal, options.threads ?? 1), options);
  }

  /** Releases native helpers after the world has stopped stepping. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.requireIdle();
    this.disposed = true;
    this.builds[Symbol.dispose]();
  }

  /** Work from the most recent accepted pedestrian step. */
  readNativeWork(): PedestrianWorkCounts | undefined {
    return this.kernel?.workCounts();
  }

  private requireIdle(): void {
    if (this.disposed) throw pedestrianError('Load a new pedestrian group after disposing its helpers.', 'disposed');
    if (this.running)
      throw pedestrianError('Change targets, dispose helpers or step the crowd after the current step finishes.');
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.level,
      stableRate: () => this.stableRate(),
      fields: [
        { field: this.fields.kinematics, access: 'write' },
        { field: this.fields.contact, access: 'write' },
        ...(this.wantsIntent ? [{ field: this.fields.intent, access: 'read' as const }] : []),
        ...(this.wantsPush ? [{ field: this.fields.force, access: 'read' as const }] : []),
      ],
    };
  }

  private stableRate(): RateLevel {
    const { host, lease, models, shortestRadius } = this;
    if (!host || !lease) return this.level;
    const body = words(host, lease.body);
    const target = words(host, lease.targets);
    let required = this.oscillationRate;
    for (let row = 0; row < models.length; row++) {
      const at = row * BODY_WORDS;
      const commanded = row * TARGET_WORDS;
      const model = models[row]!;
      const speed = Math.max(
        hypot(body[at + 2]!, body[at + 3]!),
        model.speed,
        hypot(target[commanded + 1]!, target[commanded + 2]!),
      );
      required = Math.max(required, model.profile[5]! * 4, (2 * speed) / shortestRadius);
    }
    let level = this.level;
    while (level < 7 && rateOf(level) < required) level = (level + 1) as RateLevel;
    return level;
  }

  init(host: SolverHost, params: PedestrianParams): void {
    this.requireIdle();
    if (this.host) throw pedestrianError('Load another pedestrian group for a separate world.', 'attached');
    if (!Array.isArray(params?.bodies) || !params.bodies.length)
      throw pedestrianError('Give the pedestrian solver at least one walker.');
    const models = params.bodies.map(model);
    const walls = flatten(params.walls ?? []);
    const apertures = flatten(params.apertures ?? []);
    if (params.ground && (typeof params.ground.locate !== 'function' || typeof params.ground.heightAt !== 'function'))
      throw pedestrianError('Pass a ground surface with locate and heightAt methods.');
    const stiffness = number(params.stiffness ?? 120000, 'stiffness', true);
    let maxRadius = 0;
    let minRadius = Infinity;
    let maxInverseMass = 0;
    for (const walker of models) {
      maxInverseMass = Math.max(maxInverseMass, walker.profile[0]!);
      minRadius = Math.min(minRadius, walker.profile[1]!, walker.profile[2]!);
      maxRadius = Math.max(maxRadius, walker.profile[1]!, walker.profile[2]!);
    }
    const config = [
      stiffness,
      number(params.damping ?? 0, 'damping', true),
      number(params.sliding ?? 240000, 'sliding', true),
      number(params.anticipation ?? 1, 'anticipation', true),
      number(params.anticipationDecay ?? 3, 'anticipationDecay'),
      number(params.observationSeconds ?? 6, 'observationSeconds'),
      number(params.reactionSeconds ?? 0.15, 'reactionSeconds'),
      number(params.densityRadius ?? 1, 'densityRadius'),
      number(params.packingDensity ?? 5.4, 'packingDensity', true),
      number(params.densityResponse ?? 1, 'densityResponse', true),
      number(params.apertureMargin ?? 0.01, 'apertureMargin', true),
      maxRadius,
    ];
    const density0 = 4 / (Math.PI * config[7]! * config[7]!);
    if (!(density0 > 0 && Number.isFinite(density0)))
      throw pedestrianError('Use a density radius that produces a finite positive sample area.');
    const kernel = instantiatePedestrianKernel(host, this.builds);
    const lease = allocate(host, models.length, walls.length, apertures.length);
    words(host, lease.settings).set(config);
    words(host, lease.walls).set(walls);
    words(host, lease.apertures).set(apertures);
    const pose = words(host, lease.kinematics);
    const bodies = words(host, lease.body);
    const profiles = words(host, lease.profile);
    const targets = words(host, lease.targets);
    const contact = words(host, lease.contact);
    models.forEach((walker, row) => {
      bodies.set(
        [walker.position[0], walker.position[2], ...walker.velocity, ...walker.heading, 0, 0, 0, 0, density0, 0, 0],
        row * BODY_WORDS,
      );
      targets.set([0, ...walker.preferred, 0], row * TARGET_WORDS);
      profiles.set(walker.profile, row * PROFILE_WORDS);
      pose.set(
        [...walker.position, walker.velocity[0], 0, walker.velocity[1], ...walker.heading, 0],
        row * KINEMATICS_WORDS,
      );
      contact[row * CONTACT_WORDS + 3] = density0;
    });
    this.oscillationRate = 2 * Math.sqrt(2 * stiffness * maxInverseMass);
    this.shortestRadius = minRadius;
    this.ground = params.ground;
    this.host = host;
    this.lease = lease;
    this.kernel = kernel;
    this.models = models;
  }

  /** Overrides the configured path with a desired horizontal world-axis velocity. Null resumes the path. */
  setPreferredVelocity(row: number, velocity: Vec2 | null): void {
    this.requireIdle();
    const { host, lease } = this.member(row);
    const settings = words(host, lease.targets);
    const at = row * TARGET_WORDS;
    if (velocity) settings.set(horizontal(velocity, 'preferred velocity'), at + 1);
    settings[at + 3] = velocity ? 1 : 0;
    if (!velocity) settings.set(this.models[row]!.preferred, at + 1);
  }

  /** Copies the most recent state for a walker. */
  read(
    row: number,
    out: PedestrianReading = {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      heading: [0, 1],
      contactForce: [0, 0],
      anticipationForce: [0, 0],
      normalLoad: 0,
      density: 0,
      distanceTravelled: 0,
    },
  ): PedestrianReading {
    const { host, lease } = this.member(row);
    const pose = words(host, lease.kinematics);
    const loads = words(host, lease.contact);
    const bodyAt = row * KINEMATICS_WORDS;
    const loadAt = row * CONTACT_WORDS;
    for (let axis = 0; axis < 3; axis++) {
      out.position[axis] = pose[bodyAt + axis]!;
      out.velocity[axis] = pose[bodyAt + axis + 3]!;
    }
    for (let axis = 0; axis < 2; axis++) {
      out.heading[axis] = pose[bodyAt + 6 + axis]!;
      out.contactForce[axis] = loads[loadAt + axis]!;
      out.anticipationForce[axis] = loads[loadAt + axis + 4]!;
    }
    out.distanceTravelled = pose[bodyAt + 8]!;
    out.normalLoad = loads[loadAt + 2]!;
    out.density = loads[loadAt + 3]!;
    return out;
  }

  private member(row: number): { host: SolverHost; lease: Lease } {
    if (this.disposed) throw pedestrianError('Load a new pedestrian group after disposing its helpers.', 'disposed');
    const { host, lease } = this;
    if (!host || !lease) throw pedestrianError('Add the pedestrian solver to a PhysicsWorld first.');
    if (!Number.isInteger(row) || row < 0 || row >= this.models.length)
      throw pedestrianError('Use the row index of a configured pedestrian.');
    return { host, lease };
  }

  step(context: StepContext, dt: number): void {
    this.requireIdle();
    if (!(dt > 0 && Number.isFinite(dt))) throw pedestrianError('Pass a finite positive pedestrian step in seconds.');
    this.running = true;
    try {
      this.advance(context, dt);
    } finally {
      this.running = false;
    }
  }

  private advance(context: StepContext, dt: number): void {
    const { host, lease, kernel, models, fields } = this;
    if (!host || !lease || !kernel)
      throw pedestrianError('Add the pedestrian solver to a PhysicsWorld before stepping.');
    const count = models.length;
    const intent = this.wantsIntent
      ? input(host, context.inputs.get(fields.intent.name), fields.intent, count)
      : undefined;
    const pushes = this.wantsPush ? input(host, context.inputs.get(fields.force.name), fields.force, count) : undefined;
    const body = words(host, lease.body);
    const commands = words(host, lease.command);
    const target = words(host, lease.nextTargets);
    target.set(words(host, lease.targets));
    for (let row = 0; row < count; row++) {
      const model = models[row]!;
      const source = row * BODY_WORDS;
      const motion = row * COMMAND_WORDS;
      const task = row * TARGET_WORDS;
      const forced = target[task + 3] === 1;
      let vx = intent?.[2 * row] ?? target[task + 1]!;
      let vz = intent?.[2 * row + 1] ?? target[task + 2]!;
      if (!intent && !forced && model.path.length) {
        const x = body[source]!;
        const z = body[source + 1]!;
        vx = 0;
        vz = 0;
        let waypoint = target[task]!;
        for (; waypoint < model.path.length; waypoint++) {
          const vertex = model.path[waypoint]!;
          const dx = vertex[0] - x,
            dz = vertex[2] - z;
          const distance = hypot(dx, dz);
          if (distance <= model.stop) continue;
          const next = model.path[waypoint + 1];
          if (next) {
            const sx = next[0] - vertex[0];
            const sz = next[2] - vertex[2];
            const length = hypot(sx, sz);
            // A walker can pass a waypoint off centre while yielding to its neighbours.
            const passed = dx * sx + dz * sz <= 0;
            const lateral = Math.abs(dx * sz - dz * sx);
            if (length > 0 && passed && lateral <= length * 2 * model.profile[1]!) continue;
          }
          const speed = Math.min(model.speed, distance / model.profile[3]!);
          vx = (speed * dx) / distance;
          vz = (speed * dz) / distance;
          break;
        }
        target[task] = waypoint;
      }
      const fx = pushes?.[2 * row] ?? 0;
      const fz = pushes?.[2 * row + 1] ?? 0;
      if (![vx, vz, fx, fz].every(Number.isFinite))
        throw pedestrianError('Provide finite XZ pedestrian control velocities and forces.');
      commands.set([vx, vz, fx, fz], motion);
    }
    const result = kernel.run(
      lease.body.byteOffset,
      lease.profile.byteOffset,
      lease.command.byteOffset,
      lease.walls.byteOffset,
      lease.walls.byteLength / 32,
      lease.apertures.byteOffset,
      lease.apertures.byteLength / 32,
      lease.settings.byteOffset,
      lease.next.byteOffset,
      lease.grid.byteOffset,
      count,
      dt,
    );
    if (result)
      throw pedestrianError('Crowd integration exceeded its numeric range. Use local cells and comparable SI scales.');
    this.preparePublication(host, lease, dt);
    words(host, lease.body).set(words(host, lease.next));
    words(host, lease.targets).set(words(host, lease.nextTargets));
    words(host, lease.kinematics).set(words(host, lease.nextKinematics));
    words(host, lease.contact).set(words(host, lease.nextContact));
    kernel.accept();
  }

  private preparePublication(host: SolverHost, lease: Lease, dt: number): void {
    const surface = this.ground;
    const point = this.groundPoint;
    for (let row = 0; row < this.models.length; row++) {
      const at = row * BODY_WORDS;
      const to = row * KINEMATICS_WORDS;
      const load = row * CONTACT_WORDS;
      const candidate = words(host, lease.next);
      const x = candidate[at]!;
      const z = candidate[at + 1]!;
      const acceptedHeight = words(host, lease.kinematics)[to + 1]!;
      point[0] = x;
      point[1] = acceptedHeight;
      point[2] = z;
      const index = surface?.locate(point) ?? -1;
      const y = surface && index >= 0 ? surface.heightAt(index, x, z) : acceptedHeight;
      if (!Number.isFinite(y)) throw pedestrianError('Provide a finite walkable height for the located polygon.');
      const vertical = (y - acceptedHeight) / dt;
      if (!Number.isFinite(vertical))
        throw pedestrianError('Use comparable local heights and step duration for pedestrian vertical motion.');
      // The ground callback may grow a plain Wasm arena, so reacquire its views here.
      const body = words(host, lease.next);
      words(host, lease.nextKinematics).set(
        [x, y, z, body[at + 2]!, vertical, body[at + 3]!, body[at + 4]!, body[at + 5]!, body[at + 6]!],
        to,
      );
      words(host, lease.nextContact).set(
        [body[at + 8]!, body[at + 9]!, body[at + 7]!, body[at + 10]!, body[at + 11]!, body[at + 12]!],
        load,
      );
    }
  }

  exportPorts(tick: number): readonly Port[] {
    const { host, lease, fields } = this;
    return host && lease
      ? [
          { field: fields.kinematics.name, region: lease.kinematics, tick, cell: host.cell },
          { field: fields.contact.name, region: lease.contact, tick, cell: host.cell },
        ]
      : [];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    const { lease } = this;
    return lease ? [lease.body, lease.targets, lease.kinematics, lease.contact] : [];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
