import { MargoError } from '@margoengine/math/errors';
import { exp, hypot, ln, pow } from '@margoengine/math/pinned';
import { positive } from './material.js';
import type { CrushPlateSurface } from './plate.js';

/** Geometry and coupon properties of a thin, clamped circular sheet indented at its centre. */
export interface CircularPlateParams {
  /** Radius to the fixed edge, m. */
  readonly radius: number;
  /** Undeformed plate thickness, m. */
  readonly thickness: number;
  /** Physical radius of the smooth rigid sphere, m. */
  readonly indenterRadius: number;
  /** Uniaxial true flow stress coefficient in the Hollomon law, Pa. */
  readonly strength: number;
  /** Nonnegative uniaxial strain-hardening exponent. Zero gives rigid-perfectly-plastic flow. */
  readonly hardening: number;
}

/** Loading and optional deformed samples before tensile localization. */
export interface CircularPlateReading {
  /** Normal stroke while intact, m, retained at the rupture stroke afterwards. */
  readonly stroke: number;
  /** Normal reaction on the intact loading branch, N. */
  readonly force?: number;
  /** Work expended through the current stroke, J. */
  readonly work: number;
  /** Radius at which the sheet leaves the spherical surface, m. */
  readonly contactRadius: number;
  /** Whether the loading branch reached its first peak. */
  readonly fractured: boolean;
  /** Sheet coordinates and normals at the requested rest points. */
  readonly surface?: CrushPlateSurface;
}

interface Knot {
  readonly sine: number;
  readonly stroke: number;
  readonly force: number;
  readonly work: number;
}

const SAMPLES = 96;
const INTEGRATION = 48;
const MAX_SINE = 1 - Number.EPSILON;

function zeroOf(evaluate: (x: number) => number, upper: number): number {
  let low = 0;
  let high = upper;
  for (let i = 0; i < 42; i++) {
    const middle = low + 0.5 * (high - low);
    if (evaluate(middle) < 0) low = middle;
    else high = middle;
  }
  return 0.5 * (low + high);
}

function sineStrain(squared: number): number {
  return squared < 1e-8 ? 0.5 * squared * (1 + 0.5 * squared) : -0.5 * ln(1 - squared);
}

/** Quasi-static spherical indentation, through global membrane localization, with no curve fit to indentation data. */
export class CircularPlateIndentation {
  /** Stroke at the global force maximum, m. */
  readonly fractureStroke: number;
  /** Last intact normal loading force, N. */
  readonly fractureForce: number;
  /** Work absorbed up to the first peak, J. */
  readonly fractureWork: number;
  private readonly radius: number;
  private readonly tip: number;
  private readonly hardening: number;
  private readonly radialPeak: number;
  private readonly knots: readonly Knot[];

  constructor(params: CircularPlateParams) {
    this.radius = positive(params.radius, 'circular plate radius');
    const thickness = positive(params.thickness, 'circular plate thickness');
    this.tip = positive(params.indenterRadius, 'circular plate indenter radius') + 0.5 * thickness;
    if (!(thickness < this.radius && this.tip < this.radius))
      throw new MargoError(
        'state',
        'Choose a plate radius larger than the thickness and sphere middle-surface radius.',
      );
    this.hardening = positive(params.hardening, 'circular plate hardening exponent', 0);
    const flow = positive(params.strength, 'circular plate strength');
    // Associated von Mises flow converts uniaxial equivalent values to radial plane strain.
    const conversion = 2 / Math.sqrt(3); // float division: radial stress factor
    const forceFactor = 2 * Math.PI * flow * thickness * pow(conversion, 1 + this.hardening);
    this.radialPeak = this.peak(1);
    const fractureSine = this.peak(2);
    const table: Knot[] = [{ sine: 0, stroke: 0, force: 0, work: 0 }];
    for (let i = 1; i <= SAMPLES; i++) {
      const sine = (i * fractureSine) / SAMPLES; // float division: polar coordinate sampling
      const contact = this.tip * sine;
      const equilibrium = contact * this.radial(sine);
      const sag = this.sphericalSag(sine);
      const stroke = sag + this.deflection(equilibrium, contact);
      const force = forceFactor * equilibrium;
      const previous = table[i - 1]!;
      const work = previous.work + 0.5 * (stroke - previous.stroke) * (previous.force + force);
      if (!(stroke > previous.stroke && Number.isFinite(force) && Number.isFinite(work)))
        throw new MargoError(
          'state',
          'Choose plate dimensions, strength and hardening with a finite increasing loading branch.',
        );
      table.push({ sine, stroke, force, work });
    }
    this.knots = table;
    const limit = table[SAMPLES]!;
    this.fractureForce = limit.force;
    this.fractureStroke = limit.stroke;
    this.fractureWork = limit.work;
  }

