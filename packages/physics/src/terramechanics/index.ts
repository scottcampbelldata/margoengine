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
/** Per patch: XZ, forward XZ, length, width, normal N, shear-displacement XZ and shape bits (1 ellipse, 2 rounded). */
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
  /** Rise per metre at dry repose in the resolved tier. Defaults to the supplied internal friction tangent. */
  readonly reposeSlope?: number;
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
  /** Give the resolved tier a parabolic contact section, e.g. a rounded tyre tread. Default false. */
  readonly rounded?: boolean;
}

/** Override the footprint size of a foot row in the live LIFE-01 contact field. */
export interface LeggedSoilPatch {
  readonly row: number;
  readonly length: number;
  readonly width: number;
  readonly elliptical?: boolean;
  readonly rounded?: boolean;
}

/** Mean pressure or force-normalized nodal stress and berm redistribution. */
export type SoilContactTier = 'mean' | 'resolved';

/** Projected contact geometry for the resolved tier. Zero depth leaves a gap between tread lugs. */
export interface SoilContactProfile {
  /** Vertex samples across the patch and along its forward direction, both including the two edges. */
  readonly columns: number;
  readonly rows: number;
  /** Relative depth [0, 1], stored by across column, then forward row. */
  readonly depth: ArrayLike<number>;
  /** Total projected contact area inside the patch, m². */
  readonly area: number;
  /** Total outline length of the contacting components, m. */
  readonly perimeter: number;
}

export interface TerramechanicsOptions {
  readonly id?: string;
  /** Read an external SOIL_LAYOUT F64 patch field, e.g. one returned by `soilPatchField`. */
  readonly input?: FieldDescriptor;
  /** Read the real LIFE-01 contact field. Provide `feet` at initialization. Default false. */
  readonly legged?: boolean;
  /** Resolved contacts expose a vertex pressure field and conservative berm relaxation. Default 'mean'. */
  readonly tier?: SoilContactTier;
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
  /** Optional shape for each response row in fixed, external, then foot order. Null uses its built-in shape. */
  readonly profiles?: readonly (SoilContactProfile | null)[];
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
  const friction = finite(input.friction ?? 0.6, 'internal friction', 0);
  const material = {
    cohesiveModulus: finite(input.cohesiveModulus ?? 1000, 'cohesive modulus'),
    frictionalModulus: finite(input.frictionalModulus ?? 400_000, 'frictional modulus'),
    exponent: positive(input.exponent ?? 1, 'pressure exponent'),
    cohesion: finite(input.cohesion ?? 500, 'cohesion', 0),
    friction,
    shearLength: positive(input.shearLength ?? 0.025, 'shear length'),
    compaction: finite(input.compaction ?? 0.2, 'compaction', 0, 1),
    dustFraction: finite(input.dustFraction ?? 0.0005, 'dust fraction', 0, 1),
    density: positive(input.density ?? 1600, 'bulk density'),
    reposeSlope: finite(input.reposeSlope ?? friction, 'repose slope', 0),
  };
  return material;
}

function bearingWidth(length: number, width: number, ellipse: boolean, resolved: boolean): number {
  if (!resolved) return width;
  if (!ellipse) return (length * width) / (length + width);
  // Ramanujan's ellipse circumference. For a circle, 2A/P is the measured test-plate radius.
  const ratio = (length - width) / (length + width);
  const h = ratio * ratio;
  const perimeter = (Math.PI * (length + width) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))) / 2;
  return (Math.PI * length * width) / (2 * perimeter);
}

/** Bekker stiffness and area in the existing `VehicleOptions.groundMaterial` soil layout. */
export function wheelSoil(
  width: number,
  length: number,
  material: SoilMaterial = {},
  elliptical = true,
  resolvedContact?: { readonly rounded?: boolean },
) {
  const data = materialOf(material);
  const b = positive(width, 'width');
  const l = positive(length, 'length');
  return {
    stiffness: positive(
      data.cohesiveModulus / bearingWidth(l, b, elliptical, Boolean(resolvedContact)) + data.frictionalModulus,
      'effective stiffness',
    ),
    exponent: data.exponent,
    area: positive(
      (b * l * (elliptical ? Math.PI / 4 : 1)) / (resolvedContact?.rounded ? data.exponent + 1 : 1),
      'contact area',
    ),
  };
}

type Patch = readonly [number, number, number, number, number, number, number, number, number, number];
type ProfileSlot = Pick<SoilContactProfile, 'columns' | 'rows' | 'area' | 'perimeter'> & { region: Region };

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
    (p.elliptical ? 1 : 0) + (p.rounded ? 2 : 0),
  ];
}

