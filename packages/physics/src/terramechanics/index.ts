import { MargoError } from '@margoengine/math/errors';
import { exp, hypot, ln, pow } from '@margoengine/math/pinned';
import { BED_CHANGE_FIELD, BED_FIELD, BED_LAYOUT, BedChange, type BedShape, bedVertexCount } from '../earth/bed.js';
import { LEGGED_CONTACT_FIELD } from '../legged/index.js';
import { regionWords } from '../world/memory.js';
import type { Cell, FieldDescriptor, Port, Region, Solver, SolverHost, StepContext } from '../world/solver.js';
import { bindSoil, type Builds, loadSoil, type NativeSoil } from './kernel.js';

export {
  SoilContactRigidSolver,
  type SoilContactRigidParams,
  type SoilContactRigidOptions,
  type TrackSoilBinding,
  type WheelSoilBinding,
} from './rigid.js';

/** Version of the optional soil contact, response and dust fields. */
export const SOIL_LAYOUT = 1;
/** Per patch: XZ, forward XZ, length, width, normal N, shear-displacement XZ, ellipse flag. A zero load is inactive. */
export const SOIL_PATCH_WORDS = 10;
/** Per patch: pressure Pa, settlement m, mobilized shear stress Pa and normal load N. */
export const SOIL_RESPONSE_WORDS = 4;
const LEGGED_WORDS = 13;
const CENTRE = [0, 0, 0] as const;

/** Uniform prepared soil properties. Calibrate pressure–sinkage with plates of two widths. */
export interface SoilMaterial {
  /** Width-dependent addition to the pressure coefficient, Pa m^(1−n). Default 1,000. */
  readonly cohesiveModulus?: number;
  /** Width-independent pressure coefficient, Pa/m^n. Default 400,000. */
  readonly frictionalModulus?: number;
  /** Pressure–sinkage exponent n. Default 1. */
  readonly exponent?: number;
  /** Mohr–Coulomb intercept, Pa. Default 500. */
  readonly cohesion?: number;
  /** Tangent of the internal friction angle. Default 0.6. */
  readonly friction?: number;
  /** Janosi–Hanamoto shear displacement K, m. Default 0.025. */
  readonly shearLength?: number;
  /** Share of displaced bulk volume compacted in place. Default 0.2. */
  readonly compaction?: number;
  /** Fraction of the uncompacted displacement that becomes airborne dry mineral material. Default 0.0005. */
  readonly dustFraction?: number;
  /** Dry bulk density converting displaced volume to mass, kg/m³. Default 1,600. */
  readonly density?: number;
}

/** A measured wheel, belt, shoe or hoof load over a finite footprint. All values are SI. */
export interface SoilPatch {
  readonly x: number;
  readonly z: number;
  /** Projected forward direction in XZ. Default [0, 1]. */
  readonly forward?: readonly [number, number];
  readonly length: number;
  readonly width: number;
  readonly load: number;
  /** Soil shear displacement in XZ over the patch's contact, m. Default zero. */
  readonly displacement?: readonly [number, number];
  /** Elliptical tyre or hoof patch. Default rectangular shoe or belt. */
  readonly elliptical?: boolean;
}

/** Override the footprint size of a foot row in the live LIFE-01 contact field. */
export interface LeggedSoilPatch {
  readonly row: number;
  readonly length: number;
  readonly width: number;
  readonly elliptical?: boolean;
}

export interface TerramechanicsOptions {
  readonly id?: string;
  /** Read an external SOIL_LAYOUT F64 patch field, e.g. one returned by `soilPatchField`. */
  readonly input?: FieldDescriptor;
  /** Read the real LIFE-01 contact field. Provide `feet` at initialization. Default false. */
  readonly legged?: boolean;
  readonly signal?: AbortSignal;
}

export interface TerramechanicsParams {
  readonly terrain: BedShape;
  readonly material?: SoilMaterial;
  /** Known fixed contact loads. Live sources are configured with `input` or `legged`. */
  readonly patches?: readonly SoilPatch[];
  /** Number of external patch rows. Omit when there is no `input`. */
  readonly inputRows?: number;
  /** Exact contact rows to reproduce as feet. Skip the torso rows. */
  readonly feet?: readonly LeggedSoilPatch[];
  /** Minimum elevation to excavate, m in the bed cell. Default no floor. Set the same uniform floor as TerrainBed. */
  readonly floor?: number;
  /** Distance between floating-origin cells, m. Default 4,096. */
  readonly cellSize?: number;
}

export interface SoilBudget {
  readonly removed: number;
  readonly compacted: number;
  readonly suspended: number;
  readonly deposited: number;
  /** Uncontained loose volume exported when a footprint occupies the entire local bed. */
  readonly exported: number;
}

