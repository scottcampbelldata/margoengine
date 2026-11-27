import { FORCING_WORDS, SURFACE_WATER_FIELD, SURFACE_WATER_FORCING_FIELD } from '../hydro/index.js';
import {
  SWIM_PASSIVE_REACTION_FIELD,
  SWIM_PASSIVE_REACTION_LAYOUT,
  SWIM_WAKE_FIELD,
  SWIM_WAKE_LAYOUT,
  SWIM_WAKE_WORDS,
} from '../life/wake.js';
import { regionWords } from '../world/memory.js';
import {
  type FieldDescriptor,
  isRateLevel,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { invalidLoad } from './errors.js';
import { FloodDragGrid, type FloodDragGridParams } from './flood-drag-grid.js';

export interface SwimDragToWaterParams extends FloodDragGridParams {
  /** Same dyadic rate as the swimmer and the shallow water. Defaults to level zero (60 Hz). */
  readonly rate?: RateLevel;
}

const PASSIVE = {
  layout: SWIM_PASSIVE_REACTION_LAYOUT,
  wordsPerBody: SWIM_WAKE_WORDS,
  repair:
    'Enable SwimSolver passiveReaction and stagger the swimmer, drag receiver, and shallow water in that order at the same rate.',
};
const ACTUATOR = {
  layout: SWIM_WAKE_LAYOUT,
  wordsPerBody: 2 * SWIM_WAKE_WORDS,
  repair:
    'Connect the two wake rows per SwimSolver body, then stagger the swimmer, actuator receiver, and shallow water in that order at the same rate.',
};

function matchesField(field: FieldDescriptor, expected: FieldDescriptor): boolean {
  return (
    field?.kind === expected.kind &&
    field.quantity === expected.quantity &&
    field.unit === expected.unit &&
    field.centring === expected.centring
  );
}

/**
 * Delivers a swimmer's horizontal water impulse to shallow water. The constructor takes the applied passive drag from
 * `SwimSolver.load({passiveReaction: true})`. Use `SwimDragToWater.actuators()` for the published tail and fin impulses.
 * Add it with the water's bed, density and level. Use `world.couple(['swim', 'swimDragToWater', 'water'], 'staggered')`
 * with the swimmer reading the same `water.flow`, and keep the receiving cells wet throughout the water step.
 * The packet is in N·s and already includes wet weighting. The wet interpolation weights distribute it once.
 * The depth-averaged water accepts x/z momentum. Vertical drag, torque and potential-flow added inertia require a 3D receiver.
 * Normalized spreading follows the conservation identity in C. S. Peskin (2002), doi:10.1017/S0962492902000077, § 5.
 */
export class SwimDragToWater implements Solver<SwimDragToWaterParams> {
  private host?: SolverHost;
  private grid?: FloodDragGrid;
  private forcing?: Region;
  private rate: RateLevel = 0;
  private field: FieldDescriptor;
  private source = PASSIVE;

  constructor(
    readonly id = 'swimDragToWater',
    field: FieldDescriptor = SWIM_PASSIVE_REACTION_FIELD,
  ) {
    if (!matchesField(field, SWIM_PASSIVE_REACTION_FIELD))
      throw invalidLoad(
        'Pass the passive linear drag field from SwimSolver, using the SWIM_PASSIVE_REACTION_FIELD descriptor.',
      );
    this.field = field;
  }

  /**
   * Returns the signed horizontal tail and pectoral impulses to a persistently wet shallow-water patch. Register it in
   * the water bed's origin cell after the same-rate swimmer and before water. Keep each active wake footprint in wet
   * receiving cells. A separate default receiver can return passive drag from the same swimmer.
   */
  static actuators(id = 'swimActuatorWakeToWater', field: FieldDescriptor = SWIM_WAKE_FIELD): SwimDragToWater {
    if (!matchesField(field, SWIM_WAKE_FIELD))
      throw invalidLoad('Pass the SwimSolver actuator wake field using the SWIM_WAKE_FIELD descriptor.');
    const receiver = new SwimDragToWater(id);
    receiver.field = field;
    receiver.source = ACTUATOR;
    return receiver;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.rate,
      stableRate: () => this.rate,
      fields: [
        { field: this.field, access: 'read' },
        { field: SURFACE_WATER_FIELD, access: 'read' },
        { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' },
      ],
    };
  }

  init(host: SolverHost, params: SwimDragToWaterParams): void {
    if (!params?.bed) throw invalidLoad('Pass the same bed to the swimmer drag receiver and ShallowWaterSolver.');
    const rate = params.rate ?? 0;
    if (!isRateLevel(rate)) throw invalidLoad('Choose the same drag, swimming and shallow-water rate from 0 to 7.');
    const grid = new FloodDragGrid(params);
    this.forcing = host.allocate('swimDragWaterForcing', grid.count * FORCING_WORDS * 8, 'f64', 1);
    this.host = host;
    this.grid = grid;
    this.rate = rate;
  }

  step({ tick, inputs }: StepContext, dt: number): void {
    const { host, grid, forcing } = this;
    if (!host || !grid || !forcing)
      throw invalidLoad('Add the swimmer drag receiver to a PhysicsWorld before stepping.');
    const port = inputs.get(this.field.name);
    const region = port?.region;
    if (
      !region ||
      region.type !== 'f64' ||
      region.layout !== this.source.layout ||
      region.byteLength === 0 ||
      region.byteLength % (this.source.wordsPerBody * 8) !== 0 ||
      port.tick !== tick
    )
      throw invalidLoad(this.source.repair);
    const water = grid.read(host, inputs.get(SURFACE_WATER_FIELD.name), tick - 1);
    const packets = regionWords(region.memory ?? host.memory, region) as Float64Array;
    const out = regionWords(host.memory, forcing) as Float64Array;
    out.fill(0);
    for (let at = 0; at < packets.length; at += SWIM_WAKE_WORDS) {
      const x = packets[at + 3]!,
        z = packets[at + 5]!;
      if (x === 0 && z === 0) continue;
      const point = grid.point(packets.subarray(at, at + 3), port.cell);
      const radius = packets[at + 6]!;
      const sample = grid.sample(water, out, point, radius, dt);
      if (!sample) throw invalidLoad('Keep nonzero swimmer reactions inside the coupled wet shallow-water grid.');
      // The receipt already names the water's impulse. FloodDragGrid takes the body's opposite impulse.
      grid.react(out, sample, -x, -z, dt);
    }
  }

  exportPorts(tick: number): readonly Port[] {
    return this.forcing
      ? [{ field: SURFACE_WATER_FORCING_FIELD.name, region: this.forcing, tick, cell: [0, 0, 0] }]
      : [];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return this.forcing ? [this.forcing] : [];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