/** Simulates persistent pressure–sinkage and mobilized soil shear on a live triangulated bed. */
export class Terramechanics implements Solver<TerramechanicsParams> {
  readonly id: string;
  readonly dustField: FieldDescriptor;
  readonly responseField: FieldDescriptor;
  readonly pressureField?: FieldDescriptor;
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
  private pressure?: Region;
  private workRegion?: Region;
  private faces?: Region;
  private response!: Region;
  private fixed: Patch[] = [];
  private feet: LeggedSoilPatch[] = [];
  private profiles: (ProfileSlot | null)[] = [];
  private inputRows = 0;
  private cell: Cell = CENTRE;
  private cellSize = 4096;
  private floor = -Infinity;

  private constructor(
    private readonly builds: Builds,
    options: TerramechanicsOptions,
  ) {
    this.id = options.id ?? 'terramechanics';
    const tier = options.tier ?? 'mean';
    if (tier !== 'mean' && tier !== 'resolved')
      throw new MargoError('state', 'Unknown soil contact tier. Choose mean or resolved.');
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
    if (tier === 'resolved')
      this.pressureField = {
        name: `${this.id}:pressure`,
        kind: 'uniformGrid',
        quantity: 'normalPressure',
        unit: 'Pa',
        centring: 'vertex',
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
        ...(this.pressureField ? [{ field: this.pressureField, access: 'write' as const }] : []),
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
    const profiles = parameters.profiles ?? [];
    if (profiles.length && (!this.pressureField || profiles.length !== responses))
      throw new MargoError(
        'state',
        'Soil profiles conflict with the solver layout. Use the resolved tier and supply one entry per response row.',
      );
    this.change = new BedChange(host, this.terrain, 'soil-bed-change');
    const allocate = (name: string, words: number) => host.allocate(name, words * 8, 'f64', SOIL_LAYOUT);
    this.areas = allocate('soil-areas', count);
    this.peaks = allocate('soil-peak-settlement', count);
    this.rim = allocate('soil-rim-scratch', count);
    this.nativePatch = allocate('soil-patch-scratch', 21);
    this.dust = allocate('soil-dust-flux', count);
    this.budgetRegion = allocate('soil-budget', 5);
    this.response = allocate('soil-response', responses * SOIL_RESPONSE_WORDS);
    if (this.pressureField) {
      this.pressure = allocate('soil-pressure', count);
      this.workRegion = allocate('soil-work', 3);
      let level = Math.ceil(count / 16);
      let words = level;
      while (level > 1) {
        level = Math.ceil(level / 32);
        words += level;
      }
      this.faces = host.allocate('soil-repose-faces', words * 4, 'u32', SOIL_LAYOUT);
    }
    this.profiles = profiles.map((profile, row) => {
      if (!profile) return null;
      const { columns, rows, area, perimeter, depth } = profile;
      const words = columns * rows;
      if (![columns, rows, words].every(Number.isSafeInteger) || columns < 2 || rows < 2 || depth.length !== words)
        throw new MargoError(
          'state',
          'Invalid soil profile grid. Provide at least two vertices per axis with matching depth data.',
        );
      positive(area, 'profile area');
      positive(perimeter, 'profile perimeter');
      const region = allocate(`soil-profile-${row}`, words);
      const field = this.words(region);
      for (let i = 0; i < words; i++) field[i] = finite(depth[i]!, 'profile depth', 0, 1);
      if (!field.some((value) => value > 0))
        throw new MargoError(
          'state',
          'A soil profile has no contact. Provide a positive depth for part of the footprint.',
        );
      return { columns, rows, area, perimeter, region };
    });
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
    const [x, z, forwardX, forwardZ, length, width, load, shearX, shearZ, flags] = patch;
    if (finite(load, 'normal load', 0) === 0) return;
    if (
      ![x, z, forwardX, forwardZ, shearX, shearZ].every(Number.isFinite) ||
      !Number.isInteger(flags) ||
      flags < 0 ||
      flags > 3
    )
      throw new MargoError(
        'state',
        'A soil contact row has invalid geometry. Use finite coordinates and shape bits for rectangle, ellipse and rounded section.',
      );
    const direction = hypot(forwardX, forwardZ);
    if (!direction) throw new MargoError('state', 'Soil contact forward is zero. Provide a nonzero XZ vector.');
    positive(length, 'contact length');
    positive(width, 'contact width');
    const material = this.material;
    const resolved = Boolean(this.pressure);
    const ellipse = Boolean(flags & 1);
    const profile = this.profiles[row];
    if (profile && profile.area > length * width)
      throw new MargoError(
        'state',
        'The profile area exceeds the contact bounds. Use its projected area in square metres inside the footprint.',
      );
    const area = positive(profile?.area ?? width * length * (ellipse ? Math.PI / 4 : 1), 'contact area');
    const pressure = positive(load / area, 'contact pressure');
    const effectiveWidth = profile
      ? (2 * profile.area) / profile.perimeter
      : bearingWidth(length, width, ellipse, resolved);
    const stiffness = positive(
      material.cohesiveModulus / effectiveWidth + material.frictionalModulus,
      'effective stiffness at this footprint width',
    );
    const depth = finite(pow(pressure / stiffness, 1 / material.exponent), 'settlement', 0);
    const slip = hypot(shearX, shearZ);
    const share = 1 - exp(-slip / material.shearLength);
    const shear = finite((material.cohesion + pressure * material.friction) * share, 'shear stress', 0);
    const dust = (1 - material.compaction) * material.dustFraction;
    const { columns, rows, width: dx, depth: dz, centre } = this.terrain;
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
      flags,
      Number(resolved),
      load,
      stiffness,
      material.exponent,
      profile?.region.byteOffset ?? 0,
      profile?.columns ?? 0,
      profile?.rows ?? 0,
    ]);
    const peak = this.kernel.stamp(
      this.nativePatch.byteOffset,
      this.areas.byteOffset,
      this.peaks.byteOffset,
      this.change.state.byteOffset,
      this.dust.byteOffset,
      this.rim.byteOffset,
      this.pressure?.byteOffset ?? 0,
      bed.byteOffset,
      this.floor,
      this.budgetRegion.byteOffset,
      this.workRegion?.byteOffset ?? 0,
      this.faces?.byteOffset ?? 0,
      columns + 1,
      rows + 1,
      dx / columns,
      dz / rows,
      centre[0] - dx / 2,
      centre[1] - dz / 2,
    );
    this.words(this.response).set(
      [pressure, finite(peak, 'resolved soil settlement', 0), shear, load],
      row * SOIL_RESPONSE_WORDS,
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
      const area = this.profiles[start + i]?.area ?? foot.width * foot.length * (ellipse ? Math.PI / 4 : 1);
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
          ellipse + (foot.rounded ? 2 : 0),
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
    if (this.pressure && this.workRegion && this.faces) {
      this.words(this.pressure).fill(0);
      this.words(this.workRegion).fill(0);
      const faceWords = regionWords(this.host.memory, this.faces);
      faceWords[faceWords.length - 1] = 0;
    }
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
    if (this.pressure && this.workRegion && this.faces && this.words(this.workRegion)[0]! > 0) {
      const { columns, rows, width, depth } = this.terrain;
      const slope = this.material.reposeSlope;
      const moved = this.kernel.repose(
        this.areas.byteOffset,
        this.change.state.byteOffset,
        this.pressure.byteOffset,
        bed.region.byteOffset,
        this.faces.byteOffset,
        this.workRegion.byteOffset,
        columns + 1,
        rows + 1,
        (slope * width) / columns,
        (slope * depth) / rows,
      );
      this.words(this.workRegion)[2] = moved;
    }
  }