  /** Samples stroke in metres and optional flat/rest (x,y) pairs within the circular sheet. */
  read(stroke: number, rest?: ArrayLike<number>): CircularPlateReading {
    positive(stroke, 'circular plate indentation stroke', 0);
    const load = Math.min(stroke, this.fractureStroke);
    const fractured = stroke >= this.fractureStroke;
    let low = 0;
    let high = SAMPLES;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (this.knots[middle]!.stroke <= load) low = middle;
      else high = middle;
    }
    const a = this.knots[low]!;
    const b = this.knots[high]!;
    const fraction = (load - a.stroke) / (b.stroke - a.stroke); // float division: load secant
    const sine = a.sine + fraction * (b.sine - a.sine);
    const force = a.force + fraction * (b.force - a.force);
    return {
      stroke: load,
      force: fractured ? undefined : force,
      work: Math.min(this.fractureWork, a.work + 0.5 * (load - a.stroke) * (a.force + force)),
      contactRadius: this.tip * sine,
      fractured,
      surface: rest && this.surface(load, sine, rest),
    };
  }

  private radial(sine: number): number {
    const square = sine * sine;
    return pow(sineStrain(square), this.hardening) * Math.sqrt(1 - square) * sine;
  }

  private peak(power: 1 | 2): number {
    return zeroOf((sine) => {
      const square = sine * sine;
      return (1 - this.hardening / sineStrain(square)) * square - power * (1 - square); // float division
    }, MAX_SINE);
  }

  private shapeSine(equilibrium: number, r: number): number {
    if (equilibrium === 0) return 0;
    const target = equilibrium / r; // float division: membrane vertical equilibrium
    return zeroOf((sine) => this.radial(sine) - target, this.radialPeak);
  }

  private deflection(equilibrium: number, r: number): number {
    if (r >= this.radius || equilibrium === 0) return 0;
    const logarithmicLength = (ln(this.radius) - ln(r)) / INTEGRATION; // float division: integrate in log radius
    let vertical = 0;
    for (let k = 0; k < INTEGRATION; k++) {
      const mid = r * exp((k + 0.5) * logarithmicLength);
      vertical += this.radialRise(equilibrium, mid);
    }
    return vertical * logarithmicLength;
  }

  private radialRise(equilibrium: number, r: number): number {
    const slope = this.shapeSine(equilibrium, r);
    return (r * slope) / Math.sqrt(1 - slope * slope); // float division: dw/dln(r) = r tan(theta)
  }

  private sphericalSag(sine: number): number {
    const square = sine * sine;
    return (this.tip * square) / (1 + Math.sqrt(1 - square)); // float division: stable spherical sag
  }

  private surface(load: number, sine: number, rest: ArrayLike<number>): CrushPlateSurface {
    if (!Number.isSafeInteger(rest.length) || rest.length % 2 !== 0)
      throw new MargoError('state', 'Pass pairs of finite rest-plane coordinates to sample the circular plate.');
    const count = rest.length / 2; // float division: pair count
    const positions = new Float64Array(count * 3);
    const normals = new Float64Array(positions.length);
    const contact = this.tip * sine;
    const equilibrium = contact * this.radial(sine);
    const radialHeight = new Float64Array(INTEGRATION + 1);
    const contactLog = contact ? ln(contact) : 0;
    const logDelta = (ln(this.radius) - contactLog) / INTEGRATION; // float division: radial sample step
    if (equilibrium > 0) {
      // Integrate each radius interval once for all vertices in the mesh.
      for (let i = INTEGRATION - 1; i >= 0; i--) {
        const mid = contact * exp((i + 0.5) * logDelta);
        radialHeight[i] = radialHeight[i + 1]! + logDelta * this.radialRise(equilibrium, mid);
      }
    }
    const depth = this.sphericalSag(sine) + radialHeight[0]!;
    const normalization = depth > 0 ? load / depth : 1; // float division: normalize the interpolated shape to the stroke
    const rimRoundoff = this.radius * 4 * Number.EPSILON;
    for (let k = 0; k < count; k++) {
      const x = rest[2 * k]!;
      const y = rest[2 * k + 1]!;
      const distance = hypot(x, y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || distance > this.radius + rimRoundoff)
        throw new MargoError('state', 'Use finite rest-plane sample coordinates inside the circular plate.');
      const r = distance >= this.radius - rimRoundoff ? this.radius : distance;
      const inner = r < contact;
      const polar = inner ? r / this.tip : this.shapeSine(equilibrium, r); // float division: sphere contact normal
      const horizontal = equilibrium && r > 0 ? normalization * polar : 0;
      const vertical = Math.sqrt(1 - polar * polar);
      const magnitude = hypot(horizontal, vertical);
      const radial = distance > 0 ? horizontal / (distance * magnitude) : 0; // float division: Cartesian surface normal
      let z = 0;
      if (inner) z = load - normalization * this.sphericalSag(polar);
      else if (equilibrium > 0 && r < this.radius) {
        const distanceLog = ln(r) - contactLog;
        const i = Math.max(0, Math.min(INTEGRATION - 1, Math.floor(distanceLog / logDelta))); // float division
        const offset = distanceLog - i * logDelta;
        const mid = contact * exp(i * logDelta + 0.5 * offset);
        z = normalization * (radialHeight[i]! - offset * this.radialRise(equilibrium, mid));
      }
      const at = 3 * k;
      positions.set([x, y, z], at);
      normals.set([x * radial, y * radial, vertical / magnitude], at); // float division: unit normal
    }
    return { positions, normals };
  }
}
