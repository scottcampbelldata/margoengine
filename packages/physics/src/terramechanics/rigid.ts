import { MargoError } from '@margoengine/math/errors';
import { cos, hypot, sin } from '@margoengine/math/pinned';
import type { PhysicsCollider } from '../collider.js';
import type { BedCollider } from '../earth/bed-collider.js';
import { BED_FIELD, BED_LAYOUT, type BedShape, bedVertexCount } from '../earth/bed.js';
import type { TrackedVehicle } from '../tracked.js';
import type { Vehicle } from '../vehicle.js';
import { regionWords } from '../world/memory.js';
import type { Cell, FieldDescriptor, Port, Region, SolverHost, StepContext } from '../world/solver.js';
import { RigidSolver, type RigidSolverParams } from '../world/solvers/rigid.js';
import { SOIL_LAYOUT, SOIL_PATCH_WORDS } from './index.js';

type Point = readonly [number, number, number];
type Pair = readonly [number, number];

export interface WheelSoilBinding {
  readonly vehicle: Vehicle;
  /** Projected footprint length and width per wheel, m. */
  readonly patches: readonly { readonly length: number; readonly width: number }[];
  /** Only publish contact against this collider when supplied. */
  readonly ground?: PhysicsCollider;
  /** Forward vector in the chassis frame. Default +Z. */
  readonly forward?: Point;
}

export interface TrackSoilBinding {
  readonly vehicle: TrackedVehicle;
  /** Width, length and mid-belt position in the chassis frame, m, for each configured track. */
  readonly patches: readonly { readonly length: number; readonly width: number; readonly centre: Point }[];
  readonly forward?: Point;
}

export interface SoilContactRigidParams extends RigidSolverParams {
  readonly wheels?: readonly WheelSoilBinding[];
  readonly tracks?: readonly TrackSoilBinding[];
  /** The real height-field collider to update when `terrain` was supplied in the solver options. */
  readonly ground?: BedCollider;
}

export interface SoilContactRigidOptions {
  readonly id?: string;
  /** Read the live bed and update the supplied collider before sampling wheel and belt loads. */
  readonly terrain?: BedShape;
}

function rotate([x, y, z, w]: readonly number[], [a, b, c]: Point): Point {
  const tx = 2 * (y! * c - z! * b),
    ty = 2 * (z! * a - x! * c),
    tz = 2 * (x! * b - y! * a);
  return [a + w! * tx + y! * tz - z! * ty, b + w! * ty + z! * tx - x! * tz, c + w! * tz + x! * ty - y! * tx];
}

function heading(vehicle: Vehicle | TrackedVehicle, forward: Point = [0, 0, 1]): Pair {
  const [x, , z] = rotate(vehicle.chassis.rotation, forward);
  const scale = hypot(x, z);
  return scale > 0 ? [x / scale, z / scale] : [0, 1];
}

function wheelLoads(out: Float64Array, at: number, binding: WheelSoilBinding): number {
  const { vehicle, patches, ground } = binding;
  const [x, z] = heading(vehicle, binding.forward);
  for (const [index, patch] of patches.entries()) {
    const wheel = vehicle.wheel(index);
    if (wheel.contactPoint && wheel.load > 0 && (!ground || ground === wheel.ground)) {
      const azimuth = wheel.steering;
      const longitudinal = -wheel.slipRatio * patch.length;
      const lateral = (patch.length * sin(wheel.slipAngle)) / Math.max(cos(wheel.slipAngle), Number.EPSILON);
      const fx = x * cos(azimuth) + z * sin(azimuth);
      const fz = z * cos(azimuth) - x * sin(azimuth);
      out.set(
        [
          wheel.contactPoint[0],
          wheel.contactPoint[2],
          fx,
          fz,
          patch.length,
          patch.width,
          wheel.load,
          longitudinal * fx + lateral * fz,
          longitudinal * fz - lateral * fx,
          1,
        ],
        at,
      );
    }
    at += SOIL_PATCH_WORDS;
  }
  return at;
}

function trackLoads(out: Float64Array, at: number, binding: TrackSoilBinding): number {
  const { vehicle, patches } = binding;
  const [x, z] = heading(vehicle, binding.forward);
  const velocity = vehicle.chassis.linearVelocity;
  const origin = vehicle.chassis.position;
  for (const [index, patch] of patches.entries()) {
    const belt = vehicle.track(index);
    if (belt.load > 0 && belt.inContact) {
      const centre = rotate(vehicle.chassis.rotation, patch.centre);
      const travel = Math.max(Math.abs(belt.speed), Math.abs(vehicle.speed));
      const duration = travel > 0 ? patch.length / travel : 0;
      const shear = (vehicle.speed - belt.speed) * duration;
      const lateral = (velocity[0] * z - velocity[2] * x) * duration;
      out.set(
        [
          origin[0] + centre[0],
          origin[2] + centre[2],
          x,
          z,
          patch.length,
          patch.width,
          belt.load,
          shear * x + lateral * z,
          shear * z - lateral * x,
          0,
        ],
        at,
      );
    }
    at += SOIL_PATCH_WORDS;
  }
  return at;
}

/** A real rigid solver that also publishes wheel and belt contact pressures as footprint rows. */
export class SoilContactRigidSolver extends RigidSolver {
  private memory!: WebAssembly.Memory;
  private patches!: Region;
  private motion!: Region;
  private wheels: readonly WheelSoilBinding[] = [];
  private tracks: readonly TrackSoilBinding[] = [];
  private vehicles: readonly (Vehicle | TrackedVehicle)[] = [];
  private cell: Cell = [0, 0, 0];
  private lastTick = -1;
  private readonly terrain?: BedShape;
  private ground?: PhysicsCollider;
  private heights?: Region;