export function soilPatchField(name = 'soilContactPatch'): FieldDescriptor {
  return { name, kind: 'surfaceSampleSet', quantity: 'soilContactPatch', unit: 'record', centring: 'particle' };
}

function finite(value: number, label: string, lower = -Infinity, upper = Infinity): number {
  if (!Number.isFinite(value) || value < lower || value > upper)
    throw new MargoError('state', `Invalid soil ${label}. Provide a finite value in [${lower}, ${upper}].`);
  return value;
}

function positive(value: number, label: string): number {
  return finite(value, label, Number.MIN_VALUE);
}

function materialOf(input: SoilMaterial = {}): Required<SoilMaterial> {
  const material = {
    cohesiveModulus: finite(input.cohesiveModulus ?? 1000, 'cohesive modulus', 0),
    frictionalModulus: finite(input.frictionalModulus ?? 400_000, 'frictional modulus', 0),
    exponent: positive(input.exponent ?? 1, 'pressure exponent'),
    cohesion: finite(input.cohesion ?? 500, 'cohesion', 0),
    friction: finite(input.friction ?? 0.6, 'internal friction', 0),
    shearLength: positive(input.shearLength ?? 0.025, 'shear length'),
    compaction: finite(input.compaction ?? 0.2, 'compaction', 0, 1),
    dustFraction: finite(input.dustFraction ?? 0.0005, 'dust fraction', 0, 1),
    density: positive(input.density ?? 1600, 'bulk density'),
  };
  if (!(material.frictionalModulus + material.cohesiveModulus > 0))
    throw new MargoError('state', 'Soil stiffness is zero. Provide a nonzero pressure–sinkage coefficient.');
  return material;
}

/** Bekker stiffness and area in the existing `VehicleOptions.groundMaterial` soil layout. */
export function wheelSoil(width: number, length: number, material: SoilMaterial = {}, elliptical = true) {
  const data = materialOf(material);
  const b = positive(width, 'width');
  const l = positive(length, 'length');
  return {
    stiffness: data.cohesiveModulus / b + data.frictionalModulus,
    exponent: data.exponent,
    area: b * l * (elliptical ? Math.PI / 4 : 1),
  };
}

type Patch = readonly [number, number, number, number, number, number, number, number, number, number];

function packed(p: SoilPatch): Patch {
  return [
    p.x,
    p.z,
    p.forward?.[0] ?? 0,
    p.forward?.[1] ?? 1,
    p.length,
    p.width,
    p.load,
    p.displacement?.[0] ?? 0,
    p.displacement?.[1] ?? 0,
    p.elliptical ? 1 : 0,
  ];
}

/** Simulates persistent pressure–sinkage and mobilized soil shear on a live triangulated bed. */
export class Terramechanics implements Solver<TerramechanicsParams> {
  readonly id: string;
  readonly dustField: FieldDescriptor;
  readonly responseField: FieldDescriptor;
  private readonly input?: FieldDescriptor;
  private readonly legged: boolean;
  private terrain!: BedShape;
  private material!: Required<SoilMaterial>;
  private host!: SolverHost;
  private kernel!: NativeSoil;
  private change!: BedChange;
  private areas!: Region;
  private peaks!: Region;
  private rim!: Region;
  private nativePatch!: Region;
  private dust!: Region;
  private budgetRegion!: Region;
  private response!: Region;
  private fixed: Patch[] = [];
  private feet: LeggedSoilPatch[] = [];
  private inputRows = 0;
  private cell: Cell = CENTRE;
  private cellSize = 4096;
  private floor = -Infinity;

  private constructor(
    private readonly builds: Builds,
    options: TerramechanicsOptions,
  ) {
    this.id = options.id ?? 'terramechanics';
    this.input = options.input && { ...options.input };
    this.legged = options.legged ?? false;
    this.dustField = {
      name: `${this.id}:dust`,
      kind: 'uniformGrid',
      quantity: 'mineralDustFlux',
      unit: 'kg/(m^2 s)',
      centring: 'vertex',
    };
    this.responseField = {
      name: `${this.id}:response`,
      kind: 'surfaceSampleSet',
      quantity: 'soilContactResponse',
      unit: 'record',
      centring: 'particle',
    };
  }

  static async load(options: TerramechanicsOptions = {}): Promise<Terramechanics> {
    return new Terramechanics(await loadSoil(options.signal), options);
  }

  describe() {
    return {
      id: this.id,
      rate: 0 as const,
      stableRate: () => 0 as const,
      fields: [
        { field: BED_FIELD, access: 'read' as const },
        { field: BED_CHANGE_FIELD, access: 'accumulate' as const },
        { field: this.dustField, access: 'write' as const },
        { field: this.responseField, access: 'write' as const },
        ...(this.input ? [{ field: this.input, access: 'read' as const }] : []),
        ...(this.legged ? [{ field: LEGGED_CONTACT_FIELD, access: 'read' as const }] : []),
      ],
    };
  }

