import type { Bed, BedSample } from '@margoengine/math/fields';
import { cos, hypot, sin } from '@margoengine/math/pinned';
import { BED_FIELD, bedFromPort, type BedShape, bedVertexCount } from '../earth/bed.js';
import {
  type Cell,
  checkCell,
  type FieldDescriptor,
  type Port,
  type RateLevel,
  type Region,
  rateOf,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import {
  finite,
  type GroundLeggedDrive,
  type GroundLocomotionOptions,
  type GroundLocomotionParams,
  makeModel,
  sampleBed,
} from './config.js';
import { locomotionError } from './errors.js';
import {
  bindLocomotionKernel,
  type LocomotionBuilds,
  type LocomotionKernel,
  type LocomotionWorkCounts,
  loadLocomotionBuilds,
} from './kernel.js';

const BODY_WORDS = 14;
const PROFILE_WORDS = 34;
const DRIVE_FREQUENCY = 6;
const DRIVE_DUTY = 10;
const DRIVE_HEADING = 24;
const FOOT_WORDS = 7;
const ANCHOR_WORDS = 3;
const GEOMETRY_WORDS = 15;
const CONTACT_WORDS = 13;

/** Layout version of the two locomotion ports. */
export const GROUND_LOCOMOTION_LAYOUT = 1;

/** F64 per body: position XYZ, velocity XYZ, rotation XYZW, angular momentum XYZ, gait phase. */
export const GROUND_POSE_FIELD: FieldDescriptor = {
  name: 'groundAnimalPose',
  kind: 'bodySet',
  quantity: 'ground locomotion pose and momentum',
  unit: 'm, m/s, 1, kg m²/s, cycle',
  centring: 'particle',
};

/** F64 per element: sampled point XYZ, link or forward axis XYZ, ground force XYZ, stance flag, supported couple XYZ. Grouped by body order. */
export const GROUND_CONTACT_FIELD: FieldDescriptor = {
  name: 'groundAnimalContact',
  kind: 'surfaceSampleSet',
  quantity: 'ground locomotion contact',
  unit: 'm, 1, N, 1, N m',
  centring: 'particle',
};

/** Current COM state and phase in the solver's origin cell. */
export interface GroundAnimalPose {
  position: [number, number, number];
  velocity: [number, number, number];
  rotation: [number, number, number, number];
  angularMomentum: [number, number, number];
  phase: number;
}

/** Sample immediately before the most recent integration interval. */
export interface GroundAnimalContact {
  /** Link midpoint, visible foot position, or torso contact position, in metres. */
  position: [number, number, number];
  /** Tail-to-head link direction or body-forward direction. */
  axis: [number, number, number];
  /** Reaction from the ground in newtons. */
  force: [number, number, number];
  /** Finite-footprint stance reaction couple, in newton metres. */
  couple: [number, number, number];
  /** Planted gait phase for a foot or compressive contact for a link or torso. */
  stance: boolean;
}

type ReadTrialContact = (body: number, element: number, out: GroundAnimalContact) => GroundAnimalContact;

interface BodyRange {
  readonly offset: number;
  readonly count: number;
}

interface Lease {
  readonly pose: Region;
  readonly next: Region;
  readonly profile: Region;
  readonly actuators: Region;
  readonly anchors: Region;
  readonly nextAnchors: Region;
  readonly geometry: Region;
  readonly contacts: Region;
  readonly nextContacts: Region;
}

function allocate(host: SolverHost, bodyCount: number, actuatorCount: number): Lease {
  const region = (name: string, count: number, stride: number) => {
    const bytes = count * stride * Float64Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(bytes) || bytes >= 0x100000000)
      throw locomotionError('Reduce the number of configured contacts to fit the world memory.');
    return host.allocate(name, bytes, 'f64', GROUND_LOCOMOTION_LAYOUT);
  };
  return {
    pose: region('ground-animal-pose', bodyCount, BODY_WORDS),
    next: region('ground-animal-next', bodyCount, BODY_WORDS),
    profile: region('ground-animal-profiles', bodyCount, PROFILE_WORDS),
    actuators: region('ground-animal-actuators', actuatorCount, FOOT_WORDS),
    anchors: region('ground-animal-anchors', actuatorCount, ANCHOR_WORDS),
    nextAnchors: region('ground-animal-next-anchors', actuatorCount, ANCHOR_WORDS),
    geometry: region('ground-animal-geometry', actuatorCount, GEOMETRY_WORDS),
    contacts: region('ground-animal-contacts', actuatorCount, CONTACT_WORDS),
    nextContacts: region('ground-animal-next-contacts', actuatorCount, CONTACT_WORDS),
  };
}

