import { hypot } from '@margoengine/math/pinned';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { add, cross, dot, scale } from '@margoengine/math/vec3';
import { atContact, impulseAt } from '../crush/rigid-contact.js';
import { FORCING_WORDS, SURFACE_WATER_FIELD, SURFACE_WATER_FORCING_FIELD } from '../hydro/fields.js';
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
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import { invalidLoad } from './errors.js';
import { FloodDragGrid, type FloodDragGridParams, floodDragImpulse, type PeriodicDragAxes } from './flood-drag-grid.js';

type Vector = readonly [number, number, number];

/** A vertical blade on a rigid oar or paddle, such as one connected to a driven shaft through a revolute joint. */
export interface FloodPaddleBlade {
  /** Rigid body row of the shaft or oar. */
  readonly row: number;
  /** Blade centre in body-local metres. */
  readonly centre: Vector;
  /** Body-local normal of the vertical blade. The shallow-water solver resolves its horizontal direction. */
  readonly normal: Vector;
  /** Full wetted face area in m² before clipping against water and bed. */
  readonly area: number;
  /** Half-height of the upright blade, in m. */
  readonly halfHeight: number;
  /** Flat-plate normal drag coefficient. Provide one for the blade's operating regime. */
  readonly dragCoefficient: number;
}

/**
 * What a flood paddle load is made from: the drag grid parameters, the paddle blades and the rate level (default
 * 60 Hz).
 */
export interface FloodPaddleParams extends FloodDragGridParams {
  readonly blades: readonly FloodPaddleBlade[];
  /** Match the shallow-water and rigid solvers' framework rate, default 60 Hz (level zero). */
  readonly rate?: RateLevel;
}

function vector(value: Vector): boolean {
  return value?.length === 3 && value.every(Number.isFinite);
}

/**
 * Reciprocal pressure drag for upright blades in depth-averaged water. The shaft and blade kinematics come from
 * actual rigid bodies, so a joint motor sees the water torque. The water receives the opposite horizontal impulse.
 * Labbé et al. (2019), Physics of Rowing Oars, Eq. (3a), DOI 10.1088/1367-2630/ab4226.
 * For persistently wet cells, put the standalone solver before both water and rigid in a same-rate staggered group.
 * Where cells can dry during transport, install the blade with ShallowWaterSolver.withFloodLoads and put the
 * integrated water before rigid. Use resolved fluid for unsteady lift, added mass, exit splash or vertical momentum.
 */
export class FloodPaddleSolver implements Solver<FloodPaddleParams> {
  private host?: SolverHost;
  private grid?: FloodDragGrid;
  private rate: RateLevel = 0;
  private impulses?: Region;
  private forcing?: Region;
  private reactions?: Region;
  private blades: readonly FloodPaddleBlade[] = [];

