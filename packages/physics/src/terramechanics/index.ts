import { MargoError } from '@margoengine/math/errors';
import type { Bed } from '@margoengine/math/fields';
import { exp, hypot, ln, pow } from '@margoengine/math/pinned';
import {
  BED_CHANGE_FIELD,
  BED_FIELD,
  BED_LAYOUT,
  BedChange,
  type BedShape,
  bedFromPort,
  bedVertexCount,
  type TerrainBedParams,
} from '../earth/bed.js';
import { LEGGED_CONTACT_FIELD } from '../legged/index.js';
import { regionWords } from '../world/memory.js';
import type { Cell, FieldDescriptor, Port, Region, Solver, SolverHost, StepContext } from '../world/solver.js';
import { bindSoil, type Builds, loadSoil, type NativeSoil } from './kernel.js';

export {
  ResistiveSoil,
  type ResistiveSoilCoefficients,
  type ResistiveSoilOptions,
  type ResistiveSoilParams,
  type ResistiveSoilStrip,
} from './resistive.js';
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
/** Per rolling wheel: normal load N, drawbar N and signed resisting axle torque N·m. */
export const SOIL_WHEEL_REACTION_WORDS = 3;
const LEGGED_WORDS = 13;
const CENTRE = [0, 0, 0] as const;

/** Wong's unloading slope k₀ + Aᵤ zₘₐₓ for cyclic soil bearing. Measure both terms on prepared soil. */
export interface SoilUnloading {
  /** Unloading slope at zero depth k₀, Pa/m. */
  readonly stiffness: number;
  /** Increase in unloading slope per metre of peak sinkage Aᵤ, Pa/m². Default zero. */
  readonly hardening?: number;
}

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
  /** Separate transverse shear displacement, m, for forward rolling with a side-force port. Default coupled shear. */
  readonly lateralShearLength?: number;
  /** Share of displaced bulk volume compacted in place. Default 0.2. */
  readonly compaction?: number;
  /** Fraction of the uncompacted displacement that becomes airborne dry mineral material. Default 0.0005. */
  readonly dustFraction?: number;
  /** Dry bulk density converting displaced volume to mass, kg/m³. Default 1,600. */
  readonly density?: number;
  /** Rise per metre at dry repose in the resolved tier. Defaults to the supplied internal friction tangent. */
  readonly reposeSlope?: number;
  /** Recoverable deformation during repeated bearing loads. Omit for fully permanent indentation. */
  readonly unloading?: SoilUnloading;
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

/** Pressure fit for a dense layer below prepared topsoil. */
export interface SoilHardpan {
  /** Depth below the original bed, m. The footing can sense this layer before touching it. */
  readonly thickness: number;
  /** Width-dependent pressure coefficient, Pa m^(1−n). Default zero. */
  readonly cohesiveModulus?: number;
  /** Width-independent pressure coefficient, Pa/m^n. */
  readonly frictionalModulus: number;
  /** Pressure exponent after the contact senses the layer. Default 1. */
  readonly exponent?: number;
}

/** Cylindrical contact geometry for a driven rigid wheel. */
export interface SoilRollingWheel {
  /** Rim radius, m, excluding lugs. */
  readonly radius: number;
  /** Lug height, m. Default zero. */
  readonly lugHeight?: number;
  /** Measured reduction in settlement from lug support, m. Default zero. */
  readonly lugSupport?: number;
  /** Increase in bearing exponent per unit of powered slip. Default zero. */
  readonly slipExponent?: number;
  /** Increase in bearing exponent per unit of skid. Set a measured value, including zero, to enable skid. */
  readonly skidExponent?: number;
  /** Fraction of entry angle at the pressure peak with zero slip. Default 0.4. */
  readonly peakFraction?: number;
  /** Increase in pressure peak fraction per unit of powered slip. Default 0.3. */
  readonly peakSlip?: number;
  /** Exit angle divided by entry angle, in [-1, 0]. Default zero. */
  readonly exitFraction?: number;
  /** Count of evenly spaced lugs around the rim. Default zero for the steady contact envelope. */
  readonly lugCount?: number;
  /** Lug width in the direction of travel, m. Required for phase-resolved lugs. */
  readonly lugWidth?: number;
  /** Optional arbitrary moving tread triangles, rotated about the across axis. Use the wheel-phase field. */
  readonly treadMesh?: SoilTreadMesh;
  /** Place the loose soil in separate triangular berms across travel. The default uses a local ring. */
  readonly bermProfile?: 'ring' | 'cross-track';
  /** Effective fraction of the lug envelope carrying soil, in [0, 1]. Default zero. */
  readonly grouserFill?: number;
  /** Excavate soil from positive slip over actual spin travel. Default false. Requires wheelPhase and grouserFill. */
  readonly grouserDig?: boolean;
}

