import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, Precipitation, PrecipitationSample, Wind } from '@margoengine/math/fields';
import { hypot, sin } from '@margoengine/math/pinned';
import { WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS } from '../sea/wake.js';
import { regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  FieldUse,
  Port,
  Region,
  Solver,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import {
  completeDrips,
  FILM_DROP_WORDS,
  type PreparedOutlet,
  prepareOutlets,
  type ThinFilmDripOutlet,
} from './drips.js';
import { FILM_IMPACT_WORDS, FILM_SWEPT_IMPACT_LAYOUT, FILM_SWEPT_IMPACT_WORDS } from './drop-receiver.js';
import { bindThinFilmKernel, loadThinFilmBuilds, type ThinFilmBuilds, type ThinFilmKernel } from './kernel.js';
import { makeFilmSurface, type ThinFilmSurfaceGeometry } from './surface.js';

export { FILM_DROP_WORDS, type ThinFilmDripOutlet } from './drips.js';
export {
  FILM_FLIGHT_WORDS,
  ThinFilmDropFlight,
  type ThinFilmDropFlightConnections,
  type ThinFilmDropFlightOptions,
  type ThinFilmFlyingDrop,
} from './drop-flight.js';
export {
  FILM_IMPACT_WORDS,
  FILM_SWEPT_IMPACT_LAYOUT,
  FILM_SWEPT_IMPACT_WORDS,
  type ThinFilmDropReceiver,
} from './drop-receiver.js';
export type { ThinFilmSurfaceGeometry } from './surface.js';

/** Binary version of the optional film layout. */
export const THIN_FILM_LAYOUT = 1;
/** A wet cell, f64: u, v, initial substrate coordinate, film depth, emitted drip rate. */
export const THIN_FILM_WORDS = 5;
const ORIGIN: Cell = [0, 0, 0];
const F64 = 8;
const REGISTRY_BODY_LAYOUT = 2;
type Vec3 = readonly [number, number, number];
type Vec2 = readonly [number, number];
type Orientation = readonly [number, number, number, number];

/**
 * Options for loading the thin-film solver: its ID (default 'thin-film'), whether to mount it on a rigid body
 * (default false), hydrostatic load and impact recoil on that body (default false), and the optional rain,
 * impact and wake source fields.
 */
export interface ThinFilmLoadOptions {
  /** Solver ID and output field prefix. Defaults to 'thin-film'. */
  readonly id?: string;
  /** Mount the surface on a body read through the registry. Defaults to false. */
  readonly rigid?: boolean;
  /** Send the film's normal gravitational load to the mounted rigid body. Defaults to false. */
  readonly hydrostaticLoad?: boolean;
  /** Send absorbed droplets' normal impulse to the mounted rigid body. Defaults to false. */
  readonly impactRecoil?: boolean;
  /** Optional layout-1 rain rate in m/s. Accepts a scalar or one value per film cell. */
  readonly rainField?: FieldDescriptor;
  /** Optional layout-1 impact rows in the local UV plane. */
  readonly impacts?: FieldDescriptor;
  /** Emit horizontal SeaSource objects for the optional dispersive wake. Defaults to false. */
  readonly waveSources?: boolean;
  /** Publish geometrically placed detached droplets from circular drains. Defaults to false. */
  readonly drops?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * What a thin film is made from: grid size in cells, square cell size in metres, lower UV corner, tangents u and
 * v, the rigid body row carrying it and the origin-cell size (default 4096 m).
 */
export interface ThinFilmOptions {
  /** Grid width and height in cells. */
  readonly cells: Vec2;
  /** Square cell size in metres. */
  readonly spacing: number;
  /** Lower UV corner, local to bodyRow when mounted. Defaults to [0, 0, 0]. */
  readonly origin?: Vec3;
  /** First unit tangent. Defaults to +X. */
  readonly u?: Vec3;
  /** Second unit tangent, orthogonal to u. Defaults to -Z, so u × v points up. */
  readonly v?: Vec3;
  /** Rigid body row carrying the glass. Requires load({ rigid: true }). */
  readonly bodyRow?: number;
  /** Origin-cell size in the world. Defaults to 4096 m. */
  readonly originCellSize?: number;
  /** Initial depth in metres, scalar or one per row-major cell. Defaults to dry. */
  readonly depth?: number | ArrayLike<number>;
  /** Bed heights in metres from the plane along its normal. Defaults to a flat backing. */
  readonly substrate?: ArrayLike<number>;
  /** Steady liquid rain depth in m/s measured on the surface. Defaults to zero. */
  readonly rainRate?: number;
  /** Shared precipitation in physical units, sampled with the surface position and relative velocity. */
  readonly precipitation?: Precipitation;
  /** Shared wind, sampled at the patch's centre. Defaults to calm. */
  readonly wind?: Wind;
  /** Aerodynamic skin-friction coefficient. Defaults to 0.003. */
  readonly airFriction?: number;
  /** Additional surface shear in local UV, Pa. Defaults to zero. */
  readonly shear?: Vec2;
  /** Water density. Defaults to 998 kg/m³. */
  readonly density?: number;
  /** Dynamic viscosity. Defaults to 0.001002 Pa s. */
  readonly viscosity?: number;
  /** Liquid-air surface tension. Defaults to 0.0728 N/m. */
  readonly surfaceTension?: number;
  /** Let normal gravity destabilize a film on the underside of its surface with full graph curvature. Defaults to false. */
  readonly suspended?: boolean;
  /** Navier slip length. Defaults to zero metres. */
  readonly slip?: number;
  /** Static contact-line retention per unit width, N/m. Defaults to zero. */
  readonly pinning?: number;
  /** Enable precursor-film wetting for a shallow contact angle. Defaults to disabled. */
  readonly wetting?: {
    /** Equilibrium contact angle in radians, from zero to less than π/2. */
    readonly contactAngle: number;
    /** Resolved wetting-layer thickness in metres. Include this water in the initial depth. */
    readonly precursorDepth: number;
  };
  /** Optional row-major backing angles. Missing entries use wetting.contactAngle. */
  readonly wettingAngleMap?: ArrayLike<number | undefined>;
  /** Contact angles in radians, [receding, advancing]. Requires wetting and replaces scalar pinning. */
  readonly contactAngleHysteresis?: readonly [receding: number, advancing: number];
  /** Steady evaporative depth loss. Defaults to zero m/s. */
  readonly evaporation?: number;
  /** Open boundaries at u low, u high, v low or v high. Defaults to all closed. */
  readonly drains?: readonly [boolean, boolean, boolean, boolean];
  /** Optional wetted circular rims. Load with drops: true and open the corresponding drains. */
  readonly outlets?: readonly ThinFilmDripOutlet[];
}

/** Cumulative liquid budget, in m³, apart from the count of the last step's internal substeps. */
export interface ThinFilmBudget {
  readonly initial: number;
  readonly rain: number;
  readonly impacts: number;
  readonly evaporated: number;
  readonly dripped: number;
  readonly stored: number;
  readonly substeps: number;
}

/** One linked film cell in metres from the lower corner. */
export interface ThinFilmCell {
  readonly u: number;
  readonly v: number;
  readonly substrate: number;
  readonly depth: number;
  readonly dripRate: number;
}

interface FilmState {
  readonly kernel: ThinFilmKernel;
  readonly memory: WebAssembly.Memory;
  readonly gravity: Vec3;
  readonly nx: number;
  readonly ny: number;
  readonly count: number;
  readonly spacing: number;
  readonly area: number;
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly bodyRow?: number;
  readonly cellSize: number;
  readonly rain: number;
  readonly airFriction: number;
  readonly shear: Vec2;
  readonly wind?: Wind;
  readonly precipitation?: Precipitation;
  readonly drains: readonly boolean[];
  readonly suspended: boolean;
  readonly constants: Region;
  readonly wetting?: Region;
  readonly wettingMap?: Region;
  readonly contactAngles?: Region;
  readonly bottom: Region;
  readonly depth: Region;
  readonly candidate: Region;
  readonly rainRates: Region;
  readonly forcing: Region;
  readonly workspace: Region;
  readonly drips: Region;
  readonly nextDrips: Region;
  readonly budget: Region;
  readonly nextBudget: Region;
  readonly cellRecords: Region;
  readonly motion: Region;
  readonly waves?: Region;
  readonly nextWaves?: Region;
  readonly forces?: Region;
  readonly outlets?: {
    readonly entries: readonly PreparedOutlet[];
    readonly held: Region;
    readonly events: Region;
  };
  readonly regions: readonly Region[];
}

interface Frame {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly n: Vec3;
  readonly center: Vec3;
  readonly velocity: Vec3;
  readonly angular: Vec3;
}

interface ImpactRecoil {
  readonly force: Vec3;
  readonly torque: Vec3;
}

function number(label: string, value: number, min = -Infinity): number {
  if (!(Number.isFinite(value) && value >= min))
    throw new RangeError(`Invalid thin-film ${label}. Use a finite value at least ${min}.`);
  return value;
}

function positive(label: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0))
    throw new RangeError(`Invalid thin-film ${label}. Use a positive finite value.`);
  return value;
}