  exportPorts(tick: number): readonly Port[] {
    return [
      this.change.port(tick, this.cell),
      { field: this.dustField.name, region: this.dust, tick, cell: this.cell },
      { field: this.responseField.name, region: this.response, tick, cell: this.cell },
      ...(this.pressureField && this.pressure
        ? [{ field: this.pressureField.name, region: this.pressure, tick, cell: this.cell }]
        : []),
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [
      this.change.state,
      this.peaks,
      this.dust,
      this.budgetRegion,
      this.response,
      ...(this.pressure && this.workRegion ? [this.pressure, this.workRegion] : []),
    ];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Cumulative volume in m³, including compacted and airborne bulk equivalents. */
  get budget(): SoilBudget {
    const data = this.words(this.budgetRegion);
    return { removed: data[0]!, compacted: data[1]!, suspended: data[2]!, deposited: data[3]!, exported: data[4]! };
  }

  /** Deterministic work and moved loose volume for the last resolved-tier step. */
  get work():
    | { readonly rasterVisits: number; readonly reposeFaces: number; readonly relaxedVolume: number }
    | undefined {
    if (!this.workRegion) return;
    const work = this.words(this.workRegion);
    return { rasterVisits: work[0]!, reposeFaces: work[1]!, relaxedVolume: work[2]! };
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