/** Indexed tread geometry centred on the axle. Coordinates are across, up and forward, in metres. */
export interface SoilTreadMesh {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  /** Profile vertices across travel. Default 17. */
  readonly columns?: number;
  /** Profile vertices along travel. Default 65. */
  readonly rows?: number;
}

/**
 * Options for the terramechanics solver: its ID, the optional external patch, wheel spin, camber, reaction and
 * side-force fields, legged contact (default false), the contact tier (default 'mean') and an `AbortSignal`.
 */
export interface TerramechanicsOptions {
  readonly id?: string;
  /** Read an external SOIL_LAYOUT F64 patch field, e.g. one returned by `soilPatchField`. */
  readonly input?: FieldDescriptor;
  /** Optional wheel spin samples in the same row order as input. Use soilWheelPhaseField. */
  readonly wheelPhase?: FieldDescriptor;
  /** Optional axle camber sines in external wheel order. Use soilWheelCamberField. */
  readonly wheelCamber?: FieldDescriptor;
  /** Optional resolved rolling forces and axle moments, in external load order. Use soilWheelReactionField. */
  readonly wheelReaction?: FieldDescriptor;
  /** Optional solved force along the wheel's right axis, N. Use soilWheelSideForceField. */
  readonly wheelSideForce?: FieldDescriptor;
  /** Read the real LIFE-01 contact field. Provide `feet` at initialization. Default false. */
  readonly legged?: boolean;
  /** Resolved contacts expose a vertex pressure field and conservative berm relaxation. Default 'mean'. */
  readonly tier?: SoilContactTier;
  readonly signal?: AbortSignal;
}

/**
 * What the terramechanics solver is made from: the terrain bed, soil material, optional hardpan, fixed, external
 * and foot contact patches, response profiles, excavation floor and the origin-cell length in metres (default
 * 4096).
 */
export interface TerramechanicsParams {
  readonly terrain: BedShape;
  readonly material?: SoilMaterial;
  /** Finite topsoil over a dense supporting layer. Omit for homogeneous bearing. */
  readonly hardpan?: SoilHardpan;
  /** Local topsoil thickness, m, sampled at each contact centre. Requires the hardpan fit. */
  readonly hardpanDepths?: NonNullable<TerrainBedParams['bedrock']>;
  /** Known fixed contact loads. Live sources are configured with `input` or `legged`. */
  readonly patches?: readonly SoilPatch[];
  /** Number of external patch rows. Omit when there is no `input`. */
  readonly inputRows?: number;
  /** Exact contact rows to reproduce as feet. Skip the torso rows. */
  readonly feet?: readonly LeggedSoilPatch[];
  /** Optional shape for each response row in fixed, external, then foot order. Null uses its built-in shape. */
  readonly profiles?: readonly (SoilContactProfile | null)[];
  /** Per external load row. Use null to keep its existing shape. Requires the resolved tier. */
  readonly rollingWheels?: readonly (SoilRollingWheel | null)[];
  /** Acceleration used by wheel sidewall earth pressure, m/s². Default 9.81. */
  readonly sidewallGravity?: number;
  /** Minimum elevation to excavate, m in the bed cell. Default no floor. Set the same uniform floor as TerrainBed. */
  readonly floor?: number;
  /** Per-vertex excavation floor. Share the same data as TerrainBed.bedrock. */
  readonly floorGrid?: NonNullable<TerrainBedParams['bedrock']>;
  /** Distance between floating-origin cells, m. Default 4,096. */
  readonly cellSize?: number;
}

/**
 * Soil volume accounting of the terramechanics solver: removed, compacted, suspended, deposited and exported
 * volume.
 */
export interface SoilBudget {
  readonly removed: number;
  readonly compacted: number;
  readonly suspended: number;
  readonly deposited: number;
  /** Uncontained loose volume exported when a footprint occupies the entire local bed. */
  readonly exported: number;
}

/**
 * Describes the F64 field that carries soil contact patches in the SOIL_LAYOUT. `name` defaults to
 * 'soilContactPatch'.
 */
export function soilPatchField(name = 'soilContactPatch'): FieldDescriptor {
  return { name, kind: 'surfaceSampleSet', quantity: 'soilContactPatch', unit: 'record', centring: 'particle' };
}

/** One f64 wheel-spin angle in radians per external contact row, using SOIL_LAYOUT. */
export function soilWheelPhaseField(name = 'soilWheelPhase'): FieldDescriptor {
  return { name, kind: 'surfaceSampleSet', quantity: 'wheelSpin', unit: 'rad', centring: 'particle' };
}