function wettingConstants(
  wetting: ThinFilmOptions['wetting'],
  angleMap: ThinFilmOptions['wettingAngleMap'],
  hysteresis: ThinFilmOptions['contactAngleHysteresis'],
  tension: number,
  count: number,
): { readonly uniform: Vec2; readonly cells?: Float64Array; readonly contact?: Vec2 } | undefined {
  if (wetting === undefined) {
    if (angleMap !== undefined || hysteresis !== undefined)
      throw Object.assign(
        new RangeError('Thin-film wetting modifiers need a precursor. Set wetting with the map or hysteresis.'),
        { code: 'PHYSICS_INPUT_RANGE' },
      );
    return undefined;
  }
  if (!wetting || typeof wetting !== 'object')
    throw Object.assign(
      new TypeError('Invalid thin-film wetting options. Pass an object with contactAngle and precursorDepth.'),
      { code: 'PHYSICS_INPUT_TYPE' },
    );
  const { contactAngle, precursorDepth } = wetting;
  if (!(Number.isFinite(precursorDepth) && precursorDepth > 0))
    throw Object.assign(new RangeError('Invalid thin-film wetting depth. Use a positive resolved precursor depth.'), {
      code: 'PHYSICS_INPUT_RANGE',
    });
  const stiffness = (angle: number) => {
    if (!(Number.isFinite(angle) && angle >= 0 && angle < Math.PI / 2))
      throw Object.assign(
        new RangeError('Invalid thin-film wetting angle. Use a finite contact angle from zero to less than π/2.'),
        { code: 'PHYSICS_INPUT_RANGE' },
      );
    const slope = (2 * sin(angle * 0.5)) / precursorDepth;
    const value = tension * slope * slope;
    if (!Number.isFinite(value))
      throw Object.assign(
        new RangeError('Thin-film wetting stiffness overflowed. Increase the resolved precursor depth.'),
        { code: 'PHYSICS_INPUT_RANGE' },
      );
    return value;
  };
  const fallback = stiffness(contactAngle);
  let contact: Vec2 | undefined;
  if (hysteresis !== undefined) {
    if (hysteresis?.length !== 2 || !(hysteresis[0] <= contactAngle && contactAngle <= hysteresis[1]))
      throw Object.assign(
        new RangeError('Invalid thin-film hysteresis. Use receding and advancing angles that bracket equilibrium.'),
        { code: 'PHYSICS_INPUT_RANGE' },
      );
    const receding = stiffness(hysteresis[0]);
    const advancing = stiffness(hysteresis[1]);
    if (receding !== advancing) contact = [receding, advancing];
  }
  if (angleMap === undefined) return { uniform: [precursorDepth, fallback], contact };
  if (angleMap?.length !== count)
    throw Object.assign(
      new RangeError('Invalid thin-film wetting map. Pass one angle in radians per row-major film cell.'),
      { code: 'PHYSICS_INPUT_RANGE' },
    );
  const cells = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const angle = angleMap[i];
    cells[i] = angle === undefined ? fallback : stiffness(angle);
    if (hysteresis && angle !== undefined && (angle < hysteresis[0] || angle > hysteresis[1]))
      throw Object.assign(
        new RangeError('A thin-film wetting angle lies outside its hysteresis interval. Bracket every backing angle.'),
        { code: 'PHYSICS_INPUT_RANGE' },
      );
  }
  return { uniform: [precursorDepth, 0], cells, contact };
}