function words(host: SolverHost, region: Region): Float64Array {
  return new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / Float64Array.BYTES_PER_ELEMENT);
}

function offset(region: Region, row: number, stride: number): number {
  return region.byteOffset + row * stride * Float64Array.BYTES_PER_ELEMENT;
}

function copy(destination: number[], source: Float64Array, start: number): void {
  for (let axis = 0; axis < destination.length; axis++) destination[axis] = source[start + axis]!;
}

function stableLevel(minimum: number): RateLevel {
  for (let level = 0; level < 8; level++) {
    if (rateOf(level as RateLevel) >= minimum) return level as RateLevel;
  }
  throw locomotionError('Reduce gait frequency, stiffness or damping to fit the fastest physics world rate.');
}

/** Contact-driven lateral undulation and small legged gait in a PhysicsWorld. */
export class GroundLocomotion implements Solver<GroundLocomotionParams> {
  private host?: SolverHost;
  private disposed = false;
  private running = false;
  private nativeWork?: LocomotionWorkCounts;
  private lease?: Lease;
  private kernel?: LocomotionKernel;
  private ranges: readonly BodyRange[] = [];
  private rate: RateLevel = 0;
  private floor = 0;
  private bed?: Bed;
  private readonly bedShape?: BedShape;
  private readonly cellSize: number;
  private readonly id: string;
  private readonly controlled: boolean;
  private readonly poseField: FieldDescriptor;
  private readonly contactField: FieldDescriptor;
  private readonly groundPoint: BedSample = { elevation: 0, normal: [0, 1, 0] };

  private constructor(
    private readonly builds: LocomotionBuilds,
    options: GroundLocomotionOptions,
  ) {
    this.id = options.id ?? 'ground-locomotion';
    if (typeof this.id !== 'string' || this.id.length === 0 || this.id.trim() !== this.id)
      throw locomotionError('Use a ground locomotion solver ID without empty or surrounding whitespace.');
    this.controlled = options.controlled ?? false;
    this.poseField = { ...GROUND_POSE_FIELD, name: options.poseField ?? GROUND_POSE_FIELD.name };
    this.contactField = { ...GROUND_CONTACT_FIELD, name: options.contactField ?? GROUND_CONTACT_FIELD.name };
    this.cellSize = finite(options.cellSize ?? 1024, 'origin cell size');
    if (this.cellSize <= 0) throw locomotionError('Pass the world cell size as a positive length in metres.');
    if (options.bedShape) {
      const { centre, ...shape } = options.bedShape;
      this.bedShape = { ...shape, centre: centre && [...centre] };
      try {
        bedVertexCount(this.bedShape);
      } catch (cause) {
        throw locomotionError('Give locomotion the same finite extent and grid counts as TerrainBed.', 'state', cause);
      }
    }
  }

  /** Loads the SIMD kernel on demand. */
  static async load(options: GroundLocomotionOptions = {}): Promise<GroundLocomotion> {
    if (!options) throw locomotionError('Pass locomotion load options as an object, or omit them.');
    const builds = await loadLocomotionBuilds(options.signal, options.threads);
    try {
      return new GroundLocomotion(builds, options);
    } catch (cause) {
      builds[Symbol.dispose]();
      throw cause;
    }
  }