/** Vertical component of the unit wheel right axis, one value in [-1, 1] per external row. */
export function soilWheelCamberField(name = 'soilWheelCamber'): FieldDescriptor {
  return { name, kind: 'surfaceSampleSet', quantity: 'wheelCamberSine', unit: '1', centring: 'particle' };
}

/** Forces and resisting torque integrated over the resolved rolling contact arc. */
export function soilWheelReactionField(name = 'soilWheelReaction'): FieldDescriptor {
  return { name, kind: 'surfaceSampleSet', quantity: 'soilWheelReaction', unit: 'record', centring: 'particle' };
}

/** Signed force along the wheel's right axis, one N value per external load row. */
export function soilWheelSideForceField(name = 'soilWheelSideForce'): FieldDescriptor {
  return { name, kind: 'surfaceSampleSet', quantity: 'soilWheelSideForce', unit: 'N', centring: 'particle' };
}

function finite(value: number, label: string, lower = -Infinity, upper = Infinity): number {
  if (!Number.isFinite(value) || value < lower || value > upper)
    throw new MargoError('state', `Invalid soil ${label}. Provide a finite value in [${lower}, ${upper}].`);
  return value;
}

function positive(value: number, label: string): number {
  return finite(value, label, Number.MIN_VALUE);
}

function materialOf(input: SoilMaterial = {}): Required<Omit<SoilMaterial, 'unloading'>> {
  const friction = finite(input.friction ?? 0.6, 'internal friction', 0);
  const material = {
    cohesiveModulus: finite(input.cohesiveModulus ?? 1000, 'cohesive modulus'),
    frictionalModulus: finite(input.frictionalModulus ?? 400_000, 'frictional modulus'),
    exponent: positive(input.exponent ?? 1, 'pressure exponent'),
    cohesion: finite(input.cohesion ?? 500, 'cohesion', 0),
    friction,
    shearLength: positive(input.shearLength ?? 0.025, 'shear length'),
    lateralShearLength:
      input.lateralShearLength === undefined ? 0 : positive(input.lateralShearLength, 'lateral shear length'),
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
type RollingParameters = Required<Omit<SoilRollingWheel, 'treadMesh' | 'skidExponent'>> &
  Pick<SoilRollingWheel, 'skidExponent'>;
type MeshSlot = { geometry: Region; profile: Region; columns: number; rows: number };

function rollingWheel(wheel: SoilRollingWheel): RollingParameters {
  const radius = positive(wheel.radius, 'wheel radius');
  const lugHeight = finite(wheel.lugHeight ?? 0, 'wheel lug height', 0);
  const lugCount = wheel.lugCount ?? 0;
  if (!Number.isSafeInteger(lugCount) || lugCount < 0)
    throw new MargoError(
      'state',
      'A wheel lug count must be a nonnegative integer. Provide the number of evenly spaced lugs.',
    );
  const lugWidth = lugCount > 0 ? positive(wheel.lugWidth ?? 0, 'wheel lug width') : 0;
  if (lugCount > 0 && (lugHeight === 0 || lugCount * lugWidth >= 2 * Math.PI * radius))
    throw new MargoError(
      'state',
      'The discrete wheel lugs cannot fit around the rim. Use positive height and width below their spacing.',
    );
  if (wheel.treadMesh && lugCount > 0)
    throw new MargoError(
      'state',
      'Two sets of wheel treads are configured. Choose indexed triangles or evenly spaced lugs.',
    );
  const peakFraction = finite(
    wheel.peakFraction ?? 0.4,
    'wheel pressure peak fraction',
    Number.EPSILON,
    1 - Number.EPSILON,
  );
  const bermProfile = wheel.bermProfile ?? 'ring';
  if (bermProfile !== 'ring' && bermProfile !== 'cross-track')
    throw new MargoError('state', 'The wheel berm profile is invalid. Choose ring or cross-track.');
  const grouserFill = finite(wheel.grouserFill ?? 0, 'grouser fill fraction', 0, 1);
  const grouserDig = wheel.grouserDig ?? false;
  if (typeof grouserDig !== 'boolean' || (grouserDig && !(lugHeight > 0 && grouserFill > 0)))
    throw new MargoError('state', 'Invalid grouser digging options. Use a boolean and positive lug height and fill.');
  return {
    radius,
    lugHeight,
    lugSupport: finite(wheel.lugSupport ?? 0, 'wheel lug support', 0, lugHeight),
    slipExponent: finite(wheel.slipExponent ?? 0, 'wheel slip exponent increment', 0),
    skidExponent:
      wheel.skidExponent === undefined ? undefined : finite(wheel.skidExponent, 'wheel skid exponent increment', 0),
    peakFraction,
    peakSlip: finite(wheel.peakSlip ?? 0.3, 'wheel pressure peak slip increment', 0, 1 - Number.EPSILON - peakFraction),
    exitFraction: finite(wheel.exitFraction ?? 0, 'wheel exit fraction', -1, 0),
    lugCount,
    lugWidth,
    bermProfile,
    grouserFill,
    grouserDig,
  };
}

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
  private readonly phase?: FieldDescriptor;
  private readonly camber?: FieldDescriptor;
  private readonly reaction?: FieldDescriptor;
  private readonly sideForce?: FieldDescriptor;
  private readonly legged: boolean;
  private terrain!: BedShape;
  private material!: Required<Omit<SoilMaterial, 'unloading'>>;
  private hardpan?: Required<SoilHardpan>;
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
  private reactions?: Region;
  private sides?: Region;
  private trackRelief?: Region;
  private reposePending?: Region;
  private diggingPhase?: Region;
  private cycle?: { history: Region; active: Region };
  private sideWeight = 0;
  private fixed: Patch[] = [];
  private feet: LeggedSoilPatch[] = [];
  private profiles: (ProfileSlot | null)[] = [];
  private rolling: (RollingParameters | null)[] = [];
  private meshes: (MeshSlot | null)[] = [];
  private inputRows = 0;
  private cell: Cell = CENTRE;
  private cellSize = 4096;
  private floor = -Infinity;
  private floorGrid?: Region;
  private thicknessGrid?: Region;

  private constructor(
    private readonly builds: Builds,
    options: TerramechanicsOptions,
  ) {
    this.id = options.id ?? 'terramechanics';
    const tier = options.tier ?? 'mean';
    if (tier !== 'mean' && tier !== 'resolved')
      throw new MargoError('state', 'Unknown soil contact tier. Choose mean or resolved.');
    this.input = options.input && { ...options.input };
    this.phase = options.wheelPhase && { ...options.wheelPhase };
    this.camber = options.wheelCamber && { ...options.wheelCamber };
    this.reaction = options.wheelReaction && { ...options.wheelReaction };
    this.sideForce = options.wheelSideForce && { ...options.wheelSideForce };
    if (this.phase && !this.input)
      throw new MargoError('state', 'Wheel phase needs external wheel loads. Provide the matching soil patch field.');
    if (this.camber && !this.input)
      throw new MargoError('state', 'Wheel camber needs external wheel loads. Provide the matching soil patch field.');
    if ((this.reaction || this.sideForce) && (tier !== 'resolved' || !this.input))
      throw new MargoError(
        'state',
        'Wheel reactions need resolved external loads. Use the resolved tier and a soil patch field.',
      );
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
        ...(this.reaction ? [{ field: this.reaction, access: 'write' as const }] : []),
        ...(this.sideForce ? [{ field: this.sideForce, access: 'write' as const }] : []),
        ...(this.pressureField ? [{ field: this.pressureField, access: 'write' as const }] : []),
        ...(this.input ? [{ field: this.input, access: 'read' as const }] : []),
        ...(this.phase ? [{ field: this.phase, access: 'read' as const }] : []),
        ...(this.camber ? [{ field: this.camber, access: 'read' as const }] : []),
        ...(this.legged ? [{ field: LEGGED_CONTACT_FIELD, access: 'read' as const }] : []),
      ],
    };
  }

  init(host: SolverHost, parameters: TerramechanicsParams): void {
    this.host = host;
    const count = bedVertexCount(parameters.terrain);
    this.terrain = { ...parameters.terrain, centre: [...parameters.terrain.centre] };
    this.material = materialOf(parameters.material);
    const hardpan = parameters.hardpan;
    this.hardpan = hardpan && {
      thickness: positive(hardpan.thickness, 'topsoil thickness'),
      cohesiveModulus: finite(hardpan.cohesiveModulus ?? 0, 'hardpan cohesive modulus'),
      frictionalModulus: finite(hardpan.frictionalModulus, 'hardpan frictional modulus'),
      exponent: positive(hardpan.exponent ?? 1, 'hardpan exponent'),
    };
    this.fixed = (parameters.patches ?? []).map(packed);
    this.feet = (parameters.feet ?? []).map((foot) => ({ ...foot }));
    this.inputRows = parameters.inputRows ?? 0;
    this.floor = parameters.floor === undefined ? -Infinity : finite(parameters.floor, 'excavation floor');
    this.cellSize = positive(parameters.cellSize ?? 4096, 'cell size');
    if (this.sideForce)
      this.sideWeight = finite(
        this.material.density * (parameters.sidewallGravity ?? 9.81),
        'sidewall specific weight',
        0,
      );
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
    const rolling = parameters.rollingWheels ?? [];
    if (rolling.length && (!this.pressureField || rolling.length !== this.inputRows))
      throw new MargoError(
        'state',
        'Rolling wheels need resolved external loads. Supply one entry per external load row.',
      );
    if (rolling.some((wheel, row) => wheel && profiles[this.fixed.length + row]))
      throw new MargoError(
        'state',
        'A rolling load has two footprint geometries. Choose a cylindrical wheel or a sampled profile for that row.',
      );
    this.rolling = rolling.map((wheel) => wheel && rollingWheel(wheel));
    if (!this.phase && rolling.some((wheel) => wheel && (wheel.lugCount || wheel.treadMesh)))
      throw new MargoError('state', 'Moving wheel treads need a phase port. Provide a soil wheel phase reader.');
    const digging = this.rolling.some((wheel) => wheel?.grouserDig);
    if (digging && !this.phase)
      throw new MargoError('state', 'Grouser digging needs actual spin travel. Provide a soil wheel phase reader.');
    if (profiles.length && (!this.pressureField || profiles.length !== responses))
      throw new MargoError(
        'state',
        'Soil profiles conflict with the solver layout. Use the resolved tier and supply one entry per response row.',
      );
    this.change = new BedChange(host, this.terrain, 'soil-bed-change');
    const allocate = (name: string, words: number) => host.allocate(name, words * 8, 'f64', SOIL_LAYOUT);
    this.cycle = undefined;
    const unloading = parameters.material?.unloading;
    if (unloading) {
      const stiffness = finite(unloading.stiffness, 'initial unloading stiffness', 0);
      const hardening = finite(unloading.hardening ?? 0, 'unloading hardening', 0);
      if (stiffness === 0 && hardening === 0)
        throw new MargoError('state', 'The soil unloading slope is zero. Give a positive stiffness or hardening.');
      this.cycle = {
        history: allocate('soil-cycle-history', 2 + count * 3),
        active: host.allocate('soil-cycle-active', (count + 1) * 4, 'u32', SOIL_LAYOUT),
      };
      this.words(this.cycle.history).set([stiffness, hardening]);
    }
    if (parameters.hardpanDepths !== undefined && !hardpan)
      throw new MargoError('state', 'Local hardpan depths have no material. Provide the hardpan fit with them.');
    this.floorGrid =
      parameters.floorGrid === undefined
        ? undefined
        : this.samples(parameters.floorGrid, count, 'excavation floor', -Infinity);
    this.thicknessGrid =
      parameters.hardpanDepths === undefined
        ? undefined
        : this.samples(parameters.hardpanDepths, count, 'topsoil thickness', Number.MIN_VALUE);
    this.areas = allocate('soil-areas', count);
    this.peaks = allocate('soil-peak-settlement', count);
    this.rim = allocate('soil-rim-scratch', count);
    this.nativePatch = allocate('soil-patch-scratch', 58);
    this.dust = allocate('soil-dust-flux', count);
    this.budgetRegion = allocate('soil-budget', 5);
    this.response = allocate('soil-response', responses * SOIL_RESPONSE_WORDS);
    if (this.reaction) this.reactions = allocate('soil-wheel-reactions', this.inputRows * SOIL_WHEEL_REACTION_WORDS);
    if (this.sideForce) this.sides = allocate('soil-wheel-side-forces', this.inputRows);
    const crossTrack =
      this.material.reposeSlope > 0 && this.rolling.some((wheel) => wheel?.bermProfile === 'cross-track');
    if (crossTrack) this.trackRelief = allocate('soil-track-relief', count);
    if (digging) this.diggingPhase = allocate('soil-digging-phase', 2 * this.inputRows);
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
      if (crossTrack) this.reposePending = host.allocate('soil-repose-pending', words * 4, 'u32', SOIL_LAYOUT);
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
    this.meshes = rolling.map((wheel, row) => {
      if (!wheel?.treadMesh) return null;
      const { positions, indices, columns = 17, rows = 65 } = wheel.treadMesh;
      if (
        ![columns, rows, columns * rows, positions.length, indices.length * 3].every(Number.isSafeInteger) ||
        columns < 2 ||
        rows < 2 ||
        positions.length < 9 ||
        indices.length < 3 ||
        positions.length % 3 ||
        indices.length % 3
      )
        throw new MargoError(
          'state',
          'Invalid wheel mesh dimensions. Provide indexed triangles and at least two profile vertices per axis.',
        );
      const geometry = allocate(`soil-tread-geometry-${row}`, indices.length * 3);
      const profile = allocate(`soil-tread-profile-${row}`, columns * rows);
      const data = this.words(geometry);
      for (let i = 0; i < indices.length; i++) {
        const vertex = indices[i]!;
        if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= positions.length / 3)
          throw new MargoError(
            'state',
            'The tread triangle points outside the vertex array. Use zero-based vertex indices.',
          );
        for (let axis = 0; axis < 3; axis++) data[3 * i + axis] = finite(positions[3 * vertex + axis]!, 'tread vertex');
      }
      return { geometry, profile, columns, rows };
    });
    this.kernel = bindSoil(host, this.builds);
    this.words(this.areas).set(this.change.area);
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  private samples(
    source: NonNullable<TerrainBedParams['bedrock']>,
    count: number,
    label: string,
    minimum: number,
  ): Region {
    if (typeof source !== 'function' && source.length !== count)
      throw new MargoError('state', `The soil ${label} grid has the wrong size. Provide one value per bed vertex.`);
    const region = this.host.allocate(`soil-${label.replaceAll(' ', '-')}`, count * 8, 'f64', SOIL_LAYOUT);
    const field = this.words(region);
    const { columns, rows, width, depth, centre } = this.terrain;
    for (let c = 0; c <= columns; c++)
      for (let r = 0; r <= rows; r++) {
        const i = c * (rows + 1) + r;
        const value =
          typeof source === 'function'
            ? source(centre[0] - width / 2 + (width * c) / columns, centre[1] - depth / 2 + (depth * r) / rows)
            : source[i]!;
        field[i] = finite(value, label, minimum);
      }
    return region;
  }

  private thicknessAt(x: number, z: number, thickness: number): number {
    if (!this.thicknessGrid) return thickness;
    const { columns, rows, width, depth, centre } = this.terrain;
    const u = ((x - centre[0] + width / 2) * columns) / width;
    const v = ((z - centre[1] + depth / 2) * rows) / depth;
    if (u < 0 || u > columns || v < 0 || v > rows) return thickness;
    const c = Math.min(columns - 1, Math.floor(u));
    const r = Math.min(rows - 1, Math.floor(v));
    const a = u - c;
    const b = v - r;
    const f = this.words(this.thicknessGrid);
    const i = c * (rows + 1) + r;
    const cross = f[i + rows + 1]!;
    const along = f[i + 1]!;
    return a + b <= 1
      ? (1 - a - b) * f[i]! + a * cross + b * along
      : (a + b - 1) * f[i + rows + 2]! + (1 - b) * cross + (1 - a) * along;
  }

  private shift(port: Port): readonly [number, number] {
    return [(port.cell[0] - this.cell[0]) * this.cellSize, (port.cell[2] - this.cell[2]) * this.cellSize];
  }

  private stamp(
    patch: Patch,
    row: number,
    bed: Region,
    dt: number,
    phase = 0,
    camber = 0,
    spinTravel = 0,
    bedSurface?: Bed,
  ): void {
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
    const rolling = this.rolling[row - this.fixed.length];
    const mesh = this.meshes[row - this.fixed.length];
    const forward = [forwardX / direction, forwardZ / direction] as const;
    const camberSine = finite(camber, 'wheel camber sine', -1, 1);
    let crossGrade = 0;
    if (bedSurface && rolling && !mesh) {
      const cosine = Math.sqrt((1 - camberSine) * (1 + camberSine));
      if (!cosine)
        throw new MargoError('state', 'The cylindrical wheel has no projected width. Use a camber below 90 degrees.');
      const span = (width / 2) * cosine;
      const rightX = forward[1] * span;
      const rightZ = -forward[0] * span;
      const right = bedSurface.sample(x + rightX, z + rightZ).elevation;
      const left = bedSurface.sample(x - rightX, z - rightZ).elevation;
      crossGrade = finite(((right - left) / width - camberSine) / cosine, 'wheel cross grade');
    }
    const longitudinalSlip = -(shearX * forward[0] + shearZ * forward[1]) / length;
    const drivingSlip = rolling ? Math.min(1, Math.max(0, longitudinalSlip)) : 0;
    const sweptSoil = rolling?.grouserDig
      ? finite(
          rolling.radius * spinTravel * drivingSlip * width * rolling.lugHeight * rolling.grouserFill,
          'grouser swept soil volume',
          0,
        )
      : 0;
    const skid = rolling?.skidExponent === undefined ? 0 : Math.max(-1, Math.min(0, longitudinalSlip));
    const exponent = positive(
      material.exponent + (rolling?.slipExponent ?? 0) * drivingSlip - (rolling?.skidExponent ?? 0) * skid,
      'effective exponent',
    );
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
      : rolling
        ? width
        : bearingWidth(length, width, ellipse, resolved);
    const stiffness = positive(
      material.cohesiveModulus / effectiveWidth + material.frictionalModulus,
      'effective stiffness at this footprint width',
    );
    const hardpan = this.hardpan;
    const lowerStiffness = hardpan
      ? positive(hardpan.cohesiveModulus / effectiveWidth + hardpan.frictionalModulus, 'effective hardpan stiffness')
      : 0;
    // Salman et al., 2020, Eqs. 6–7. tan(π/4 + φ/2) equals sec φ + tan φ.
    const transition = hardpan
      ? Math.max(
          0,
          this.thicknessAt(x, z, hardpan.thickness) -
            (resolved ? effectiveWidth : bearingWidth(length, width, ellipse, true)) *
              (hypot(1, material.friction) + material.friction),
        )
      : 0;
    const transitionPressure = hardpan
      ? finite(stiffness * pow(transition, exponent), 'hardpan transition pressure', 0)
      : 0;
    const lowerAtTransition = hardpan
      ? finite(lowerStiffness * pow(transition, hardpan.exponent), 'hardpan pressure', 0)
      : 0;
    const depth = finite(
      hardpan && pressure > transitionPressure
        ? pow((pressure - transitionPressure + lowerAtTransition) / lowerStiffness, 1 / hardpan.exponent)
        : pow(pressure / stiffness, 1 / exponent),
      'settlement',
      0,
    );
    const slip = hypot(shearX, shearZ);
    const share = 1 - exp(-slip / material.shearLength);
    const dust = (1 - material.compaction) * material.dustFraction;
    const { columns, rows, width: dx, depth: dz, centre } = this.terrain;
    this.words(this.nativePatch).set([
      x,
      z,
      forward[0],
      forward[1],
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
      exponent,
      profile?.region.byteOffset ?? 0,
      profile?.columns ?? 0,
      profile?.rows ?? 0,
      lowerStiffness,
      hardpan?.exponent ?? 1,
      transition,
      transitionPressure,
      lowerAtTransition,
      rolling?.radius ?? 0,
      rolling?.lugHeight ?? 0,
      rolling?.lugSupport ?? 0,
      rolling?.peakFraction ?? 0,
      rolling?.peakSlip ?? 0,
      rolling?.exitFraction ?? 0,
      drivingSlip,
      material.cohesion,
      material.friction,
      material.shearLength,
      0,
      rolling?.lugCount ?? 0,
      rolling?.lugWidth ?? 0,
      finite(phase, 'wheel phase'),
      mesh?.geometry.byteOffset ?? 0,
      (mesh?.geometry.byteLength ?? 0) / 72,
      mesh?.profile.byteOffset ?? 0,
      mesh?.columns ?? 0,
      mesh?.rows ?? 0,
      rolling && this.reactions
        ? this.reactions.byteOffset + (row - this.fixed.length) * SOIL_WHEEL_REACTION_WORDS * 8
        : 0,
      skid,
      rolling?.skidExponent ?? 0,
      rolling && this.sides ? this.sides.byteOffset + (row - this.fixed.length) * 8 : 0,
      rolling && (this.sides || rolling.bermProfile === 'cross-track')
        ? finite((shearX * forward[1] - shearZ * forward[0]) / length, 'lateral wheel slip')
        : 0,
      this.sideWeight,
      camberSine,
      rolling?.bermProfile === 'cross-track' ? material.reposeSlope : 0,
      rolling?.grouserFill ?? 0,
      rolling?.grouserFill ? Math.max(-1, Math.min(1, longitudinalSlip)) : 0,
      sweptSoil,
      crossGrade,
      material.lateralShearLength,
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
      this.floorGrid?.byteOffset ?? 0,
      this.budgetRegion.byteOffset,
      this.workRegion?.byteOffset ?? 0,
      this.faces?.byteOffset ?? 0,
      columns + 1,
      rows + 1,
      dx / columns,
      dz / rows,
      centre[0] - dx / 2,
      centre[1] - dz / 2,
      this.trackRelief?.byteOffset ?? 0,
      this.cycle?.history.byteOffset ?? 0,
      this.cycle?.active.byteOffset ?? 0,
    );
    if (rolling && !Number.isFinite(peak))
      throw new MargoError(
        'state',
        'The rolling footprint cannot carry the prescribed load above its axle. Reduce the normal load or supply a measured firmer bearing fit.',
      );
    const settlement = finite(peak, 'resolved soil settlement', 0);
    const measuredPressure = rolling
      ? load / positive(this.words(this.nativePatch)[36]!, 'rolling contact area')
      : pressure;
    const shear = finite((material.cohesion + measuredPressure * material.friction) * share, 'shear stress', 0);
    this.words(this.response).set([measuredPressure, settlement, shear, load], row * SOIL_RESPONSE_WORDS);
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

  private readWheelPose(
    context: StepContext,
    field: FieldDescriptor | undefined,
    label: string,
    cell: Cell,
  ): Float64Array | undefined {
    if (!field) return undefined;
    const pose = context.inputs.get(field.name);
    if (
      !pose ||
      pose.region.type !== 'f64' ||
      pose.region.layout !== SOIL_LAYOUT ||
      pose.region.byteLength !== this.inputRows * 8 ||
      (pose.region.memory ?? this.host.memory) !== this.host.memory ||
      pose.cell.some((coordinate, axis) => coordinate !== cell[axis])
    )
      throw new MargoError(
        'state',
        `Wheel ${label} does not match the load rows. Provide one layout-1 value per contact in the same cell.`,
      );
    return this.words(pose.region);
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    this.change.clear();
    this.words(this.dust).fill(0);
    this.words(this.response).fill(0);
    if (this.reactions) this.words(this.reactions).fill(0);
    if (this.sides) this.words(this.sides).fill(0);
    if (this.pressure && this.workRegion && this.faces) {
      this.words(this.pressure).fill(0);
      this.words(this.workRegion).fill(0);
      const faceWords = regionWords(this.host.memory, this.faces);
      if (!this.reposePending) faceWords[faceWords.length - 1] = 0;
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
    if (this.cycle)
      this.kernel.unload_soil(
        this.cycle.history.byteOffset,
        this.cycle.active.byteOffset,
        this.change.state.byteOffset,
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
      const phases = this.readWheelPose(context, this.phase, 'phase', port.cell);
      const cambers = this.readWheelPose(context, this.camber, 'camber', port.cell);
      const bedSurface = cambers && bedFromPort(this.host.memory, bed, this.terrain);
      const digging = this.diggingPhase && this.words(this.diggingPhase);
      for (let i = 0; i < this.inputRows; i++) {
        const at = i * SOIL_PATCH_WORDS;
        let spinTravel = 0;
        if (digging && this.rolling[i]?.grouserDig) {
          const phase = finite(phases![i]!, 'wheel phase');
          const loaded = data[at + 6]! > 0;
          if (loaded && digging[2 * i + 1] === 1)
            spinTravel = finite(Math.abs(phase - digging[2 * i]!), 'wheel spin travel', 0);
          digging[2 * i] = phase;
          digging[2 * i + 1] = Number(loaded);
        }
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
          phases?.[i],
          cambers?.[i],
          spinTravel,
          bedSurface,
        );
      }
    } else if (this.diggingPhase) {
      this.words(this.diggingPhase).fill(0);
    }
    const feet = this.legged && context.inputs.get(LEGGED_CONTACT_FIELD.name);
    if (feet) this.footsteps(feet, this.fixed.length + this.inputRows, bed.region, dt);
    if (this.pressure && this.workRegion && this.faces && (this.reposePending || this.words(this.workRegion)[0]! > 0)) {
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
        this.trackRelief?.byteOffset ?? 0,
        this.reposePending?.byteOffset ?? 0,
        this.rim.byteOffset,
        this.floor,
        this.floorGrid?.byteOffset ?? 0,
      );
      this.words(this.workRegion)[2] = moved;
    }
  }

  exportPorts(tick: number): readonly Port[] {
    return [
      this.change.port(tick, this.cell),
      { field: this.dustField.name, region: this.dust, tick, cell: this.cell },
      { field: this.responseField.name, region: this.response, tick, cell: this.cell },
      ...(this.reaction && this.reactions
        ? [{ field: this.reaction.name, region: this.reactions, tick, cell: this.cell }]
        : []),
      ...(this.sideForce && this.sides
        ? [{ field: this.sideForce.name, region: this.sides, tick, cell: this.cell }]
        : []),
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
      ...(this.reactions ? [this.reactions] : []),
      ...(this.sides ? [this.sides] : []),
      ...(this.trackRelief ? [this.trackRelief] : []),
      ...(this.reposePending && this.faces ? [this.faces] : []),
      ...(this.diggingPhase ? [this.diggingPhase] : []),
      ...(this.cycle ? [this.cycle.history, this.cycle.active] : []),
      ...(this.floorGrid ? [this.floorGrid] : []),
      ...(this.thicknessGrid ? [this.thicknessGrid] : []),
      ...this.meshes.flatMap((mesh) => (mesh ? [mesh.geometry] : [])),
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
