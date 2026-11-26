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
import { SOIL_LAYOUT, SOIL_PATCH_WORDS, SOIL_WHEEL_REACTION_WORDS } from './index.js';

type Point = readonly [number, number, number];
type Pair = readonly [number, number];

export interface WheelSoilBinding {
  readonly vehicle: Vehicle;
  /** Projected footprint length and width per wheel, m. */
  readonly patches: readonly { readonly length: number; readonly width: number }[];
  /** Effective shear radius, m, per wheel. Null keeps the tyre slip. For lugs use rim radius plus half lug height. */
  readonly shearRadii?: readonly (number | null)[];
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
  /** Publish live wheel spin in the same order as the soil patch records. Use soilWheelPhaseField. */
  readonly wheelPhase?: FieldDescriptor;
  /** Apply solved drawbar and axle reactions to wheels on the registered terrain collider. */
  readonly wheelReaction?: FieldDescriptor;
  /** Optional lateral soil force to consume along with wheelReaction. Use soilWheelSideForceField. */
  readonly wheelSideForce?: FieldDescriptor;
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

function rollingSlips(
  binding: WheelSoilBinding,
  wheel: ReturnType<Vehicle['wheel']>,
  fx: number,
  fz: number,
  radius: number,
  lateral: number,
): Pair {
  const point = wheel.contactPoint;
  const normal = wheel.contactNormal;
  if (!point || !normal || !wheel.ground || !(normal[1] > 0)) return [wheel.slipRatio, lateral];
  const fy = -(normal[0] * fx + normal[2] * fz) / normal[1];
  const forwardLength = hypot(1, fy);
  const speed = binding.vehicle.chassis.velocityAtPoint(point);
  const bedSpeed = wheel.ground.body.velocityAtPoint(point);
  const vx = speed[0] - bedSpeed[0];
  const vy = speed[1] - bedSpeed[1];
  const vz = speed[2] - bedSpeed[2];
  const travel = (vx * fx + vy * fy + vz * fz) / forwardLength;
  const [nx, ny, nz] = normal;
  const x = ny * fz - nz * fy;
  const y = nz * fx - nx * fz;
  const z = nx * fy - ny * fx;
  const crossing = (vx * x + vy * y + vz * z) / hypot(hypot(x, y), z);
  const rim = radius * wheel.spin;
  const scale = Math.max(Math.abs(travel), Math.abs(rim));
  const along = Math.max(Math.abs(travel), Number.EPSILON * Math.abs(crossing));
  return [scale > 0 ? (rim - travel) / scale : 0, along > 0 ? -crossing / along : 0];
}

function wheelLoads(out: Float64Array, at: number, binding: WheelSoilBinding, phases?: Float64Array): number {
  const { vehicle, patches, ground } = binding;
  const [x, z] = heading(vehicle, binding.forward);
  for (const [index, patch] of patches.entries()) {
    const wheel = vehicle.wheel(index);
    if (phases) phases[at / SOIL_PATCH_WORDS] = wheel.rotation;
    if (wheel.contactPoint && wheel.load > 0 && (!ground || ground === wheel.ground)) {
      const azimuth = wheel.steering;
      const lateral = (patch.length * sin(wheel.slipAngle)) / Math.max(cos(wheel.slipAngle), Number.EPSILON);
      const fx = x * cos(azimuth) + z * sin(azimuth);
      const fz = z * cos(azimuth) - x * sin(azimuth);
      const radius = binding.shearRadii?.[index];
      const [axial, across] = radius
        ? rollingSlips(binding, wheel, fx, fz, radius, lateral / patch.length)
        : [wheel.slipRatio, 0];
      const longitudinal = -axial * patch.length;
      const transverse = radius ? across * patch.length : lateral;
      out.set(
        [
          wheel.contactPoint[0],
          wheel.contactPoint[2],
          fx,
          fz,
          patch.length,
          patch.width,
          wheel.load,
          longitudinal * fx + transverse * fz,
          longitudinal * fz - transverse * fx,
          3,
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
  private readonly phase?: FieldDescriptor;
  private readonly reaction?: FieldDescriptor;
  private readonly sideForce?: FieldDescriptor;
  private ground?: PhysicsCollider;
  private heights?: Region;
  private phases?: Region;

  constructor(
    readonly soilField: FieldDescriptor,
    options: SoilContactRigidOptions = {},
  ) {
    super(options.id ?? 'rigid');
    this.terrain = options.terrain && { ...options.terrain, centre: [...options.terrain.centre] };
    this.phase = options.wheelPhase && { ...options.wheelPhase };
    this.reaction = options.wheelReaction && { ...options.wheelReaction };
    this.sideForce = options.wheelSideForce && { ...options.wheelSideForce };
    if (this.sideForce && !this.reaction)
      throw new MargoError('state', 'Lateral soil feedback needs the wheel reaction field. Provide wheelReaction too.');
  }

  override describe() {
    const base = super.describe();
    return {
      ...base,
      fields: [
        ...base.fields,
        { field: this.soilField, access: 'write' as const },
        ...(this.phase ? [{ field: this.phase, access: 'write' as const }] : []),
        ...(this.reaction ? [{ field: this.reaction, access: 'read' as const }] : []),
        ...(this.sideForce ? [{ field: this.sideForce, access: 'read' as const }] : []),
        ...(this.terrain ? [{ field: BED_FIELD, access: 'read' as const }] : []),
      ],
    };
  }

  override init(host: SolverHost, params: SoilContactRigidParams): void {
    const soilCollider = this.reaction ? params.ground?.collider : undefined;
    this.wheels = (params.wheels ?? []).map((entry) => ({
      ...entry,
      ground: entry.ground ?? soilCollider,
      patches: entry.patches.map((p) => ({ ...p })),
      shearRadii: entry.shearRadii && [...entry.shearRadii],
    }));
    this.tracks = (params.tracks ?? []).map((entry) => ({ ...entry, patches: entry.patches.map((p) => ({ ...p })) }));
    this.vehicles = [...this.wheels, ...this.tracks].map(({ vehicle }) => vehicle);
    const rows = [...this.wheels, ...this.tracks].reduce((count, binding) => count + binding.patches.length, 0);
    if (this.reaction && (!soilCollider || !this.wheels.some((binding) => binding.ground === soilCollider)))
      throw new MargoError(
        'state',
        'Wheel reactions need a soil collider and wheel bindings. Provide both on the same bed.',
      );
    if (
      !rows ||
      new Set(this.vehicles).size !== this.vehicles.length ||
      this.vehicles.some((v) => !params.physics.owns(v.chassis)) ||
      this.wheels.some((b) => b.patches.length !== b.vehicle.wheelCount) ||
      this.tracks.some((b) => b.patches.length !== b.vehicle.trackCount) ||
      this.wheels.some(
        (b) =>
          b.shearRadii &&
          (b.shearRadii.length !== b.vehicle.wheelCount ||
            b.shearRadii.some((radius) => radius !== null && !(Number.isFinite(radius) && radius > 0))),
      ) ||
      [...this.wheels, ...this.tracks].some((b) =>
        b.patches.some((p) => ![p.length, p.width].every((s) => Number.isFinite(s) && s > 0)),
      )
    )
      throw new MargoError(
        'state',
        'Soil contact bindings disagree with the rigid world. Provide distinct live vehicles and positive footprint dimensions and shear radii.',
      );
    super.init(host, params);
    this.memory = host.memory;
    this.patches = host.allocate('rigid-soil-patches', rows * SOIL_PATCH_WORDS * 8, 'f64', SOIL_LAYOUT);
    if (this.phase) this.phases = host.allocate('rigid-soil-wheel-phase', rows * 8, 'f64', SOIL_LAYOUT);
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

  private applyReactions(context: StepContext): void {
    const field = this.reaction;
    const collider = this.ground;
    if (!field || !collider) return;
    const port = context.inputs.get(field.name);
    if (!port) return;
    if (
      port.region.type !== 'f64' ||
      port.region.layout !== SOIL_LAYOUT ||
      port.region.byteLength * SOIL_PATCH_WORDS !== this.patches.byteLength * SOIL_WHEEL_REACTION_WORDS ||
      (port.region.memory ?? this.memory) !== this.memory ||
      port.cell.some((coordinate, axis) => coordinate !== context.cell[axis])
    )
      throw new MargoError(
        'state',
        'Wheel reactions do not match the soil bindings. Use the same layout, rows and cell.',
      );
    const words = regionWords(this.memory, port.region) as Float64Array;
    const sides = this.sideForce && context.inputs.get(this.sideForce.name);
    if (
      sides &&
      (sides.region.type !== 'f64' ||
        sides.region.layout !== SOIL_LAYOUT ||
        sides.region.byteLength * SOIL_PATCH_WORDS !== this.patches.byteLength ||
        (sides.region.memory ?? this.memory) !== this.memory ||
        sides.cell.some((coordinate, axis) => coordinate !== context.cell[axis]))
    )
      throw new MargoError(
        'state',
        'Wheel side forces do not match the soil bindings. Use the same layout, rows and cell.',
      );
    const lateral = sides ? (regionWords(this.memory, sides.region) as Float64Array) : undefined;
    let row = 0;
    for (const binding of this.wheels) {
      for (let i = 0; i < binding.patches.length; i++, row++) {
        const at = row * SOIL_WHEEL_REACTION_WORDS;
        if (binding.vehicle.valid && binding.ground === collider && words[at] !== 0)
          binding.vehicle.setWheelGroundTraction(i, {
            collider,
            load: words[at]!,
            drawbar: words[at + 1]!,
            axleTorque: words[at + 2]!,
            sideForce: lateral && -lateral[row]!,
          });
      }
    }
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
    this.applyReactions(context);
    super.step(context, dt);
    this.cell = context.cell;
    const out = regionWords(this.memory, this.patches) as Float64Array;
    out.fill(0);
    const phases = this.phases ? (regionWords(this.memory, this.phases) as Float64Array) : undefined;
    phases?.fill(0);
    let at = 0;
    for (const binding of this.wheels)
      at = binding.vehicle.valid
        ? wheelLoads(out, at, binding, phases)
        : at + binding.patches.length * SOIL_PATCH_WORDS;
    for (const binding of this.tracks)
      at = binding.vehicle.valid ? trackLoads(out, at, binding) : at + binding.patches.length * SOIL_PATCH_WORDS;
    this.syncMotion(context.tick);
    this.lastTick = context.tick;
  }

  override exportPorts(tick: number): readonly Port[] {
    return [
      ...super.exportPorts(tick),
      { field: this.soilField.name, region: this.patches, tick, cell: this.cell },
      ...(this.phase && this.phases ? [{ field: this.phase.name, region: this.phases, tick, cell: this.cell }] : []),
    ];
  }

  override stateRegions(): readonly Region[] {
    return [
      ...super.stateRegions(),
      this.patches,
      this.motion,
      ...(this.heights ? [this.heights] : []),
      ...(this.phases ? [this.phases] : []),
    ];
  }
}
