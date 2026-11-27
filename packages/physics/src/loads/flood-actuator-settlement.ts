import type { Bed } from '@margoengine/math/fields';
import { SURFACE_WATER_FIELD, SURFACE_WATER_FORCING_FIELD, WATER_DENSITY } from '../hydro/fields.js';
import type { ShallowWaterSolver } from '../hydro/index.js';
import {
  type Cell,
  isRateLevel,
  type Port,
  type Region,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { invalidLoad } from './errors.js';
import type { PeriodicDragAxes } from './flood-drag-grid.js';
import { type FloodPaddleParams, FloodPaddleSolver } from './flood-paddle.js';
import { type FloodWadingParams, FloodWadingSolver } from './flood-wading.js';

/** Optional paddle and wading profiles settled against the final wet cells in one Hydro step. */
export interface FloodLoadsOptions {
  /** Shallow-water solver ID. Defaults to 'water'. */
  readonly id?: string;
  /** Fixed profile of each blade to settle before the rigid solver. */
  readonly paddle?: FloodPaddleParams;
  /** Fixed profile of each wader to settle before the legged solver. */
  readonly wading?: FloodWadingParams;
  /** Cancel loading the optional coupling. */
  readonly signal?: AbortSignal;
}

/** Register `water` in the world. The paddle and wading handles only read their accepted loads. */
export interface FloodLoadsCoupling {
  /** The water solver that owns both rounds of the exchange. */
  readonly water: ShallowWaterSolver;
  /** Read the accepted per-blade impulse with `readBlade`. */
  readonly paddle?: Pick<FloodPaddleSolver, 'readBlade'>;
  /** Read the accepted per-wader force with `readBody`. */
  readonly wading?: Pick<FloodWadingSolver, 'readBody'>;
}

/** Optional per-tick settlement owned by the same solver as the wet/dry state. */
export class FloodActuatorWater {
  readonly rate;
  readonly fields: SolverDescription['fields'];
  readonly coupling: FloodLoadsCoupling;
  private readonly paddle?: FloodPaddleSolver;
  private readonly wading?: FloodWadingSolver;
  private readonly actuators: readonly (FloodPaddleSolver | FloodWadingSolver)[];
  private work = new Float64Array(0);
  private bed?: Bed;

  constructor(
    water: ShallowWaterSolver,
    private readonly options: FloodLoadsOptions,
  ) {
    const { paddle, wading } = options;
    if (!paddle && !wading) throw invalidLoad('Pass at least one paddle or wading configuration to withFloodLoads.');
    const rate = paddle?.rate ?? wading?.rate ?? 0;
    if (!isRateLevel(rate) || (paddle && (paddle.rate ?? 0) !== rate) || (wading && (wading.rate ?? 0) !== rate))
      throw invalidLoad('Give the water, paddles and waders the same rate level from 0 to 7.');
    this.rate = rate;
    this.paddle = paddle && new FloodPaddleSolver();
    this.wading = wading && new FloodWadingSolver();
    this.actuators = [this.paddle, this.wading].filter((actuator) => actuator !== undefined);
    this.fields = this.actuators
      .flatMap((actuator) => actuator.describe().fields)
      .filter(
        ({ field }) => field.name !== SURFACE_WATER_FIELD.name && field.name !== SURFACE_WATER_FORCING_FIELD.name,
      );
    this.coupling = {
      water,
      paddle: this.paddle && { readBlade: this.paddle.readBlade.bind(this.paddle) },
      wading: this.wading && { readBody: this.wading.readBody.bind(this.wading) },
    };
  }

  init(host: SolverHost, bed: Bed, density: number, rate: number, timeScale: number): void {
    const { paddle, wading } = this.options;
    if (timeScale !== 1 || rate !== this.rate)
      throw invalidLoad('Use the flood-loads rate for Hydro and keep its timeScale at 1.');
    for (const profile of [paddle, wading]) {
      if (profile && (profile.bed !== bed || (profile.density ?? WATER_DENSITY) !== density))
        throw invalidLoad('Give Hydro and the flood-loads profiles the same bed and density.');
    }
    this.bed = bed;
    this.work = new Float64Array(bed.columns * bed.rows * 3);
    if (paddle) this.paddle!.init(host, paddle);
    if (wading) this.wading!.init(host, wading);
  }

  settle(
    context: StepContext,
    dt: number,
    water: Float64Array,
    bottom: Float64Array,
    periodic: PeriodicDragAxes,
  ): void {
    if (!this.bed || !context.cell.every((part, axis) => part === this.bed!.cell[axis]))
      throw invalidLoad('Place Hydro and the flood-loads profiles in the shared fixed bed origin.');
    this.work.set(water);
    for (const actuator of this.actuators) actuator.settleFlood(context, dt, this.work, bottom, periodic);
    if (!this.work.every(Number.isFinite))
      throw invalidLoad('Use water and actuator profiles whose accepted momentum remains finite.');
    water.set(this.work);
  }

  exportPorts(tick: number, cell: Cell): readonly Port[] {
    return this.actuators
      .flatMap((actuator) => actuator.exportPorts(tick))
      .filter(({ field }) => field !== SURFACE_WATER_FORCING_FIELD.name)
      .map((port) => ({ ...port, cell }));
  }

  stateRegions(): readonly Region[] {
    return this.actuators.flatMap((actuator) => actuator.stateRegions());
  }
}
