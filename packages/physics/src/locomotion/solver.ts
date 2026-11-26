import { MargoError } from '@margoengine/math/errors';
import type { Bed, BedSample } from '@margoengine/math/fields';
import { hypot } from '@margoengine/math/pinned';
import { BED_FIELD, bedFromPort, type BedShape, bedVertexCount } from '../earth/bed.js';
import {
  type Cell,
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
import { finite, type GroundLocomotionOptions, type GroundLocomotionParams, makeModel, sampleBed } from './config.js';
import { bindLocomotionKernel, loadLocomotionBuilds, type LocomotionBuilds, type LocomotionKernel } from './kernel.js';

const ORIGIN: Cell = [0, 0, 0];
const BODY_WORDS = 14;
const PROFILE_WORDS = 26;
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
      throw new RangeError('Reduce the number of configured contacts to fit the world memory.');
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
  throw new RangeError('Reduce gait frequency, stiffness or damping to fit the fastest physics world rate.');
}

/** Contact-driven lateral undulation and small legged gait in a PhysicsWorld. */
export class GroundLocomotion implements Solver<GroundLocomotionParams> {
  private host?: SolverHost;
  private lease?: Lease;
  private kernel?: LocomotionKernel;
  private ranges: readonly BodyRange[] = [];
  private rate: RateLevel = 0;
  private floor = 0;
  private bed?: Bed;
  private readonly bedShape?: BedShape;
  private readonly cellSize: number;
  private readonly id: string;
  private readonly groundPoint: BedSample = { elevation: 0, normal: [0, 1, 0] };

  private constructor(
    private readonly builds: LocomotionBuilds,
    options: GroundLocomotionOptions,
  ) {
    this.id = options.id ?? 'ground-locomotion';
    this.cellSize = finite(options.cellSize ?? 1024, 'origin cell size');
    if (this.cellSize <= 0) throw new RangeError('Pass the world cell size as a positive length in metres.');
    if (options.bedShape) {
      const { centre, ...shape } = options.bedShape;
      this.bedShape = { ...shape, centre: centre && [...centre] };
      bedVertexCount(this.bedShape);
    }
  }

  /** Loads the SIMD kernel on demand. */
  static async load(options: GroundLocomotionOptions = {}): Promise<GroundLocomotion> {
    return new GroundLocomotion(await loadLocomotionBuilds(options.signal), options);
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: GROUND_POSE_FIELD, access: 'write' },
        { field: GROUND_CONTACT_FIELD, access: 'write' },
        ...(this.bedShape ? [{ field: BED_FIELD, access: 'read' as const }] : []),
      ],
      rate: 0,
      stableRate: () => this.rate,
    };
  }

  init(host: SolverHost, params: GroundLocomotionParams): void {
    if (this.host) throw new MargoError('state', 'Load a separate ground locomotion solver for each world.');
    if (!params.bodies.length) throw new RangeError('Configure at least one ground animal body.');
    if (params.bed && typeof params.bed.sample !== 'function')
      throw new RangeError('Pass a Bed with a sample method for the ground locomotion surface.');
    this.bed = params.bed;
    this.floor = finite(params.groundHeight ?? 0, 'flat ground elevation');
    const cell = params.originCell ?? ORIGIN;
    if (
      cell.length !== 3 ||
      !Number.isSafeInteger(cell[0]) ||
      !Number.isSafeInteger(cell[1]) ||
      !Number.isSafeInteger(cell[2])
    )
      throw new RangeError('Pass an origin cell with three integer coordinates.');
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
    const kernel = bindLocomotionKernel(host, this.builds);
    const bed = this.surface(host.port(BED_FIELD.name), host);
    const pose = words(host, lease.pose);
    const profiles = words(host, lease.profile);
    const actuators = words(host, lease.actuators);
    for (let row = 0; row < models.length; row++) {
      const model = models[row]!;
      const start = row * BODY_WORDS;
      pose.set(model.body, start);
      if (model.autoHeight)
        pose[start + 1] = pose[start + 1]! + this.elevation(bed, cell, pose[start]!, pose[start + 2]!);
      profiles.set(model.profile, row * PROFILE_WORDS);
      actuators.set(model.actuators, ranges[row]!.offset * FOOT_WORDS);
    }
    this.integrate(host, lease, kernel, ranges, bed, cell, 0);
    this.ranges = ranges;
    this.kernel = kernel;
    this.host = host;
    this.lease = lease;
  }

  private surface(port: Port | undefined, host: SolverHost): Bed | undefined {
    return port && this.bedShape ? bedFromPort(host.memory, port, this.bedShape) : this.bed;
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
      x + (cell[0] - bed.cell[0]) * size,
      z + (cell[2] - bed.cell[2]) * size,
      this.groundPoint,
    );
    return point.elevation + (bed.cell[1] - cell[1]) * size;
  }

  step(context: StepContext, dt: number): void {
    const { host, lease, kernel } = this;
    if (!host || !lease || !kernel)
      throw new MargoError('state', 'Register the ground locomotion solver in a PhysicsWorld before stepping.');
    const bed = this.surface(context.inputs.get(BED_FIELD.name), host);
    this.integrate(host, lease, kernel, this.ranges, bed, context.cell, dt);
  }

  private integrate(
    host: SolverHost,
    lease: Lease,
    kernel: LocomotionKernel,
    ranges: readonly BodyRange[],
    bed: Bed | undefined,
    cell: Cell,
    dt: number,
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
      const geometry = words(host, lease.geometry);
      for (let contact = first; contact < first + count; contact++) {
        const word = contact * GEOMETRY_WORDS;
        geometry[word + 12] = this.elevation(bed, cell, geometry[word]!, geometry[word + 2]!);
        geometry.set(this.groundPoint.normal, word + 9);
      }
      const status = kernel.step(...args, offset(lease.nextContacts, first, CONTACT_WORDS), count, dt, ...host.gravity);
      if (status)
        throw new RangeError('Locomotion exceeded the numeric range. Use local cells and comparable SI scales.');
    }
    words(host, lease.pose).set(words(host, lease.next));
    words(host, lease.anchors).set(words(host, lease.nextAnchors));
    words(host, lease.contacts).set(words(host, lease.nextContacts));
  }

  private bodyRange(body: number): BodyRange {
    const range = Number.isInteger(body) ? this.ranges[body] : undefined;
    if (!Number.isInteger(body) || !range) throw new RangeError('Use the row index of a configured ground animal.');
    return range;
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
    const range = this.bodyRange(body);
    if (!Number.isInteger(element) || element < 0 || element >= range.count)
      throw new RangeError('Use the index of a foot or link on the configured animal.');
    const contacts = words(this.host!, this.lease!.contacts);
    const start = (range.offset + element) * CONTACT_WORDS;
    copy(out.position, contacts, start);
    copy(out.axis, contacts, start + 3);
    copy(out.force, contacts, start + 6);
    out.stance = contacts[start + 9] === 1;
    copy(out.couple, contacts, start + 10);
    return out;
  }

  exportPorts(tick: number): readonly Port[] {
    const { lease } = this;
    return lease
      ? [
          { field: GROUND_POSE_FIELD.name, region: lease.pose, tick, cell: ORIGIN },
          { field: GROUND_CONTACT_FIELD.name, region: lease.contacts, tick, cell: ORIGIN },
        ]
      : [];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    const { lease } = this;
    return lease ? [lease.pose, lease.anchors, lease.contacts] : [];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