  constructor(readonly id = 'floodPaddle') {}

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.rate,
      stableRate: () => this.rate,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
        { field: SURFACE_WATER_FIELD, access: 'read' },
        { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' },
      ],
    };
  }

  init(host: SolverHost, params: FloodPaddleParams): void {
    if (!params?.blades?.length) throw invalidLoad('Provide at least one upright blade and its rigid shaft row.');
    const grid = new FloodDragGrid(params);
    const rows = host.bodyRows();
    const rate = params.rate ?? 0;
    if (!Number.isInteger(rate) || rate < 0 || rate >= RATE_LEVELS)
      throw invalidLoad('Choose a paddle solver rate from 0 to 7 matching the water and rigid solvers.');
    const blades = params.blades.map((blade) => {
      if (!blade) throw invalidLoad('Provide a complete blade record for each paddle.');
      const { row, centre, normal, area, halfHeight, dragCoefficient } = blade;
      if (!Number.isSafeInteger(row) || row < 0 || row >= rows || !vector(centre) || !vector(normal))
        throw invalidLoad('Choose an existing shaft row and finite blade centre and normal.');
      if (
        ![area, halfHeight, dragCoefficient].every((x) => x > 0 && Number.isFinite(x)) ||
        !(hypot(normal[0], 0, normal[2]) > 0) ||
        normal[1] !== 0
      )
        throw invalidLoad('Use a horizontal blade normal and positive finite blade area, height and drag coefficient.');
      return { row, centre: [...centre] as Vector, normal: [...normal] as Vector, area, halfHeight, dragCoefficient };
    });
    this.impulses = host.allocate('paddleImpulses', rows * IMPULSE_WORDS * 8, 'f64', 1);
    this.forcing = host.allocate('paddleWaterForcing', grid.count * FORCING_WORDS * 8, 'f64', 1);
    this.reactions = host.allocate('paddleReactions', blades.length * IMPULSE_WORDS * 8, 'f64', 1);
    this.host = host;
    this.grid = grid;
    this.rate = rate;
    this.blades = blades;
  }

  private words(region: Region | undefined): Float64Array {
    if (!this.host || !region) throw invalidLoad('Add the flood paddle solver to a PhysicsWorld before using it.');
    return new Float64Array(this.host.memory.buffer, region.byteOffset, region.byteLength / 8);
  }

  step(context: StepContext, dt: number): void {
    this.exchange(context, dt);
  }

  /** Settle one exchange against Hydro's finalized depth, discharge and bed before that tick's rigid step. */
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
    { cell, inputs, tick }: StepContext,
    dt: number,
    finalWater?: Float64Array,
    bottom?: Float64Array,
    periodic?: PeriodicDragAxes,
  ): void {
    const output = this.words(this.impulses);
    const forcing = this.words(this.forcing);
    const reactions = this.words(this.reactions);
    const port = inputs.get(BODIES_FIELD.name);
    const region = port?.region;
    if (
      !region ||
      region.type !== 'f32' ||
      region.layout !== 2 ||
      region.byteLength / 4 !== (output.length / IMPULSE_WORDS) * BODY_WORDS
    )
      throw invalidLoad('Use the matching layout-2 rigid body field for the paddle shaft.');
    if (port?.tick !== tick - 1)
      throw invalidLoad('Match the rigid and paddle rate levels and stagger the paddle exchange before the shaft.');
    const host = this.host!;
    const grid = this.grid!;
    const bodies = new Float32Array((region.memory ?? host.memory).buffer, region.byteOffset, region.byteLength / 4);
    const flood = finalWater
      ? { water: finalWater, cell }
      : grid.read(host, inputs.get(SURFACE_WATER_FIELD.name), tick - 1);
    output.fill(0);
    forcing.fill(0);
    reactions.fill(0);
    for (const [i, blade] of this.blades.entries()) {
      const at = blade.row * BODY_WORDS;
      const q = bodies.subarray(at + 3, at + 7);
      if (!q.some((value) => value !== 0)) throw invalidLoad('Keep the paddle attached to a live rigid shaft row.');
      const centre = add(bodies.subarray(at, at + 3), rotateByQuaternion(blade.centre, q));
      const worldNormal = rotateByQuaternion(blade.normal, q);
      const length = hypot(worldNormal[0], 0, worldNormal[2]);
      if (!(length > 0)) continue;
      const direction: Vector = [worldNormal[0] / length, 0, worldNormal[2] / length];
      const local = grid.point(centre, port!.cell, flood.cell);
      const sample = grid.sample(flood.water, forcing, local, blade.halfHeight, dt, bottom, periodic);
      if (!sample) continue;
      const point = grid.point(sample.point, flood.cell, port!.cell);
      const body = atContact(bodies, output, blade.row, point, direction);
      const slip = dot([sample.vx, 0, sample.vz], direction) - dot(body.velocity, direction);
      const coefficient = 0.5 * grid.density * sample.wet * blade.area * blade.dragCoefficient;
      const amount = floodDragImpulse(slip, body.inverseMass + sample.inverseMass, coefficient, dt);
      const impulse = scale(direction, amount);
      const moment = cross(body.arm, impulse);
      if (!moment.every(Number.isFinite))
        throw invalidLoad('Choose blade lever arms and drag whose angular impulse is finite.');
      impulseAt(output, blade.row, impulse, body.arm);
      grid.react(forcing, sample, impulse[0], impulse[2], dt);
      reactions.set([...impulse, ...moment], i * IMPULSE_WORDS);
    }
  }

  /** Linear then angular impulse about the rigid body's centre, for the most recent blade exchange. */
  readBlade(index: number): readonly [number, number, number, number, number, number] {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.blades.length)
      throw invalidLoad('Choose the index of an installed paddle blade.');
    const at = index * IMPULSE_WORDS;
    const values = this.words(this.reactions);
    return [values[at]!, values[at + 1]!, values[at + 2]!, values[at + 3]!, values[at + 4]!, values[at + 5]!];
  }

  exportPorts(tick: number): readonly Port[] {
    if (!this.impulses || !this.forcing) throw invalidLoad('Add the flood paddle before coupling its impulse fields.');
    return [
      { field: BODY_IMPULSES_FIELD.name, region: this.impulses, tick, cell: [0, 0, 0] },
      { field: SURFACE_WATER_FORCING_FIELD.name, region: this.forcing, tick, cell: [0, 0, 0] },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    if (!this.impulses || !this.forcing || !this.reactions) return [];
    return [this.impulses, this.forcing, this.reactions];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
