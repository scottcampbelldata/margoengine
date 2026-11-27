import { hypot } from '@margoengine/math/pinned';
import { conjugateQuaternion, normalizeQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import { FORCING_WORDS, SURFACE_WATER_FIELD, SURFACE_WATER_FORCING_FIELD } from '../hydro/fields.js';
import { regionWords } from '../world/memory.js';
import {
  isRateLevel,
  type Cell,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, bodyRowsOf, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import { invalidLoad } from './errors.js';
import { floodBlockageExchange, type FloodBlockageBody } from './flood-blockage.js';
import { FloodDragGrid, type FloodDragGridParams, type PeriodicDragAxes } from './flood-drag-grid.js';

type Vec3 = readonly [number, number, number];
type Projection = 'box' | 'ellipsoid';

export interface FloodBodyDragBody {
  /** A dynamic rigid body row. */
  readonly row: number;
  /** Profile centre relative to the rigid centre of mass in body-local metres. Defaults to [0, 0, 0]. */
  readonly centre?: Vec3;
  /** Fixed vertical half-height or three local half-extents to project onto world up, in metres. */
  readonly halfHeight: number | Vec3;
  /** Measured frontal area, or the three principal frontal areas in body-local axes, in m². */
  readonly area: number | Vec3;
  /** Projection rule for the three-axis dimensions. Defaults to 'ellipsoid'. Scalars are used directly. */
  readonly projection?: Projection;
  /** Nonnegative quadratic form drag coefficient. */
  readonly dragCoefficient: number;
}

export interface FloodBodyDragParams extends FloodDragGridParams {
  /** One patch per body; patches apply in rigid row order. */
  readonly bodies: readonly FloodBodyDragBody[];
  /** Match the water and rigid step levels. Defaults to 0. */
  readonly rate?: RateLevel;
}

const ORIGIN: Cell = [0, 0, 0];
const REGISTRY_BODY_LAYOUT = 2;
const FORCING_LAYOUT = 1;
const IMPULSE_LAYOUT = 1;

function validExtent(value: number | Vec3): boolean {
  return typeof value === 'number'
    ? value > 0 && Number.isFinite(value)
    : value?.length === 3 && value.every((v) => v > 0 && Number.isFinite(v));
}

function copyExtent(value: number | Vec3): number | Vec3 {
  return typeof value === 'number' ? value : [value[0], value[1], value[2]];
}

function projected(extent: number | Vec3, direction: Vec3, kind: Projection): number {
  if (typeof extent === 'number') return extent;
  const a = extent[0] * direction[0];
  const b = extent[1] * direction[1];
  const c = extent[2] * direction[2];
  // The box projection adds the exposed face projections. For an ellipsoid
  // the unit sphere's cofactor map makes the area proportional to this norm.
  return kind === 'box' ? Math.abs(a) + Math.abs(b) + Math.abs(c) : hypot(a, b, c);
}

function point3(values: Float32Array, at: number): Vec3 {
  return [values[at]!, values[at + 1]!, values[at + 2]!];
}

export type FloodDragProfile = Required<FloodBodyDragBody>;

export function floodDragProfiles(bodies: readonly FloodBodyDragBody[]): FloodDragProfile[] {
  if (!bodies?.length) throw invalidLoad('Provide the dynamic body rows and their flood drag profiles.');
  const rows = new Set<number>();
  const profiles = bodies.map(
    ({ row, centre = ORIGIN, halfHeight, area, projection = 'ellipsoid', dragCoefficient }): FloodDragProfile => {
      if (!Number.isSafeInteger(row) || row < 0 || rows.has(row))
        throw invalidLoad('Use one profile per configured dynamic flood body row.');
      if (
        centre?.length !== 3 ||
        !centre.every(Number.isFinite) ||
        !validExtent(halfHeight) ||
        !validExtent(area) ||
        (projection !== 'box' && projection !== 'ellipsoid') ||
        !(dragCoefficient >= 0 && Number.isFinite(dragCoefficient))
      )
        throw invalidLoad(
          'Choose finite flood geometry, positive projected dimensions and a nonnegative drag coefficient.',
        );
      rows.add(row);
      return {
        row,
        centre: [centre[0], centre[1], centre[2]],
        halfHeight: copyExtent(halfHeight),
        area: copyExtent(area),
        projection,
        dragCoefficient,
      };
    },
  );
  return profiles.sort((a, b) => a.row - b.row);
}

/** Solve one wet stencil from a rigid pose and the supplied water state. */
export function solveFloodProfile(
  grid: FloodDragGrid,
  profile: FloodDragProfile,
  rigid: Float32Array,
  at: number,
  bodyCell: Cell,
  input: {
    readonly water: Float32Array | Float64Array;
    readonly dt: number;
    readonly forcing?: Float64Array;
    readonly bottom?: Float64Array;
    readonly periodic?: PeriodicDragAxes;
  },
) {
  const { centre, halfHeight, area, projection, dragCoefficient } = profile;
  const { water, dt, forcing, bottom, periodic } = input;
  if (rigid[at + 23] !== 1 || dragCoefficient === 0) return undefined;
  const rotation = normalizeQuaternion(rigid.subarray(at + 3, at + 7));
  const inverse = conjugateQuaternion(rotation);
  const offset = rotateByQuaternion(centre, rotation);
  const bodyCentre = grid.point(rigid.subarray(at + 7, at + 10), bodyCell);
  const profileCentre: Vec3 = [bodyCentre[0] + offset[0], bodyCentre[1] + offset[1], bodyCentre[2] + offset[2]];
  const height = projected(halfHeight, rotateByQuaternion([0, 1, 0], inverse), projection);
  if (!(height > 0 && Number.isFinite(height)))
    throw invalidLoad('Choose a rigid profile with finite positive vertical support.');
  const sample = grid.sample(water, forcing, profileCentre, height, dt, bottom, periodic);
  if (!sample) return undefined;
  const body: FloodBlockageBody = {
    centre: bodyCentre,
    velocity: point3(rigid, at + 10),
    angularVelocity: point3(rigid, at + 13),
    inverseMass: rigid[at + 16]!,
    inverseInertia: [
      rigid[at + 17]!,
      rigid[at + 18]!,
      rigid[at + 19]!,
      rigid[at + 20]!,
      rigid[at + 21]!,
      rigid[at + 22]!,
    ],
  };
  const exchange = floodBlockageExchange({
    cells: sample.cells.map(({ index, depth, wetWeight, x, z }) => ({
      index,
      depth,
      x,
      z,
      weight: wetWeight,
      dischargeX: water[3 * index + 1]! + dt * (forcing?.[FORCING_WORDS * index] ?? 0),
      dischargeZ: water[3 * index + 2]! + dt * (forcing?.[FORCING_WORDS * index + 1] ?? 0),
    })),
    body,
    cellArea: grid.cellArea,
    density: grid.density,
    interval: dt,
    dragCoefficient,
    wetArea: (x, z) => {
      const speed = hypot(x, z);
      const direction = rotateByQuaternion([x / speed, 0, z / speed], inverse);
      return sample.wet * projected(area, direction, projection);
    },
    elevation: sample.point[1],
  });
  if (!exchange.bodyImpulse.every(Number.isFinite))
    throw invalidLoad('Choose wet-profile positions and body inertia whose reaction wrench fits finite SI values.');
  return { sample, bodyCentre, exchange };
}

/**
 * Reciprocal form drag for a compact body or hull in a persistently wet
 * shallow-water patch. The drag step uses Morison's quadratic resistance and
 * a shared point mobility (Morison et al. 1950, Eq. 4; Sanders et al. 2008).
 *
 * Put it before both water and rigid in one same-rate staggered group. Match
 * the bed and density. The depth-averaged water settles the horizontal
 * reaction through its existing wet-cell forcing. Keep the exchange stencil
 * wet through that water step. The solver exchanges no displaced volume.
 * Locks, joints and other rigid constraints carry support reactions. A closed
 * water/body momentum ledger needs free horizontal degrees of freedom.
 *
 * For concurrent LoadSolver bodies, set their drag to 0. For a HullSolver,
 * set its drag option to false. Buoyancy, radiation and added inertia can be
 * configured separately.
 */
export class FloodBodyDragSolver implements Solver<FloodBodyDragParams> {
  private host!: SolverHost;
  private grid!: FloodDragGrid;
  private rate: RateLevel = 0;
  private bedCell: Cell = ORIGIN;
  private bodies: readonly FloodDragProfile[] = [];
  private waterForcing!: Region;
  private bodyImpulse!: Region;
  // Process-local scratch is fully reset each step. Arena regions only
  // receive the complete pair once the exchange is finite.
  private forcingWork = new Float64Array(0);
  private impulseWork = new Float64Array(0);

  constructor(readonly id = 'floodBodyDrag') {}

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.rate,
      stableRate: () => this.rate,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: SURFACE_WATER_FIELD, access: 'read' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
        { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' },
      ],
    };
  }

  init(host: SolverHost, params: FloodBodyDragParams): void {
    const bodies = floodDragProfiles(params?.bodies);
    const rate = params.rate ?? 0;
    if (!isRateLevel(rate)) throw invalidLoad('Match the flood drag rate to the water and rigid rate levels.');
    const grid = new FloodDragGrid(params);
    const capacity = bodyRowsOf(
      host,
      this.id,
      bodies.map(({ row }) => row),
    );
    this.waterForcing = host.allocate(
      'flood-body-water-forcing',
      grid.count * FORCING_WORDS * 8,
      'f64',
      FORCING_LAYOUT,
    );
    this.bodyImpulse = host.allocate('flood-body-impulses', capacity * IMPULSE_WORDS * 8, 'f64', IMPULSE_LAYOUT);
    this.forcingWork = new Float64Array(grid.count * FORCING_WORDS);
    this.impulseWork = new Float64Array(capacity * IMPULSE_WORDS);
    this.host = host;
    this.grid = grid;
    this.rate = rate;
    this.bodies = bodies;
    this.bedCell = [...params.bed.cell];
  }

  step({ inputs, tick, cell }: StepContext, dt: number): void {
    if (!cell.every((value, axis) => value === this.bedCell[axis]))
      throw invalidLoad('Place the flood drag solver in the same origin cell as its shallow-water grid.');
    const { grid, host, forcingWork, impulseWork } = this;
    const bodyPort = inputs.get(BODIES_FIELD.name);
    const region = bodyPort?.region;
    if (
      !bodyPort ||
      bodyPort.tick !== tick - 1 ||
      !region ||
      region.layout !== REGISTRY_BODY_LAYOUT ||
      region.type !== 'f32' ||
      region.byteLength / (BODY_WORDS * 4) !== impulseWork.length / IMPULSE_WORDS
    )
      throw invalidLoad('Match the live rigid port and rate. Run flood drag before the rigid solver.');
    const rigid = regionWords(host.memory, region) as Float32Array;
    const water = grid.read(host, inputs.get(SURFACE_WATER_FIELD.name), tick - 1);
    forcingWork.fill(0);
    impulseWork.fill(0);
    for (const profile of this.bodies) {
      const { row } = profile;
      const result = solveFloodProfile(grid, profile, rigid, row * BODY_WORDS, bodyPort.cell, {
        water,
        dt,
        forcing: forcingWork,
      });
      if (!result) continue;
      const [jx, , jz] = result.exchange.bodyImpulse;
      impulseWork.set(result.exchange.bodyImpulse, row * IMPULSE_WORDS);
      grid.react(forcingWork, result.sample, jx, jz, dt);
    }
    (regionWords(host.memory, this.waterForcing) as Float64Array).set(forcingWork);
    (regionWords(host.memory, this.bodyImpulse) as Float64Array).set(impulseWork);
  }

  importPorts(): void {}

  exportPorts(tick: number): readonly Port[] {
    return [
      { field: SURFACE_WATER_FORCING_FIELD.name, region: this.waterForcing, cell: this.bedCell, tick },
      { field: BODY_IMPULSES_FIELD.name, region: this.bodyImpulse, cell: this.bedCell, tick },
    ];
  }

  stateRegions(): readonly Region[] {
    return [this.waterForcing, this.bodyImpulse];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