  constructor(
    readonly soilField: FieldDescriptor,
    options: SoilContactRigidOptions = {},
  ) {
    super(options.id ?? 'rigid');
    this.terrain = options.terrain && { ...options.terrain, centre: [...options.terrain.centre] };
  }

  override describe() {
    const base = super.describe();
    return {
      ...base,
      fields: [
        ...base.fields,
        { field: this.soilField, access: 'write' as const },
        ...(this.terrain ? [{ field: BED_FIELD, access: 'read' as const }] : []),
      ],
    };
  }

  override init(host: SolverHost, params: SoilContactRigidParams): void {
    this.wheels = (params.wheels ?? []).map((entry) => ({ ...entry, patches: entry.patches.map((p) => ({ ...p })) }));
    this.tracks = (params.tracks ?? []).map((entry) => ({ ...entry, patches: entry.patches.map((p) => ({ ...p })) }));
    this.vehicles = [...this.wheels, ...this.tracks].map(({ vehicle }) => vehicle);
    const rows = [...this.wheels, ...this.tracks].reduce((count, binding) => count + binding.patches.length, 0);
    if (
      !rows ||
      new Set(this.vehicles).size !== this.vehicles.length ||
      this.vehicles.some((v) => !params.physics.owns(v.chassis)) ||
      this.wheels.some((b) => b.patches.length !== b.vehicle.wheelCount) ||
      this.tracks.some((b) => b.patches.length !== b.vehicle.trackCount) ||
      [...this.wheels, ...this.tracks].some((b) =>
        b.patches.some((p) => ![p.length, p.width].every((s) => Number.isFinite(s) && s > 0)),
      )
    )
      throw new MargoError(
        'state',
        'Soil contact bindings disagree with the rigid world. Provide distinct live vehicles and positive footprints for each wheel or belt.',
      );
    super.init(host, params);
    this.memory = host.memory;
    this.patches = host.allocate('rigid-soil-patches', rows * SOIL_PATCH_WORDS * 8, 'f64', SOIL_LAYOUT);
    this.motion = host.allocate(
      'rigid-soil-motion',
      8 * (1 + this.vehicles.reduce((n, v) => n + v.motionStateWords, 0)),
      'f64',
      SOIL_LAYOUT,
    );
    this.syncMotion(-1);
    this.ground = params.ground?.collider;
    if (Boolean(this.terrain) !== Boolean(this.ground))
      throw new MargoError(
        'state',
        'Rigid soil feedback needs a grid and its collider. Supply both terrain and ground.',
      );
    if (this.terrain && params.ground) {
      const grid = this.terrain;
      const shape = params.ground.collider.heightfieldScale();
      if (
        !params.physics.owns(params.ground.body) ||
        params.ground.collider.heightfieldNRows() !== grid.rows ||
        params.ground.collider.heightfieldNCols() !== grid.columns ||
        shape[0] !== Math.fround(grid.width) ||
        shape[2] !== Math.fround(grid.depth)
      )
        throw new MargoError(
          'state',
          'The soil collider does not match the bed grid. Use a collider made from this TerrainBed.',
        );
      this.heights = host.allocate('rigid-soil-heights', 4 * bedVertexCount(grid), 'f32', BED_LAYOUT);
      (regionWords(this.memory, this.heights) as Float32Array).set(params.ground.collider.heightfieldHeights());
    }
  }

  private syncMotion(tick: number, restore = false): void {
    const data = regionWords(this.memory, this.motion) as Float64Array;
    let at = 1;
    for (const vehicle of this.vehicles) {
      const end = at + vehicle.motionStateWords;
      const words = data.subarray(at, end);
      if (restore) vehicle.readMotionState(words);
      else vehicle.writeMotionState(words);
      at = end;
    }
    if (!restore) data[0] = tick;
  }

  override step(context: StepContext, dt: number): void {
    const current = regionWords(this.memory, this.motion) as Float64Array;
    if (this.lastTick !== current[0]) this.syncMotion(context.tick, true);
    if (this.heights && this.ground) {
      const port = context.inputs.get(BED_FIELD.name);
      if (
        !port ||
        port.region.type !== 'f32' ||
        port.region.layout !== BED_LAYOUT ||
        port.region.byteLength !== this.heights.byteLength ||
        port.cell.some((value, index) => value !== context.cell[index])
      )
        throw new MargoError(
          'state',
          'Rigid soil feedback needs the live bed on the same grid and cell. Check the TerrainBed and collider configuration.',
        );
      const source = regionWords(this.memory, port.region) as Float32Array;
      const saved = regionWords(this.memory, this.heights) as Float32Array;
      if (source.some((value, index) => value !== saved[index])) {
        this.ground.setHeights(source);
        (regionWords(this.memory, this.heights) as Float32Array).set(regionWords(this.memory, port.region));
      }
    }
    super.step(context, dt);
    this.cell = context.cell;
    const out = regionWords(this.memory, this.patches) as Float64Array;
    out.fill(0);
    let at = 0;
    for (const binding of this.wheels)
      at = binding.vehicle.valid ? wheelLoads(out, at, binding) : at + binding.patches.length * SOIL_PATCH_WORDS;
    for (const binding of this.tracks)
      at = binding.vehicle.valid ? trackLoads(out, at, binding) : at + binding.patches.length * SOIL_PATCH_WORDS;
    this.syncMotion(context.tick);
    this.lastTick = context.tick;
  }

  override exportPorts(tick: number): readonly Port[] {
    return [...super.exportPorts(tick), { field: this.soilField.name, region: this.patches, tick, cell: this.cell }];
  }

  override stateRegions(): readonly Region[] {
    return [...super.stateRegions(), this.patches, this.motion, ...(this.heights ? [this.heights] : [])];
  }
}