  /** Releases optional native helpers after the world stops using this group. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.requireIdle();
    this.disposed = true;
    this.builds[Symbol.dispose]();
  }

  private requireIdle(): void {
    if (this.disposed) throw locomotionError('Load a new group after disposing of ground locomotion.', 'disposed');
    if (this.running)
      throw locomotionError('Call the solver only between steps. Give the terrain a read-only sampler.');
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: this.poseField, access: 'write' },
        { field: this.contactField, access: 'write' },
        ...(this.bedShape ? [{ field: BED_FIELD, access: 'read' as const }] : []),
      ],
      rate: 0,
      stableRate: () => this.rate,
    };
  }

  init(host: SolverHost, params: GroundLocomotionParams): void {
    this.requireIdle();
    if (this.host) throw locomotionError('Load a separate ground locomotion solver for each world.', 'attached');
    this.running = true;
    try {
      this.initialize(host, params);
    } catch (cause) {
      if (this.builds.pool) {
        this.disposed = true;
        this.builds[Symbol.dispose]();
      }
      throw cause;
    } finally {
      this.running = false;
    }
  }

  private initialize(host: SolverHost, params: GroundLocomotionParams): void {
    if (!Array.isArray(params?.bodies) || !params.bodies.length)
      throw locomotionError('Configure at least one ground animal body.');
    if (params.bed && typeof params.bed.sample !== 'function')
      throw locomotionError('Pass a Bed with a sample method for the ground locomotion surface.');
    if (params.bed) this.validateCell(params.bed.cell);
    this.bed = params.bed;
    this.floor = finite(params.groundHeight ?? 0, 'flat ground elevation');
    const cell = params.originCell ?? host.cell;
    this.validateCell(cell);
    if (cell.some((coordinate, axis) => coordinate !== host.cell[axis]))
      throw locomotionError('Use the same initial origin in the ground animal options and PhysicsWorld.add.');
    const gravity = hypot(...host.gravity);
    const models = params.bodies.map((body) => makeModel(body, gravity));
    this.rate = stableLevel(models.reduce((minimum, model) => Math.max(minimum, model.minimumHz), 0));
    let total = 0;
    const ranges = models.map(({ count }) => {
      const range = { offset: total, count };
      total += count;
      return range;
    });
    const lease = allocate(host, models.length, total);
    const kernel = bindLocomotionKernel(host, this.builds, ranges);
    const bed = this.surface(host.port(BED_FIELD.name), host);
    for (let row = 0; row < models.length; row++) {
      const model = models[row]!;
      const start = row * BODY_WORDS;
      const elevation = model.autoHeight ? this.elevation(bed, cell, model.body[0]!, model.body[2]!) : 0;
      const pose = words(host, lease.pose);
      pose.set(model.body, start);
      if (model.autoHeight) pose[start + 1] = finite(model.body[1]! + elevation, 'initial elevation');
      words(host, lease.profile).set(model.profile, row * PROFILE_WORDS);
      words(host, lease.actuators).set(model.actuators, ranges[row]!.offset * FOOT_WORDS);
    }
    this.integrate(host, lease, kernel, ranges, bed, cell, 0);
    this.ranges = ranges;
    this.kernel = kernel;
    this.host = host;
    this.lease = lease;
  }

  private validateCell(cell: Cell): void {
    try {
      checkCell(cell);
    } catch (cause) {
      throw locomotionError('Use three signed 32-bit integer coordinates for each origin cell.', 'state', cause);
    }
  }

  private surface(port: Port | undefined, host: SolverHost): Bed | undefined {
    if (!port || !this.bedShape) return this.bed;
    this.validateCell(port.cell);
    const region = port.region;
    const memory = region.memory ?? host.memory;
    if (
      !Number.isSafeInteger(region.byteOffset) ||
      region.byteOffset < 0 ||
      region.byteOffset % 4 !== 0 ||
      region.byteOffset + region.byteLength > memory.buffer.byteLength
    )
      throw locomotionError('Publish an aligned f32 bed region that fits the memory it belongs to.');
    try {
      return bedFromPort(memory, port, this.bedShape);
    } catch (cause) {
      throw locomotionError('Publish a layout-1 f32 bed with the same shape as the locomotion bed.', 'state', cause);
    }
  }

  private elevation(bed: Bed | undefined, cell: Cell, x: number, z: number): number {
    if (!bed) {
      this.groundPoint.elevation = this.floor;
      this.groundPoint.normal[0] = 0;
      this.groundPoint.normal[1] = 1;
      this.groundPoint.normal[2] = 0;
      return this.floor;
    }
    const size = this.cellSize;
    const point = sampleBed(
      bed,
      finite(x + (cell[0] - bed.cell[0]) * size, 'terrain X sample coordinate'),
      finite(z + (cell[2] - bed.cell[2]) * size, 'terrain Z sample coordinate'),
      this.groundPoint,
    );
    return finite(point.elevation + (bed.cell[1] - cell[1]) * size, 'terrain elevation in the local origin');
  }

  step(context: StepContext, dt: number): void {
    this.advance(context, dt);
  }

  /** @internal Check the leg-to-support reactions before publishing a ground step. */
  stepWithContacts(context: StepContext, dt: number, check: (read: ReadTrialContact) => void): void {
    this.advance(context, dt, check);
  }