  init(host: SolverHost, parameters: TerramechanicsParams): void {
    this.host = host;
    const count = bedVertexCount(parameters.terrain);
    this.terrain = { ...parameters.terrain, centre: [...parameters.terrain.centre] };
    this.material = materialOf(parameters.material);
    this.fixed = (parameters.patches ?? []).map(packed);
    this.feet = (parameters.feet ?? []).map((foot) => ({ ...foot }));
    this.inputRows = parameters.inputRows ?? 0;
    this.floor = parameters.floor === undefined ? -Infinity : finite(parameters.floor, 'excavation floor');
    this.cellSize = positive(parameters.cellSize ?? 4096, 'cell size');
    if (!Number.isSafeInteger(this.inputRows) || this.inputRows < 0 || Boolean(this.input) !== this.inputRows > 0)
      throw new MargoError(
        'state',
        'The contact row count conflicts with the input field. Provide a positive row count for a configured input.',
      );
    if (this.legged !== this.feet.length > 0 || this.feet.some(({ row }) => !Number.isSafeInteger(row) || row < 0))
      throw new MargoError(
        'state',
        'The legged contact options disagree. Enable legged input and provide zero-based contact rows together.',
      );
    const responses = this.fixed.length + this.inputRows + this.feet.length;
    this.change = new BedChange(host, this.terrain, 'soil-bed-change');
    const allocate = (name: string, words: number) => host.allocate(name, words * 8, 'f64', SOIL_LAYOUT);
    this.areas = allocate('soil-areas', count);
    this.peaks = allocate('soil-peak-settlement', count);
    this.rim = allocate('soil-rim-scratch', count);
    this.nativePatch = allocate('soil-patch-scratch', 14);
    this.dust = allocate('soil-dust-flux', count);
    this.budgetRegion = allocate('soil-budget', 5);
    this.response = allocate('soil-response', responses * SOIL_RESPONSE_WORDS);
    this.kernel = bindSoil(host, this.builds);
    this.words(this.areas).set(this.change.area);
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  private shift(port: Port): readonly [number, number] {
    return [(port.cell[0] - this.cell[0]) * this.cellSize, (port.cell[2] - this.cell[2]) * this.cellSize];
  }

  private stamp(patch: Patch, row: number, bed: Region, dt: number): void {
    const [x, z, forwardX, forwardZ, length, width, load, shearX, shearZ, ellipse] = patch;
    if (finite(load, 'normal load', 0) === 0) return;
    if (![x, z, forwardX, forwardZ, shearX, shearZ, ellipse].every(Number.isFinite) || (ellipse !== 0 && ellipse !== 1))
      throw new MargoError(
        'state',
        'A soil contact row has invalid geometry. Use finite positions, directions and displacement with a 0 or 1 ellipse flag.',
      );
    const direction = hypot(forwardX, forwardZ);
    if (!direction) throw new MargoError('state', 'Soil contact forward is zero. Provide a nonzero XZ vector.');
    positive(length, 'contact length');
    positive(width, 'contact width');
    const material = this.material;
    const area = positive(width * length * (ellipse ? Math.PI / 4 : 1), 'contact area');
    const pressure = positive(load / area, 'contact pressure');
    const stiffness = positive(material.cohesiveModulus / width + material.frictionalModulus, 'effective stiffness');
    const depth = finite(pow(pressure / stiffness, 1 / material.exponent), 'settlement', 0);
    const slip = hypot(shearX, shearZ);
    const share = 1 - exp(-slip / material.shearLength);
    const shear = finite((material.cohesion + pressure * material.friction) * share, 'shear stress', 0);
    const dust = (1 - material.compaction) * material.dustFraction;
    const { columns, rows, width: dx, depth: dz, centre } = this.terrain;
    this.words(this.response).set([pressure, depth, shear, load], row * SOIL_RESPONSE_WORDS);
    this.words(this.nativePatch).set([
      x,
      z,
      forwardX / direction,
      forwardZ / direction,
      length / 2,
      width / 2,
      depth,
      material.compaction,
      dust,
      (dust * material.density) / dt,
      share,
      slip > 0 ? shearX / slip : 0,
      slip > 0 ? shearZ / slip : 0,
      ellipse,
    ]);
    this.kernel.stamp(
      this.nativePatch.byteOffset,
      this.areas.byteOffset,
      this.peaks.byteOffset,
      this.change.state.byteOffset,
      this.dust.byteOffset,
      this.rim.byteOffset,
      bed.byteOffset,
      this.floor,
      this.budgetRegion.byteOffset,
      columns + 1,
      rows + 1,
      dx / columns,
      dz / rows,
      centre[0] - dx / 2,
      centre[1] - dz / 2,
    );
  }

  private footsteps(port: Port, start: number, bed: Region, dt: number): void {
    const data = this.words(port.region);
    if (port.region.type !== 'f64' || port.region.layout !== SOIL_LAYOUT || data.length % LEGGED_WORDS)
      throw new MargoError('state', 'Unsupported foot contact field. Use the layout-1 LIFE-01 contact output.');
    const [x, z] = this.shift(port);
    for (const [i, foot] of this.feet.entries()) {
      const at = foot.row * LEGGED_WORDS;
      if (at >= data.length)
        throw new MargoError('state', 'Foot contact row does not exist. Use the current LIFE-01 foot index.');
      if (data[at + 9] !== 1 || data[at + 7]! <= 0) continue;
      const fx = -data[at + 6]!;
      const fz = -data[at + 8]!;
      const load = data[at + 7]!;
      const ellipse = foot.elliptical ? 1 : 0;
      const area = foot.width * foot.length * (ellipse ? Math.PI / 4 : 1);
      const tangential = hypot(fx, fz);
      const maximum = this.material.cohesion * area + load * this.material.friction;
      const fraction = maximum > 0 ? Math.min(tangential / maximum, 1 - Number.EPSILON) : 0;
      const displacement = tangential > 0 ? (-this.material.shearLength * ln(1 - fraction)) / tangential : 0;
      this.stamp(
        [
          data[at]! + x,
          data[at + 2]! + z,
          data[at + 3]!,
          data[at + 5]!,
          foot.length,
          foot.width,
          load,
          fx * displacement,
          fz * displacement,
          ellipse,
        ],
        start + i,
        bed,
        dt,
      );
    }
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    this.change.clear();
    this.words(this.dust).fill(0);
    this.words(this.response).fill(0);
    const bed = context.inputs.get(BED_FIELD.name);
    if (
      !bed ||
      bed.region.type !== 'f32' ||
      bed.region.layout !== BED_LAYOUT ||
      bed.region.byteLength !== this.change.area.length * 4 ||
      (bed.region.memory ?? this.host.memory) !== this.host.memory ||
      bed.cell.some((value, i) => value !== context.cell[i])
    )
      throw new MargoError(
        'state',
        'Soil and terrain geometry disagree. Add the live TerrainBed writer on the same grid and cell.',
      );
    for (const [i, patch] of this.fixed.entries()) this.stamp(patch, i, bed.region, dt);
    const port = this.input && context.inputs.get(this.input.name);
    if (port) {
      const data = this.words(port.region);
      if (
        port.region.type !== 'f64' ||
        port.region.layout !== SOIL_LAYOUT ||
        data.length !== this.inputRows * SOIL_PATCH_WORDS
      )
        throw new MargoError(
          'state',
          'The soil contact port differs from the configured capacity. Provide one layout-1 f64 record per row.',
        );
      const [x, z] = this.shift(port);
      for (let i = 0; i < this.inputRows; i++) {
        const at = i * SOIL_PATCH_WORDS;
        this.stamp(
          [
            data[at]! + x,
            data[at + 1]! + z,
            data[at + 2]!,
            data[at + 3]!,
            data[at + 4]!,
            data[at + 5]!,
            data[at + 6]!,
            data[at + 7]!,
            data[at + 8]!,
            data[at + 9]!,
          ],
          this.fixed.length + i,
          bed.region,
          dt,
        );
      }
    }
    const feet = this.legged && context.inputs.get(LEGGED_CONTACT_FIELD.name);
    if (feet) this.footsteps(feet, this.fixed.length + this.inputRows, bed.region, dt);
  }

  exportPorts(tick: number): readonly Port[] {
    return [
      this.change.port(tick, this.cell),
      { field: this.dustField.name, region: this.dust, tick, cell: this.cell },
      { field: this.responseField.name, region: this.response, tick, cell: this.cell },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.change.state, this.peaks, this.dust, this.budgetRegion, this.response];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Cumulative volume in m³, including compacted and airborne bulk equivalents. */
  get budget(): SoilBudget {
    const data = this.words(this.budgetRegion);
    return { removed: data[0]!, compacted: data[1]!, suspended: data[2]!, deposited: data[3]!, exported: data[4]! };
  }

  /** Response of the latest tick, fixed patches first, then external patches and LIFE-01 feet. */
  read(row: number) {
    const data = this.words(this.response);
    if (!Number.isSafeInteger(row) || row < 0 || row * SOIL_RESPONSE_WORDS >= data.length)
      throw new MargoError('state', 'The soil response row is out of bounds. Choose a configured patch or foot.');
    const at = row * SOIL_RESPONSE_WORDS;
    return { pressure: data[at]!, sinkage: data[at + 1]!, shearStress: data[at + 2]!, normalForce: data[at + 3]! };
  }
}