function size(label: string, value: number, min = 1): number {
  if (!(Number.isSafeInteger(value) && value >= min))
    throw new RangeError(`Invalid thin-film ${label}. Use a whole number at least ${min}.`);
  return value;
}

function vector(label: string, value: Vec3): Vec3 {
  if (value?.length !== 3 || !value.every(Number.isFinite))
    throw new RangeError(`Invalid thin-film ${label}. Use three finite coordinates.`);
  return [value[0], value[1], value[2]];
}

function plus(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function minus(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, amount: number): Vec3 {
  return [a[0] * amount, a[1] * amount, a[2] * amount];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(label: string, a: Vec3): Vec3 {
  const values = vector(label, a);
  return scale(values, 1 / positive(label, hypot(...values)));
}

function rotate(q: Orientation, v: Vec3): Vec3 {
  const axis: Vec3 = [q[0], q[1], q[2]];
  const t = scale(cross(axis, v), 2);
  return plus(v, plus(scale(t, q[3]), cross(axis, t)));
}

function position(frame: Frame, u: number, v: number): Vec3 {
  return plus(plus(frame.origin, scale(frame.u, u)), scale(frame.v, v));
}

function shift(p: Vec3, from: Cell, to: Cell, cellSize: number): Vec3 {
  return plus(p, [(from[0] - to[0]) * cellSize, (from[1] - to[1]) * cellSize, (from[2] - to[2]) * cellSize]);
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return Object.freeze({ name, kind: 'uniformGrid', quantity, unit, centring: 'cell' });
}

function blankSpecies() {
  return { rate: 0, intercept: 0, slope: 0, fallSpeed: 0, impactRate: 0, energyFlux: 0, waterContent: 0 };
}

function words(state: FilmState, region: Region): Float64Array {
  return regionWords(state.memory, region) as Float64Array;
}

function gridInput(
  s: FilmState,
  context: StepContext,
  descriptor: FieldDescriptor,
  stride: number,
  allowScalar: boolean,
  layout = THIN_FILM_LAYOUT,
) {
  const port = context.inputs.get(descriptor.name);
  if (!port) return undefined;
  const r = port.region;
  if (r.layout !== layout || (r.type !== 'f64' && (!allowScalar || r.type !== 'f32')))
    throw new RangeError(`Invalid thin-film ${descriptor.name} layout. Use a layout-${layout} numeric field.`);
  const values = regionWords(s.memory, r);
  if (allowScalar ? values.length !== 1 && values.length !== s.count : values.length % stride !== 0)
    throw new RangeError(`Invalid thin-film ${descriptor.name} rows. Use the documented layout and patch dimensions.`);
  return values;
}

/** Conservative thin liquid films on a substrate, including a panel mounted on a moving rigid body. */
export class ThinFilmSolver implements Solver<ThinFilmOptions> {
  /** Layout-1 UV, substrate, depth and drip rate. */
  readonly filmField: FieldDescriptor;
  /** Layout-1 cell discharge to drains in m³/s. */
  readonly dripsField: FieldDescriptor;
  /** Layout-1 SeaSource records for an optional wake consumer. */
  readonly waveField: FieldDescriptor;
  /** Layout-1 timed drop records, one per configured circular outlet. */
  readonly dropsField: FieldDescriptor;
  private readonly fields: readonly FieldUse[];
  private readonly loadsMount: boolean;
  private readonly windSample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly rainSample: PrecipitationSample = {
    rate: 0,
    rain: blankSpecies(),
    snow: blankSpecies(),
    graupel: blankSpecies(),
    hail: blankSpecies(),
    velocity: [0, 0, 0],
  };
  private state?: FilmState;

  private constructor(
    private readonly builds: ThinFilmBuilds,
    private readonly options: ThinFilmLoadOptions,
  ) {
    const id = options.id ?? 'thin-film';
    this.filmField = field(`${id}.film`, 'thinFilm', 'm, m³/s');
    this.dripsField = field(`${id}.drips`, 'discharge', 'm³/s');
    this.waveField = Object.freeze({
      name: `${id}.waveSources`,
      kind: 'surfaceSampleSet',
      quantity: 'seaSource',
      unit: 'SI',
      centring: 'particle',
    });
    this.dropsField = Object.freeze({
      name: `${id}.drops`,
      kind: 'surfaceSampleSet',
      quantity: 'detachedWaterDrop',
      unit: 'SI',
      centring: 'particle',
    });
    if (options.rainField && options.rainField.name === options.impacts?.name)
      throw new RangeError('Repeated thin-film inputs. Use different names for rain and impacts.');
    if (options.impactRecoil && (!options.rigid || !options.impacts || options.waveSources))
      throw Object.assign(
        new RangeError(
          'Thin-film impact recoil needs one mounted impulse receiver. Load with rigid and impacts, and omit waveSources.',
        ),
        { code: 'PHYSICS_INPUT_RANGE' },
      );
    this.loadsMount = Boolean(options.hydrostaticLoad || options.impactRecoil);
    this.fields = [
      { field: this.filmField, access: 'write' },
      { field: this.dripsField, access: 'write' },
      ...(options.waveSources ? [{ field: this.waveField, access: 'write' as const }] : []),
      ...(options.drops ? [{ field: this.dropsField, access: 'write' as const }] : []),
      ...(options.rigid ? [{ field: BODIES_FIELD, access: 'read' as const }] : []),
      ...(this.loadsMount ? [{ field: BODY_FORCES_FIELD, access: 'accumulate' as const }] : []),
      ...(options.rainField ? [{ field: options.rainField, access: 'read' as const }] : []),
      ...(options.impacts ? [{ field: options.impacts, access: 'read' as const }] : []),
    ];
  }

  /** Load only this optional entry's SIMD module. */
  static async load({ signal, ...options }: ThinFilmLoadOptions = {}): Promise<ThinFilmSolver> {
    return new ThinFilmSolver(await loadThinFilmBuilds(signal), options);
  }

  describe() {
    return { id: this.options.id ?? 'thin-film', fields: this.fields, rate: 0 as const, stableRate: () => 0 as const };
  }

  init(host: SolverHost, opts: ThinFilmOptions): void {
    if (this.state) throw new MargoError('state', 'ThinFilmSolver already belongs to a world. Load another solver.');
    const nx = size('column count', opts.cells[0]);
    const ny = size('row count', opts.cells[1]);
    const count = size('total cells', nx * ny);
    const spacing = positive('cell spacing', opts.spacing);
    const area = positive('cell area', spacing * spacing);
    const cellSize = positive('origin cell size', opts.originCellSize ?? 4096);
    const origin = vector('surface origin', opts.origin ?? ORIGIN);
    const u = unit('u tangent', opts.u ?? [1, 0, 0]);
    const rawV = unit('v tangent', opts.v ?? [0, 0, -1]);
    const v = unit('orthogonal v tangent', minus(rawV, scale(u, dot(u, rawV))));
    const bodyRow = opts.bodyRow === undefined ? undefined : size('body row', opts.bodyRow, 0);
    if (this.loadsMount && bodyRow === undefined)
      throw new MargoError('state', 'Thin-film body loads need a mount. Load with rigid: true and pass a body row.');
    if (
      (this.options.rigid !== undefined && this.options.rigid !== (bodyRow !== undefined)) ||
      (bodyRow !== undefined && !this.options.rigid)
    )
      throw new RangeError('Thin-film mounting needs a rigid body row. Load with rigid true and pass bodyRow.');
    if (opts.precipitation && (opts.rainRate !== undefined || this.options.rainField))
      throw new RangeError('Repeated thin-film rain sources. Use precipitation, a scalar rate or a registry field.');
    if (opts.rainRate !== undefined && this.options.rainField)
      throw new RangeError('Repeated thin-film rain sources. Use a scalar rate or the registry field.');
    const rain = number('rain rate', opts.rainRate ?? 0, 0);
    const density = positive('density', opts.density ?? 998);
    const airFriction = number('air friction', opts.airFriction ?? 0.003, 0);
    const shear: Vec2 = [number('u shear', opts.shear?.[0] ?? 0), number('v shear', opts.shear?.[1] ?? 0)];
    const drains = [...(opts.drains ?? [false, false, false, false])];
    if (drains.length !== 4 || drains.some((edge) => typeof edge !== 'boolean'))
      throw new RangeError('Invalid thin-film drains. Pass four booleans in u-low, u-high, v-low, v-high order.');
    const surfaceTension = number('surface tension', opts.surfaceTension ?? 0.0728, 0);
    const suspended = opts.suspended ?? false;
    if (suspended && surfaceTension === 0)
      throw Object.assign(
        new RangeError('Suspended thin films need capillary pressure. Use positive surface tension.'),
        { code: 'PHYSICS_INPUT_RANGE' },
      );
    if (Boolean(this.options.drops) !== Boolean(opts.outlets?.length))
      throw Object.assign(new RangeError('Thin-film outlets need drops: true at load and at least one open rim.'), {
        code: 'PHYSICS_INPUT_RANGE',
      });
    const entries = opts.outlets?.length
      ? prepareOutlets(opts.outlets, {
          nx,
          ny,
          spacing,
          drains,
          density,
          surfaceTension,
          gravity: hypot(...host.gravity),
        })
      : undefined;
    if (opts.contactAngleHysteresis !== undefined && opts.pinning)
      throw Object.assign(
        new RangeError('Two thin-film retention laws were selected. Remove pinning when using contact angles.'),
        { code: 'PHYSICS_INPUT_RANGE' },
      );
    const wettingValues = wettingConstants(
      opts.wetting,
      opts.wettingAngleMap,
      opts.contactAngleHysteresis,
      surfaceTension,
      count,
    );
    const constantsValues = [
      positive('inverse spacing', 1 / spacing),
      density,
      positive('viscosity', opts.viscosity ?? 0.001002),
      surfaceTension,
      number('slip length', opts.slip ?? 0, 0),
      number('contact-line retention', opts.pinning ?? 0, 0),
      number('evaporation', opts.evaporation ?? 0, 0),
    ];
    const initialDepth = opts.depth;
    if (
      (typeof initialDepth !== 'number' && initialDepth !== undefined && initialDepth.length !== count) ||
      (opts.substrate && opts.substrate.length !== count)
    )
      throw new RangeError('Invalid thin-film grid values. Use one element per grid cell.');
    const allocate = (name: string, length: number, layout = THIN_FILM_LAYOUT) =>
      host.allocate(name, size('allocation bytes', F64 * length), 'f64', layout);
    const constants = allocate('properties', constantsValues.length);
    const bottom = allocate('base', count);
    const depth = allocate('depth', count);
    const candidate = allocate('working-depth', count);
    const rainRates = allocate('rain-rates', count);
    const forcing = allocate('surface-forcing', 9);
    const workspace = allocate('face-solver', ((wettingValues?.contact ? 32 : 25) + (suspended ? 2 : 0)) * count);
    const drips = allocate('drips', count);
    const nextDrips = allocate('working-drips', count);
    const budget = allocate('budget', 7);
    const nextBudget = allocate('working-budget', 5);
    const cellRecords = allocate('film-cells', THIN_FILM_WORDS * count);
    const motion = allocate('previous-motion', 5);
    const waves = this.options.waveSources
      ? allocate('impact-waves', WAKE_SOURCE_WORDS * count, WAKE_SOURCE_LAYOUT)
      : undefined;
    const nextWaves = waves && allocate('working-impact-waves', WAKE_SOURCE_WORDS * count, WAKE_SOURCE_LAYOUT);
    const wetting = wettingValues && allocate('wetting', wettingValues.uniform.length);
    const wettingMap = wettingValues?.cells && allocate('wetting-map', count);
    const contactAngles = wettingValues?.contact && allocate('contact-angles', 2);
    const forces =
      this.loadsMount && bodyRow !== undefined
        ? allocate('body-forces', FORCE_WORDS * bodyRowsOf(host, 'Thin-film body loads', [bodyRow]))
        : undefined;
    const outlets = entries && {
      entries,
      held: allocate('drip-outlet-water', 3 + entries.length),
      events: allocate('detached-drops', FILM_DROP_WORDS * entries.length),
    };
    const kernel = bindThinFilmKernel(host, this.builds);
    const s: FilmState = {
      kernel,
      memory: host.memory,
      gravity: host.gravity,
      nx,
      ny,
      count,
      spacing,
      area,
      origin,
      u,
      v,
      bodyRow,
      cellSize,
      rain,
      airFriction,
      shear,
      wind: opts.wind,
      precipitation: opts.precipitation,
      drains,
      suspended,
      constants,
      wetting,
      wettingMap,
      contactAngles,
      bottom,
      depth,
      candidate,
      rainRates,
      forcing,
      workspace,
      drips,
      nextDrips,
      budget,
      nextBudget,
      cellRecords,
      motion,
      waves,
      nextWaves,
      forces,
      outlets,
      regions: [
        constants,
        bottom,
        depth,
        drips,
        budget,
        cellRecords,
        motion,
        ...(waves ? [waves] : []),
        ...(wetting ? [wetting] : []),
        ...(wettingMap ? [wettingMap] : []),
        ...(contactAngles ? [contactAngles] : []),
        ...(outlets ? [outlets.held, outlets.events] : []),
        ...(forces ? [forces] : []),
      ],
    };
    words(s, constants).set(constantsValues);
    if (wetting && wettingValues) words(s, wetting).set(wettingValues.uniform);
    if (wettingMap && wettingValues?.cells) words(s, wettingMap).set(wettingValues.cells);
    if (contactAngles && wettingValues?.contact) words(s, contactAngles).set(wettingValues.contact);
    words(s, motion)[4] = -1;
    const depths = words(s, depth);
    const bases = words(s, bottom);
    let initial = 0;
    for (let i = 0; i < count; i++) {
      const value = typeof initialDepth === 'number' ? initialDepth : (initialDepth?.[i] ?? 0);
      const h = number('initial depth', value, 0);
      depths[i] = h;
      bases[i] = number('substrate height', opts.substrate?.[i] ?? 0);
      initial += h * area;
    }
    words(s, budget).set([initial, 0, 0, 0, 0, initial, 0]);
    this.writeRecords(s);
    this.state = s;
  }

  private live(): FilmState {
    if (!this.state) throw new MargoError('state', 'ThinFilmSolver is not initialized. Add it to a PhysicsWorld.');
    return this.state;
  }

  private frame(s: FilmState, context: StepContext): Frame {
    const rigid = s.bodyRow === undefined ? undefined : context.inputs.get(BODIES_FIELD.name);
    let { origin, u, v } = s;
    let velocity: Vec3 = ORIGIN;
    let angular: Vec3 = ORIGIN;
    let center: Vec3 = origin;
    if (rigid) {
      const region = rigid.region;
      const at = s.bodyRow! * BODY_WORDS;
      if (region.type !== 'f32' || region.layout !== REGISTRY_BODY_LAYOUT || region.byteLength < (at + BODY_WORDS) * 4)
        throw new RangeError('Invalid thin-film body port. Use the layout-2 rigid body and a valid row.');
      const a = regionWords(s.memory, region);
      const q: Orientation = [a[at + 3]!, a[at + 4]!, a[at + 5]!, a[at + 6]!];
      if (q.every((x) => x === 0)) throw new RangeError('Thin-film body row has no rigid body. Pass a live body row.');
      origin = plus(shift([a[at]!, a[at + 1]!, a[at + 2]!], rigid.cell, context.cell, s.cellSize), rotate(q, origin));
      center = shift([a[at + 7]!, a[at + 8]!, a[at + 9]!], rigid.cell, context.cell, s.cellSize);
      u = rotate(q, u);
      v = rotate(q, v);
      velocity = [a[at + 10]!, a[at + 11]!, a[at + 12]!];
      angular = [a[at + 13]!, a[at + 14]!, a[at + 15]!];
    }
    return { origin, u, v, n: cross(u, v), center, velocity, angular };
  }

  private forcing(s: FilmState, frame: Frame, context: StepContext, dt: number): Vec3 {
    const middle = position(frame, 0.5 * s.nx * s.spacing, 0.5 * s.ny * s.spacing);
    const offset = minus(middle, frame.center);
    const velocity = plus(frame.velocity, cross(frame.angular, offset));
    const motion = words(s, s.motion);
    const prev: Vec3 = [motion[1]!, motion[2]!, motion[3]!];
    const acceleration = motion[0] ? scale(minus(velocity, prev), 1 / dt) : ORIGIN;
    const effective = minus(s.gravity, acceleration);
    let [shearU, shearV] = s.shear;
    if (s.wind) {
      const p = shift(middle, context.cell, s.wind.cell, s.cellSize);
      const sample = s.wind.sample(...p, context.tick * dt, this.windSample);
      const air = minus(vector('wind velocity', sample.velocity), velocity);
      const slipU = dot(air, frame.u);
      const slipV = dot(air, frame.v);
      const drag =
        s.airFriction * number('air density', sample.density, 0) * Math.sqrt(slipU * slipU + slipV * slipV) * 0.5;
      shearU += drag * slipU;
      shearV += drag * slipV;
    }
    const normalGravity = -dot(effective, frame.n);
    words(s, s.forcing).set([
      s.suspended ? normalGravity : Math.max(0, normalGravity),
      dot(effective, frame.u),
      dot(effective, frame.v),
      shearU,
      shearV,
      ...s.drains.map(Number),
    ]);
    return velocity;
  }

  private rateAt(s: FilmState, frame: Frame, context: StepContext, u: number, v: number, dt: number): number {
    const weather = s.precipitation;
    if (!weather) return s.rain;
    const location = position(frame, u, v);
    const query = shift(location, context.cell, weather.cell, s.cellSize);
    const sample = weather.sample(...query, context.tick * dt, this.rainSample);
    const velocity = plus(frame.velocity, cross(frame.angular, minus(location, frame.center)));
    const relative = minus(vector('rain velocity', sample.velocity), velocity);
    const inward = Math.max(0, -dot(relative, frame.n));
    const fall = number('rain fall speed', sample.rain.fallSpeed, 0);
    const rate = number('liquid rain rate', sample.rain.rate, 0) / 3_600_000;
    return fall > 0 ? (rate * inward) / fall : 0;
  }

  private fillRain(s: FilmState, frame: Frame, context: StepContext, dt: number): Float64Array {
    const rate = words(s, s.rainRates);
    const input = this.options.rainField && gridInput(s, context, this.options.rainField, 1, true);
    for (let y = 0; y < s.ny; y++) {
      for (let x = 0; x < s.nx; x++) {
        const i = x + y * s.nx;
        const value =
          input?.[input.length === 1 ? 0 : i] ??
          this.rateAt(s, frame, context, (x + 0.5) * s.spacing, (y + 0.5) * s.spacing, dt);
        rate[i] = number('deposition rate', value, 0);
      }
    }
    return rate;
  }

  private spread(s: FilmState, rates: Float64Array, u: number, v: number, r: number, volumeRate: number): number {
    const { nx, ny, spacing } = s;
    const i = Math.min(nx - 1, Math.floor(u / spacing));
    const j = Math.min(ny - 1, Math.floor(v / spacing));
    const index = i + j * nx;
    // Overlap in a compact radial drop footprint. A subcell drop lands in its containing cell.
    if (r <= spacing * 0.5) {
      rates[index]! += volumeRate;
      return index;
    }
    const x0 = Math.max(0, Math.floor((u - r) / spacing));
    const y0 = Math.max(0, Math.floor((v - r) / spacing));
    const x1 = Math.min(nx - 1, Math.floor((u + r) / spacing));
    const y1 = Math.min(ny - 1, Math.floor((v + r) / spacing));
    const invRadius = 1 / r;
    const weight = (x: number, y: number) => {
      const fx = ((x + 0.5) * spacing - u) * invRadius;
      const fy = ((y + 0.5) * spacing - v) * invRadius;
      return Math.max(0, 1 - fx * fx - fy * fy);
    };
    let total = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) total += weight(x, y);
    if (total === 0) rates[index]! += volumeRate;
    else
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) rates[x + y * nx]! += (volumeRate * weight(x, y)) / total;
    return index;
  }

  private impactRain(
    s: FilmState,
    frame: Frame,
    context: StepContext,
    dt: number,
    rates: Float64Array,
  ): { added: number; tick: number; recoil?: ImpactRecoil } {
    const waves = s.nextWaves && words(s, s.nextWaves);
    waves?.fill(0);
    const descriptor = this.options.impacts;
    const published = descriptor && context.inputs.get(descriptor.name);
    const last = words(s, s.motion)[4]!;
    if (!descriptor || !published || published.tick === last) return { added: 0, tick: last };
    const swept = published.region.layout === FILM_SWEPT_IMPACT_LAYOUT;
    const stride = swept ? FILM_SWEPT_IMPACT_WORDS : FILM_IMPACT_WORDS;
    const impacts = gridInput(
      s,
      context,
      descriptor,
      stride,
      false,
      swept ? FILM_SWEPT_IMPACT_LAYOUT : THIN_FILM_LAYOUT,
    );
    if (!impacts) return { added: 0, tick: last };
    if (published.cell.some((value, i) => value !== context.cell[i]))
      throw new RangeError('Thin-film impacts have a different cell. Use the film patch cell for its local UV rows.');
    const density = words(s, s.constants)[1]!;
    const h = words(s, s.depth);
    let added = 0;
    let force = ORIGIN;
    let torque = ORIGIN;
    for (let i = 0; i < impacts.length; i += stride) {
      const volume = number('impact volume', impacts[i + 3]!, 0);
      if (volume === 0) continue;
      const u = number('impact U', impacts[i]!, 0);
      const v = number('impact V', impacts[i + 1]!, 0);
      const r = positive('impact radius', impacts[i + 2]!);
      const inward = number('impact speed', impacts[i + 4]!, 0);
      const normal: Vec3 = swept ? [impacts[i + 5]!, impacts[i + 6]!, impacts[i + 7]!] : frame.n;
      if (swept && !(Math.abs(dot(normal, normal) - 1) <= 64 * Number.EPSILON))
        throw new RangeError('Invalid swept impact normal. You must publish a unit normal in world axes.');
      if (u > s.spacing * s.nx || v > s.spacing * s.ny)
        throw new RangeError('Thin-film impact is outside the patch. Use coordinates inside the UV extent.');
      const j = this.spread(s, rates, u, v, r, volume / (s.area * dt));
      added += volume;
      if (this.options.impactRecoil && inward > 0) {
        const reaction = scale(normal, (-density * volume * inward) / dt);
        const lever: Vec3 = swept
          ? [impacts[i + 8]!, impacts[i + 9]!, impacts[i + 10]!]
          : minus(position(frame, u, v), frame.center);
        if (!lever.every(Number.isFinite))
          throw new RangeError(
            'Invalid swept impact lever arm. You must publish a finite offset from the body centre.',
          );
        force = plus(force, reaction);
        torque = plus(torque, cross(lever, reaction));
      }
      if (waves && h[j]! > 0 && inward > 0) {
        // The wave field carries pressure only. The film already counts the deposited water.
        const projection = Math.max(0, normal[1]);
        const at = j * WAKE_SOURCE_WORDS;
        const radius = Math.max(r, s.spacing);
        const p = position(frame, ((j % s.nx) + 0.5) * s.spacing, (Math.floor(j / s.nx) + 0.5) * s.spacing);
        const oldRadius = waves[at + 2]!;
        const integrated = waves[at + 3]! * oldRadius * oldRadius;
        const spread = Math.max(radius, oldRadius);
        const shape = Math.PI * (0.5 - 2 / (Math.PI * Math.PI));
        waves[at] = p[0];
        waves[at + 1] = p[2];
        waves[at + 2] = spread;
        waves[at + 3] = (integrated + (density * volume * inward * projection) / (dt * shape)) / (spread * spread);
      }
    }
    return { added, tick: published.tick, recoil: this.options.impactRecoil ? { force, torque } : undefined };
  }

  step(context: StepContext, dt: number): void {
    const s = this.live();
    const f = this.frame(s, context);
    const velocity = this.forcing(s, f, context, dt);
    const rates = this.fillRain(s, f, context, dt);
    const impact = this.impactRain(s, f, context, dt, rates);
    const h = words(s, s.depth);
    const next = words(s, s.candidate);
    next.set(h);
    const status = s.kernel.thin_film_step(
      s.candidate.byteOffset,
      s.bottom.byteOffset,
      s.rainRates.byteOffset,
      s.nextDrips.byteOffset,
      s.nextBudget.byteOffset,
      s.constants.byteOffset,
      s.forcing.byteOffset,
      s.workspace.byteOffset,
      s.nx,
      s.ny,
      dt,
      s.wetting?.byteOffset ?? 0,
      s.wettingMap?.byteOffset ?? 0,
      s.contactAngles?.byteOffset ?? 0,
      Number(s.suspended),
    );
    if (status === 2)
      throw new RangeError(
        'Thin-film pressure solve did not converge. Use scales compatible with the film approximation.',
      );
    if (status !== 0)
      throw new RangeError(
        'Thin-film step exceeds numeric range. Use finite material values and compatible surface scales.',
      );
    this.releaseDrops(s, f, context.cell, dt);
    h.set(next);
    words(s, s.drips).set(words(s, s.nextDrips));
    if (s.waves && s.nextWaves) words(s, s.waves).set(words(s, s.nextWaves));
    const budget = words(s, s.budget);
    const delta = words(s, s.nextBudget);
    budget[1]! += Math.max(0, delta[0]! - impact.added);
    budget[2]! += impact.added;
    budget[3]! += delta[1]!;
    budget[4]! += delta[2]!;
    budget[5] = delta[3]!;
    budget[6] = delta[4]!;
    words(s, s.motion).set([1, ...velocity, impact.tick]);
    this.writeRecords(s, f, impact.recoil);
  }

  private releaseDrops(s: FilmState, frame: Frame, cell: Cell, dt: number): void {
    const outlets = s.outlets;
    if (!outlets) return;
    const held = words(s, outlets.held);
    const events = words(s, outlets.events);
    const runoff = words(s, s.nextDrips);
    for (let i = 0; i < outlets.entries.length; i++) {
      const outlet = outlets.entries[i]!;
      const supplied = runoff[outlet.cell]! * dt;
      const count = completeDrips(held[i + 3]! + supplied, outlet.volume);
      if (!Number.isSafeInteger(count))
        throw new MargoError(
          'failed',
          'Too many thin-film drops in one step. Use a larger circular rim or lower flow.',
        );
    }
    held.set(cell, 0);
    events.fill(0);
    for (let i = 0; i < outlets.entries.length; i++) {
      const outlet = outlets.entries[i]!;
      const rate = runoff[outlet.cell]!;
      runoff[outlet.cell] = 0;
      if (rate === 0) continue;
      const before = held[i + 3]!;
      const available = before + rate * dt;
      const count = completeDrips(available, outlet.volume);
      held[i + 3] = available - count * outlet.volume;
      if (!count) continue;
      const at = position(frame, outlet.u, outlet.v);
      const velocity = plus(frame.velocity, cross(frame.angular, minus(at, frame.center)));
      const first = Math.min(dt, Math.max(0, (outlet.volume - before) / rate));
      events.set([...at, ...velocity, outlet.volume, first, outlet.volume / rate, count], i * FILM_DROP_WORDS);
    }
  }

  private writeRecords(s: FilmState, frame?: Frame, recoil?: ImpactRecoil): void {
    const out = words(s, s.cellRecords);
    const h = words(s, s.depth);
    const base = words(s, s.bottom);
    const drains = words(s, s.drips);
    const load = frame && s.forces;
    const support = load && this.options.hydrostaticLoad;
    let thickness = 0;
    let momentU = 0;
    let momentV = 0;
    for (let y = 0; y < s.ny; y++) {
      for (let x = 0; x < s.nx; x++) {
        const i = x + y * s.nx;
        const at = i * THIN_FILM_WORDS;
        out[at] = (x + 0.5) * s.spacing;
        out[at + 1] = (y + 0.5) * s.spacing;
        out[at + 2] = base[i]!;
        out[at + 3] = h[i]!;
        out[at + 4] = drains[i]!;
        if (support) {
          thickness += h[i]!;
          momentU += h[i]! * out[at]!;
          momentV += h[i]! * out[at + 1]!;
        }
      }
    }
    let force = ORIGIN;
    let torque = ORIGIN;
    if (support && frame) {
      const g = dot(s.gravity, frame.n);
      const normal = s.suspended ? g : Math.min(0, g);
      const traction = scale(frame.n, normal * words(s, s.constants)[1]! * s.area);
      const moment = plus(
        scale(minus(frame.origin, frame.center), thickness),
        plus(scale(frame.u, momentU), scale(frame.v, momentV)),
      );
      force = scale(traction, thickness);
      torque = cross(moment, traction);
    }
    if (load) {
      if (recoil) {
        force = plus(force, recoil.force);
        torque = plus(torque, recoil.torque);
      }
      words(s, load).set([...force, ...torque], s.bodyRow! * FORCE_WORDS);
    }
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const s = this.live();
    const ports: Port[] = [
      { field: this.filmField.name, region: s.cellRecords, tick, cell: ORIGIN },
      { field: this.dripsField.name, region: s.drips, tick, cell: ORIGIN },
    ];
    if (s.waves) ports.push({ field: this.waveField.name, region: s.waves, tick, cell: ORIGIN });
    if (s.forces) ports.push({ field: BODY_FORCES_FIELD.name, region: s.forces, tick, cell: ORIGIN });
    if (s.outlets) {
      const origin = words(s, s.outlets.held);
      ports.push({
        field: this.dropsField.name,
        region: s.outlets.events,
        tick,
        cell: [origin[0]!, origin[1]!, origin[2]!],
      });
    }
    return ports;
  }

  stateRegions(): readonly Region[] {
    return this.live().regions;
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Sample a grid cell in its local plane. */
  sample(x: number, y: number): ThinFilmCell {
    const s = this.live();
    if (size('column', x, 0) >= s.nx || size('row', y, 0) >= s.ny)
      throw new RangeError('Thin-film cell is outside the patch. Use a valid column and row.');
    const w = words(s, s.cellRecords);
    const i = (x + y * s.nx) * THIN_FILM_WORDS;
    return { u: w[i]!, v: w[i + 1]!, substrate: w[i + 2]!, depth: w[i + 3]!, dripRate: w[i + 4]! };
  }

  /** Copy the film thickness in row-major order for a render adapter or field analysis. */
  depths(out = new Float64Array(this.live().count)): Float64Array {
    const s = this.live();
    if (out.length !== s.count) throw new RangeError('Invalid thin-film destination size. Use one word per film cell.');
    out.set(words(s, s.depth));
    return out;
  }

  /** Copy a renderer-ready free-surface mesh in local metres. Mount it on the same body as the film, when mounted. */
  surfaceGeometry(): ThinFilmSurfaceGeometry {
    const s = this.live();
    return makeFilmSurface(s.nx, s.ny, s.spacing, s.origin, s.u, s.v, words(s, s.depth), words(s, s.bottom));
  }

  /** Water in the detached-drop outlets awaiting release, in m³. */
  get heldDripVolume(): number {
    const s = this.live();
    if (!s.outlets) return 0;
    const held = words(s, s.outlets.held);
    let volume = 0;
    for (let i = 3; i < held.length; i++) volume += held[i]!;
    return volume;
  }

  /** Cumulative water volumes. */
  get budget(): ThinFilmBudget {
    const s = this.live();
    const w = words(s, s.budget);
    return {
      initial: w[0]!,
      rain: w[1]!,
      impacts: w[2]!,
      evaporated: w[3]!,
      dripped: w[4]!,
      stored: w[5]!,
      substeps: w[6]!,
    };
  }
}