  private advance(context: StepContext, dt: number, check?: (read: ReadTrialContact) => void): void {
    this.requireIdle();
    const { host, lease, kernel } = this;
    if (!host || !lease || !kernel)
      throw locomotionError('Register the ground locomotion solver in a PhysicsWorld before stepping.');
    if (!Number.isFinite(dt) || dt < 0) throw locomotionError('Pass a finite nonnegative step in seconds.');
    this.validateCell(context.cell);
    this.running = true;
    try {
      const bed = this.surface(context.inputs.get(BED_FIELD.name), host);
      this.integrate(host, lease, kernel, this.ranges, bed, context.cell, dt, check);
      this.nativeWork = kernel.workCounts();
    } finally {
      this.running = false;
    }
  }

  /** Copies deterministic work counts from the last accepted native step. */
  readNativeWork(): LocomotionWorkCounts | undefined {
    const work = this.nativeWork;
    return work && { ...work, workers: work.workers.map((worker) => ({ ...worker })) };
  }

  private integrate(
    host: SolverHost,
    lease: Lease,
    kernel: LocomotionKernel,
    ranges: readonly BodyRange[],
    bed: Bed | undefined,
    cell: Cell,
    dt: number,
    check?: (read: ReadTrialContact) => void,
  ): void {
    words(host, lease.next).set(words(host, lease.pose));
    words(host, lease.nextAnchors).set(words(host, lease.anchors));
    for (let row = 0; row < ranges.length; row++) {
      const { offset: first, count } = ranges[row]!;
      const args = [
        offset(lease.next, row, BODY_WORDS),
        offset(lease.profile, row, PROFILE_WORDS),
        offset(lease.actuators, first, FOOT_WORDS),
        offset(lease.nextAnchors, first, ANCHOR_WORDS),
        offset(lease.geometry, first, GEOMETRY_WORDS),
      ] as const;
      kernel.prepare(...args, count);
      for (let contact = first; contact < first + count; contact++) {
        const word = contact * GEOMETRY_WORDS;
        const geometry = words(host, lease.geometry);
        const elevation = this.elevation(bed, cell, geometry[word]!, geometry[word + 2]!);
        const trial = words(host, lease.geometry);
        trial[word + 12] = elevation;
        trial.set(this.groundPoint.normal, word + 9);
      }
    }
    const status = kernel.stepBatch(
      lease.next.byteOffset,
      lease.profile.byteOffset,
      lease.actuators.byteOffset,
      lease.nextAnchors.byteOffset,
      lease.geometry.byteOffset,
      lease.nextContacts.byteOffset,
      dt,
      ...host.gravity,
    );
    if (status)
      throw locomotionError(
        'Locomotion exceeded the numeric range. Use local cells and comparable SI scales.',
        'failed',
      );
    if (check) check((body, element, out) => this.copyContact(lease.nextContacts, body, element, out));
    words(host, lease.pose).set(words(host, lease.next));
    words(host, lease.anchors).set(words(host, lease.nextAnchors));
    words(host, lease.contacts).set(words(host, lease.nextContacts));
  }

  private bodyRange(body: number): BodyRange {
    if (this.disposed) throw locomotionError('Load a new group after disposing of ground locomotion.', 'disposed');
    const range = Number.isInteger(body) ? this.ranges[body] : undefined;
    if (!Number.isInteger(body) || !range) throw locomotionError('Use the row index of a configured ground animal.');
    return range;
  }

