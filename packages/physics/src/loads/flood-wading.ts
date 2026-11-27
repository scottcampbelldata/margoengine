import { gravityMagnitude } from '@margoengine/math/gravity';
import { hypot } from '@margoengine/math/pinned';
import { FORCING_WORDS, SURFACE_WATER_FIELD, SURFACE_WATER_FORCING_FIELD } from '../hydro/fields.js';
import { LEGGED_LOAD_FIELD, LEGGED_POSE_FIELD } from '../legged/index.js';
import { GROUND_LOCOMOTION_LAYOUT } from '../locomotion/index.js';
import {
  type Port,
  type RateLevel,
  RATE_LEVELS,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { invalidLoad } from './errors.js';
import { FloodDragGrid, type FloodDragGridParams, floodDragImpulse, type PeriodicDragAxes } from './flood-drag-grid.js';

const POSE_WORDS = 14;
const LOAD_WORDS = 3;

/** An upright projected profile for a wading biped or quadruped. Dimensions are measured in the same pose as the gait. */
export interface FloodWadingBody {
  /** Animal and carried mass together, in kg. Match the LeggedLocomotion body. */
  readonly mass: number;
  /** Profile centre elevation relative to the animal COM, in m. */
  readonly centreOffset: number;
  /** Half-height of the hydrodynamic profile, in m. */
  readonly halfHeight: number;
  /** Fully wetted frontal area normal to the horizontal flow, in m². */
  readonly area: number;
  /** Fully immersed displacement, in m³. */
  readonly volume: number;
  /** Form drag coefficient measured or specified for the frontal posture. */
  readonly dragCoefficient: number;
}

export interface FloodWadingParams extends FloodDragGridParams {
  /** One entry in LeggedLocomotion's body order. Null leaves that row's load zero. */
  readonly bodies: readonly (FloodWadingBody | null)[];
  /** Match the shallow-water and legged rates. Defaults to level zero (60 Hz). Use world.levelOf for the legged rate. */
  readonly rate?: RateLevel;
}

/**
 * Loads a legged body with buoyancy and pressure drag. The horizontal reaction returns to the live shallow-water grid.
 * Orselli and Duarte (2011), Joint forces and torques when walking in shallow water, DOI 10.1016/j.jbiomech.2011.01.017.
 * Use `ShallowWaterSolver.withFloodLoads({ wading })` when the receiving cells can dry or rewet during transport.
 * The standalone step assumes the receiving cells remain wet throughout the tick.
 * The single upright profile resolves total COM drag and buoyancy. Use segment loads for resolved limb forces and
 * three-dimensional flow when vertical jets, limb wakes, or wave generation by displaced volume matter.
 */
export class FloodWadingSolver implements Solver<FloodWadingParams> {
  private host?: SolverHost;
  private grid?: FloodDragGrid;
  private rate: RateLevel = 0;
  private gravity = 0;
  private loads?: Region;
  private forcing?: Region;
  private bodies: readonly (FloodWadingBody | null)[] = [];

  constructor(readonly id = 'floodWading') {}

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.rate,
      stableRate: () => this.rate,
      fields: [
        { field: LEGGED_POSE_FIELD, access: 'read' },
        { field: LEGGED_LOAD_FIELD, access: 'write' },
        { field: SURFACE_WATER_FIELD, access: 'read' },
        { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' },
      ],
    };
  }

  init(host: SolverHost, params: FloodWadingParams): void {
    if (!params?.bodies?.length) throw invalidLoad('Provide one wading-profile entry per LeggedLocomotion body.');
    const grid = new FloodDragGrid(params);
    const rate = params.rate ?? 0;
    if (!Number.isInteger(rate) || rate < 0 || rate >= RATE_LEVELS)
      throw invalidLoad('Choose a wading rate from 0 to 7 matching the water and legged solvers.');
    const bodies = params.bodies.map((body) => {
      if (!body) return null;
      const { mass, centreOffset, halfHeight, area, volume, dragCoefficient } = body;
      if (
        ![mass, halfHeight, area, volume, dragCoefficient].every((x) => x > 0 && Number.isFinite(x)) ||
        !Number.isFinite(centreOffset)
      )
        throw invalidLoad(
          'Give the wading body a finite offset and positive mass, frontal geometry and drag coefficient.',
        );
      return { mass, centreOffset, halfHeight, area, volume, dragCoefficient };
    });
    this.loads = host.allocate('wadingLoads', bodies.length * LOAD_WORDS * 8, 'f64', GROUND_LOCOMOTION_LAYOUT);
    this.forcing = host.allocate('wadingWaterForcing', grid.count * FORCING_WORDS * 8, 'f64', 1);
    this.gravity = gravityMagnitude(host.gravity);
    this.host = host;
    this.grid = grid;
    this.rate = rate;
    this.bodies = bodies;
  }

  private words(region: Region | undefined): Float64Array {
    if (!this.host || !region) throw invalidLoad('Add the flood wading solver to a PhysicsWorld before using it.');
    return new Float64Array(this.host.memory.buffer, region.byteOffset, region.byteLength / 8);
  }

  step(context: StepContext, dt: number): void {
    this.exchange(context, dt);
  }

  /** Settle the paired force against Hydro's final wetted state before publishing it to the legs. */
  settleFlood(
    context: StepContext,
    dt: number,
    water: Float64Array,
    bottom: Float64Array,
    periodic: PeriodicDragAxes,
  ): void {
    this.exchange(context, dt, water, bottom, periodic);
    this.grid!.applyReaction(water, this.words(this.forcing), dt);
  }

  private exchange(
    { inputs, tick }: StepContext,
    dt: number,
    settledWater?: Float64Array,
    bottom?: Float64Array,
    periodic?: PeriodicDragAxes,
  ): void {
    const forces = this.words(this.loads);
    const forcing = this.words(this.forcing);
    const port = inputs.get(LEGGED_POSE_FIELD.name);
    const region = port?.region;
    if (
      !region ||
      region.type !== 'f64' ||
      region.layout !== GROUND_LOCOMOTION_LAYOUT ||
      region.byteLength !== this.bodies.length * POSE_WORDS * 8
    )
      throw invalidLoad('Use the matching LeggedLocomotion pose field and one wading entry for each body.');
    if (port?.tick !== tick - 1)
      throw invalidLoad('Match the wading and legged rate levels and stagger wading before LeggedLocomotion.');
    const host = this.host!;
    const grid = this.grid!;
    const poses = new Float64Array((region.memory ?? host.memory).buffer, region.byteOffset, region.byteLength / 8);
    const water = settledWater ?? grid.read(host, inputs.get(SURFACE_WATER_FIELD.name), tick - 1);
    forces.fill(0);
    forcing.fill(0);
    for (const [i, body] of this.bodies.entries()) {
      if (!body) continue;
      const at = i * POSE_WORDS;
      const centre = grid.point([poses[at]!, poses[at + 1]! + body.centreOffset, poses[at + 2]!], port!.cell);
      const sample = grid.sample(water, forcing, centre, body.halfHeight, dt, bottom, periodic);
      if (!sample) continue;
      const vx = sample.vx - poses[at + 3]!;
      const vz = sample.vz - poses[at + 5]!;
      const slip = hypot(vx, vz);
      const coefficient = 0.5 * grid.density * sample.wet * body.area * body.dragCoefficient;
      const impulse = floodDragImpulse(slip, 1 / body.mass + sample.inverseMass, coefficient, dt);
      const x = slip > 0 ? (vx / slip) * impulse : 0;
      const z = slip > 0 ? (vz / slip) * impulse : 0;
      const buoyancy = grid.density * this.gravity * sample.wet * body.volume;
      if (!Number.isFinite(buoyancy) || !Number.isFinite(x / dt) || !Number.isFinite(z / dt))
        throw invalidLoad('Choose a wading profile whose buoyancy and drag fit finite SI forces.');
      forces.set([x / dt, buoyancy, z / dt], i * LOAD_WORDS);
      grid.react(forcing, sample, x, z, dt);
    }
  }

  /** Last hydrodynamic world force at a wader's COM in N. */
  readBody(index: number): readonly [number, number, number] {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.bodies.length)
      throw invalidLoad('Choose an index from the legged bodies configured for wading.');
    const at = index * LOAD_WORDS;
    const forces = this.words(this.loads);
    return [forces[at]!, forces[at + 1]!, forces[at + 2]!];
  }

  exportPorts(tick: number): readonly Port[] {
    if (!this.loads || !this.forcing) throw invalidLoad('Add the flood wading solver before exporting its loads.');
    return [
      { field: LEGGED_LOAD_FIELD.name, region: this.loads, tick, cell: [0, 0, 0] },
      { field: SURFACE_WATER_FORCING_FIELD.name, region: this.forcing, tick, cell: [0, 0, 0] },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    if (!this.loads || !this.forcing) return [];
    return [this.loads, this.forcing];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