  /** Updates the drive and foot clock of a legged body in a group loaded with controlled commands. */
  setLeggedDrive(body: number, drive: GroundLeggedDrive): void {
    this.requireIdle();
    const range = this.bodyRange(body);
    const { host, lease } = this;
    if (!this.controlled || !host || !lease)
      throw locomotionError('Load ground locomotion with controlled enabled before setting live drives.');
    const profile = words(host, lease.profile);
    const row = body * PROFILE_WORDS;
    const count = range.count - 1;
    if (profile[row] !== 0 || drive?.phases?.length !== count)
      throw locomotionError('Supply each foot phase for a legged body instead of a snake.');
    const { speed, heading, frequency, duty, phases } = drive;
    const force = drive.force ?? [0, 0, 0];
    const support = drive.supportVelocity ?? [0, 0, 0];
    if (
      !Number.isFinite(speed) ||
      speed < 0 ||
      !Number.isFinite(heading) ||
      !Number.isFinite(frequency) ||
      frequency < 0 ||
      !(duty > 0 && duty < 1)
    )
      throw locomotionError('Pass finite speed, heading, frequency and a duty between zero and one.');
    if (4 * frequency > rateOf(this.rate) * Math.min(duty, 1 - duty))
      throw locomotionError(
        'Set a faster configured gait in the group to raise the configured rate for live drive changes.',
      );
    if (force.length !== 3 || !force.every(Number.isFinite))
      throw locomotionError('Pass finite force components in world newtons.');
    if (support.length !== 3 || !support.every(Number.isFinite))
      throw locomotionError('Pass finite support velocity components in world metres per second.');
    for (let foot = 0; foot < count; foot++) {
      const phase = phases[foot]!;
      if (!(phase >= 0 && phase < 1)) throw locomotionError('Pass foot phases in [0, 1) cycles.');
    }
    const actuators = words(host, lease.actuators);
    profile[row + DRIVE_FREQUENCY] = frequency;
    profile[row + DRIVE_DUTY] = duty;
    profile.set(
      [sin(heading * 0.5), cos(heading * 0.5), speed, ...force, drive.lean ? 1 : 0, ...support],
      row + DRIVE_HEADING,
    );
    for (let foot = 0; foot < count; foot++) {
      actuators[(range.offset + foot) * FOOT_WORDS + 6] = phases[foot]!;
    }
  }

  /** Number of link rows or foot rows followed by one torso row for this animal. */
  contactCount(body: number): number {
    return this.bodyRange(body).count;
  }

  /** Copies one animal's current pose into an optional reusable result. */
  read(
    body: number,
    out: GroundAnimalPose = {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      angularMomentum: [0, 0, 0],
      phase: 0,
    },
  ): GroundAnimalPose {
    this.bodyRange(body);
    const pose = words(this.host!, this.lease!.pose);
    const start = body * BODY_WORDS;
    copy(out.position, pose, start);
    copy(out.velocity, pose, start + 3);
    copy(out.rotation, pose, start + 6);
    copy(out.angularMomentum, pose, start + 10);
    out.phase = pose[start + 13]!;
    return out;
  }

  /** Copies a recent contact sample for a foot or link into an optional reusable result. */
  readContact(
    body: number,
    element: number,
    out: GroundAnimalContact = {
      position: [0, 0, 0],
      axis: [0, 0, 1],
      force: [0, 0, 0],
      stance: false,
      couple: [0, 0, 0],
    },
  ): GroundAnimalContact {
    return this.copyContact(this.lease?.contacts, body, element, out);
  }

  private copyContact(
    region: Region | undefined,
    body: number,
    element: number,
    out: GroundAnimalContact,
  ): GroundAnimalContact {
    const range = this.bodyRange(body);
    if (!Number.isInteger(element) || element < 0 || element >= range.count)
      throw locomotionError('Use the index of a foot or link on the configured animal.');
    const contacts = words(this.host!, region!);
    const start = (range.offset + element) * CONTACT_WORDS;
    copy(out.position, contacts, start);
    copy(out.axis, contacts, start + 3);
    copy(out.force, contacts, start + 6);
    out.stance = contacts[start + 9] === 1;
    copy(out.couple, contacts, start + 10);
    return out;
  }

  exportPorts(tick: number): readonly Port[] {
    const { host, lease } = this;
    if (!host || !lease) return [];
    const cell = host.cell;
    return [
      { field: this.poseField.name, region: lease.pose, tick, cell },
      { field: this.contactField.name, region: lease.contacts, tick, cell },
    ];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    const { lease } = this;
    return lease ? [lease.pose, lease.anchors, lease.contacts] : [];
  }

  extraState(): readonly Region[] {
    return this.controlled && this.lease ? [this.lease.profile, this.lease.actuators] : [];
  }
}
