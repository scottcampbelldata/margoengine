import { cos, exp, hypot, ln, sin } from '@margoengine/math/pinned';
import { atan2 } from '../space/angles.js';
import { layerSpeed, PROFILE_WORDS, soundLayer } from './profile.js';

const TAU = 2 * Math.PI;
const DB_PER_NEPER = 20 / ln(10);

/** Launch conditions for one ray with a monochromatic Gaussian beam around it. */
export interface AcousticRayOptions {
  /** Initial depth in metres. Defaults to half the depth of the profile. */
  readonly depth?: number;
  /** Angle from horizontal in radians, positive down, in [-π/2, π/2]. Defaults to 0. */
  readonly declination?: number;
  /** Frequency in Hz. Defaults to 1000. */
  readonly frequency?: number;
  /** Initial radius at which pressure falls to one over e of its axis value, in metres. Defaults to 5. */
  readonly waist?: number;
  /** Pressure amplitude at launch, in Pa. Defaults to 1. */
  readonly pressure?: number;
}

/** The central ray and its paraxial acoustic beam at the current world time. */
export interface AcousticRaySample {
  /** Horizontal distance from launch in metres. */
  readonly range: number;
  /** Depth below the free surface in metres. */
  readonly depth: number;
  /** Angle from horizontal in radians, positive down. */
  readonly declination: number;
  /** Time since launch in seconds. */
  readonly travelTime: number;
  /** Integrated ray length in metres. */
  readonly pathLength: number;
  /** Sound speed at the ray in m/s. */
  readonly soundSpeed: number;
  /** Beam radius at the 1/e value of pressure amplitude, in metres. */
  readonly width: number;
  /** Signed wavefront curvature in inverse metres. */
  readonly curvature: number;
  /** Signed local axis pressure in Pa, including reflection losses. */
  readonly pressure: number;
  /** Axis phase in radians, reduced modulo one cycle. */
  readonly phase: number;
  /** Launch frequency in Hz. */
  readonly frequency: number;
  /** Number of reflections from the surface or bottom. */
  readonly reflections: number;
}

/** The pressure phasor relative to the defined launch phase, in Pa. */
export interface AcousticPressure {
  readonly real: number;
  readonly imaginary: number;
}

/** Evaluates a ray's beam at a signed perpendicular offset in metres. */
export function acousticBeamPressure(ray: AcousticRaySample, offset: number): AcousticPressure {
  if (!Number.isFinite(offset))
    throw new RangeError('Invalid Gaussian beam offset; pass a finite perpendicular distance in metres.');
  const ratio = offset / ray.width;
  const pressure = ray.pressure * exp(-ratio * ratio);
  if (pressure === 0) return { real: 0, imaginary: 0 };
  const phase = (ray.phase + ((Math.PI * ray.frequency * ray.curvature * offset) / ray.soundSpeed) * offset) % TAU;
  if (!Number.isFinite(phase))
    throw new RangeError(
      'Acoustic beam phase exceeds numeric range; reduce launch frequency or the perpendicular offset.',
    );
  return { real: pressure * cos(phase), imaginary: pressure * sin(phase) };
}

// The region owns these values. A ray holds no views or references between steps.
const enum Word {
  Layer,
  Range,
  Depth,
  Vertical,
  Slowness,
  Time,
  Length,
  Frequency,
  LaunchSpeed,
  Epsilon,
  QReal,
  QImag,
  PReal,
  PImag,
  Gouy,
  Pressure,
  Reflections,
  LengthWords,
}

export const TRACE_WORDS = Word.LengthWords;
const DEFAULT_WAIST = 5;

export function initializeRay(profile: Float64Array, ray: AcousticRayOptions): readonly number[] {
  const depth = ray.depth ?? profile[profile.length - PROFILE_WORDS]! / 2;
  const direction = ray.declination ?? 0;
  const frequency = ray.frequency ?? 1000;
  const waist = ray.waist ?? DEFAULT_WAIST;
  const pressure = ray.pressure ?? 1;
  if (!(Math.abs(direction) <= Math.PI / 2))
    throw new RangeError('Invalid acoustic launch angle; use an angle from -π/2 to π/2 radians.');
  if (
    !(frequency > 0 && Number.isFinite(frequency) && waist > 0 && Number.isFinite(waist) && Number.isFinite(pressure))
  )
    throw new RangeError(
      'Invalid Gaussian beam; supply positive finite frequency and width and finite launch pressure.',
    );
  const epsilon = Math.PI * frequency * waist * waist;
  if (!(epsilon > 0 && Number.isFinite(epsilon)))
    throw new RangeError(
      'Gaussian beam scale is outside numeric range; use a smaller frequency or representable beam width.',
    );
  let layer = soundLayer(profile, depth, direction >= 0);
  if (
    direction === 0 &&
    layer > 0 &&
    depth === profile[layer * PROFILE_WORDS] &&
    profile[layer * PROFILE_WORDS + 2]! > 0 &&
    profile[layer * PROFILE_WORDS - 1]! > 0
  )
    layer--;
  const speed = layerSpeed(profile, layer * PROFILE_WORDS, depth);
  const vertical = sin(direction);
  const slowness = Math.abs(direction) === Math.PI / 2 ? 0 : cos(direction) / speed;
  return [layer, 0, depth, vertical, slowness, 0, 0, frequency, speed, epsilon, 0, epsilon, 1, 0, 0, pressure, 0];
}

function logOnePlus(x: number): number {
  const y = 1 + x;
  return y === 1 ? x : (ln(y) * x) / (y - 1);
}

function tanh(x: number): number {
  if (Math.abs(x) < 1 / 32) {
    const xx = x * x;
    return x * (1 + xx * (-1 / 3 + xx * (2 / 15 + xx * (-17 / 315 + xx * (62 / 2835 - (1382 / 155925) * xx)))));
  }
  const e = exp(-2 * Math.abs(x));
  return (Math.sign(x) * (1 - e)) / (1 + e);
}

function verticalAt(slowness: number, speed: number): number {
  const horizontal = slowness * speed;
  return Math.sqrt(Math.max(0, (1 - horizontal) * (1 + horizontal)));
}

function exitTime(
  depthDelta: number,
  toward: -1 | 1,
  speed: number,
  slope: number,
  vertical: number,
  slowness: number,
  edgeSpeed: number,
): number {
  if (slope === 0) return vertical * toward > 0 ? depthDelta / (speed * vertical) : Infinity;
  const edgeVertical = verticalAt(slowness, edgeSpeed);
  if (edgeVertical === 0) return Infinity;
  const movingToward = vertical * toward >= 0;
  if (!movingToward && slope * toward > 0) return Infinity;
  const from = Math.abs(vertical);
  if (!movingToward) {
    // The ray turns inside the layer before coming back to this edge.
    const fromAngle = ln((1 + from) / (slowness * speed));
    const toAngle = ln((1 + edgeVertical) / (slowness * edgeSpeed));
    return (Math.sign(vertical) * (fromAngle + toAngle)) / slope;
  }
  // atanh(u) = sign(u) ln((1 + |u|)/(horizontal slowness * c)).
  // Subtract the two log arguments in one log1p, using a difference of squares for the vertical sines.
  const change = slope * depthDelta;
  const verticalDifference = (slowness * slowness * change * (speed + edgeSpeed)) / (from + edgeVertical);
  const ratioChange = change / speed + (edgeSpeed / speed) * (verticalDifference / (1 + edgeVertical));
  return Math.max(0, (toward * logOnePlus(ratioChange)) / slope);
}

function beamDrift(ray: Float64Array, row: number, integral: number): void {
  const x = ray[row + Word.QReal]!;
  const y = ray[row + Word.QImag]!;
  const dx = integral * ray[row + Word.PReal]!;
  const dy = integral * ray[row + Word.PImag]!;
  const nextX = x + dx;
  const nextY = y + dy;
  // Advance the argument along the continuous branch of the complex square root.
  const cross = x * dy - y * dx;
  const dot = x * nextX + y * nextY;
  ray[row + Word.Gouy] = (ray[row + Word.Gouy]! - 0.5 * atan2(cross, dot)) % TAU;
  ray[row + Word.QReal] = nextX;
  ray[row + Word.QImag] = nextY;
}

function advanceInside(ray: Float64Array, row: number, speed: number, slope: number, dt: number): void {
  const u = ray[row + Word.Vertical]!;
  const slowness = ray[row + Word.Slowness]!;
  let integral = speed * speed * dt;
  let depth = speed * u * dt;
  let length = speed * dt;
  if (slope !== 0) {
    const w = tanh(slope * dt);
    const stretch = Math.sqrt((1 - w) * (1 + w));
    const divisor = 1 - u * w;
    const scale = w === 0 ? dt : w / slope;
    integral = (speed * speed * scale) / divisor;
    depth = (speed * scale * (u - w / (1 + stretch))) / divisor;
    ray[row + Word.Vertical] = (u - w) / divisor;
    if (slowness === 0) {
      length = Math.abs(depth);
    } else {
      const horizontal = slowness * speed;
      const nextU = ray[row + Word.Vertical]!;
      const nextHorizontal = (horizontal * stretch) / divisor;
      const angleSine = (horizontal * w * (1 - (u * w) / (1 + stretch))) / divisor;
      length = w === 0 ? speed * dt : atan2(angleSine, u * nextU + horizontal * nextHorizontal) / (slowness * slope);
    }
  }
  ray[row + Word.Range] = ray[row + Word.Range]! + slowness * integral;
  ray[row + Word.Depth] = ray[row + Word.Depth]! + depth;
  ray[row + Word.Length] = ray[row + Word.Length]! + length;
  beamDrift(ray, row, integral);
}

function bendBeam(ray: Float64Array, row: number, slopeChange: number, vertical: number): void {
  if (slopeChange === 0 || vertical === 0) return;
  // Integrate the distributional normal curvature of c across a linear-layer boundary.
  const slowness = ray[row + Word.Slowness]!;
  const kick = (-slopeChange * slowness * slowness) / vertical;
  ray[row + Word.PReal] = ray[row + Word.PReal]! + kick * ray[row + Word.QReal]!;
  ray[row + Word.PImag] = ray[row + Word.PImag]! + kick * ray[row + Word.QImag]!;
}

export function advanceRay(
  profile: Float64Array,
  ray: Float64Array,
  row: number,
  dt: number,
  surfaceReflection: number,
  bottomReflection: number,
): void {
  const slowness = ray[row + Word.Slowness]!;
  let remaining = dt;
  while (remaining > 0) {
    const layer = ray[row + Word.Layer]!;
    const index = layer * PROFILE_WORDS;
    const depth = ray[row + Word.Depth]!;
    const speed = layerSpeed(profile, index, depth);
    const vertical = ray[row + Word.Vertical]!;
    const top = profile[index]!;
    const bottom = profile[index + PROFILE_WORDS]!;
    const gradient = profile[index + 2]!;
    // A tangent on a boundary follows it when the adjacent layer would bend the ray out of that layer.
    const pinnedToBoundary = vertical === 0 && ((depth === top && gradient > 0) || (depth === bottom && gradient < 0));
    const slope = pinnedToBoundary ? 0 : gradient;
    const upper = exitTime(top - depth, -1, speed, slope, vertical, slowness, profile[index + 1]!);
    const lower = exitTime(bottom - depth, 1, speed, slope, vertical, slowness, profile[index + 4]!);
    const exit = Math.min(upper, lower);
    if (exit > remaining) {
      advanceInside(ray, row, speed, slope, remaining);
      ray[row + Word.Depth] = Math.min(bottom, Math.max(top, ray[row + Word.Depth]!));
      break;
    }
    advanceInside(ray, row, speed, slope, exit);
    const edgeDirection = upper < lower ? -1 : 1;
    const edge = edgeDirection === -1 ? index : index + PROFILE_WORDS;
    const edgeSpeed = profile[edge + 1]!;
    const incidence = edgeDirection * verticalAt(slowness, edgeSpeed);
    const nextLayer = layer + edgeDirection;
    ray[row + Word.Depth] = profile[edge]!;
    if (nextLayer >= 0 && (nextLayer + 1) * PROFILE_WORDS < profile.length) {
      bendBeam(ray, row, profile[nextLayer * PROFILE_WORDS + 2]! - slope, incidence);
      ray[row + Word.Layer] = nextLayer;
      ray[row + Word.Vertical] = incidence;
    } else {
      // Unfold a flat reflecting boundary: its mirrored profile changes slope sign.
      bendBeam(ray, row, -2 * slope, incidence);
      ray[row + Word.Vertical] = -incidence;
      ray[row + Word.Pressure] = ray[row + Word.Pressure]! * (nextLayer < 0 ? surfaceReflection : bottomReflection);
      ray[row + Word.Reflections] = ray[row + Word.Reflections]! + 1;
    }
    const nextTime = remaining - exit;
    if (exit > 0 && nextTime === remaining)
      throw new RangeError(
        'The acoustic layer transit is below floating-point time resolution; increase the layer depth.',
      );
    remaining = nextTime;
  }
  ray[row + Word.Time] = ray[row + Word.Time]! + dt;
}

export function sampleRay(
  profile: Float64Array,
  ray: Float64Array,
  row: number,
  absorption: number,
): AcousticRaySample {
  const depth = ray[row + Word.Depth]!;
  const speed = layerSpeed(profile, ray[row + Word.Layer]! * PROFILE_WORDS, depth);
  const epsilon = ray[row + Word.Epsilon]!;
  const frequency = ray[row + Word.Frequency]!;
  const qr = ray[row + Word.QReal]!;
  const qi = ray[row + Word.QImag]!;
  const norm = hypot(qr, qi);
  const pathLength = ray[row + Word.Length]!;
  const travelTime = ray[row + Word.Time]!;
  const damping = absorption === 0 ? 1 : exp((-absorption * (pathLength / 1000)) / DB_PER_NEPER);
  return {
    range: ray[row + Word.Range]!,
    depth,
    declination: atan2(ray[row + Word.Vertical]!, ray[row + Word.Slowness]! * speed),
    travelTime,
    pathLength,
    soundSpeed: speed,
    width: (norm / epsilon) * Math.sqrt(epsilon / (Math.PI * frequency)),
    curvature: (-speed / norm) * (ray[row + Word.PReal]! * (qr / norm) + ray[row + Word.PImag]! * (qi / norm)),
    pressure:
      ray[row + Word.Pressure]! * damping * Math.sqrt((speed / ray[row + Word.LaunchSpeed]!) * (epsilon / norm)),
    phase: ray[row + Word.Gouy]! - TAU * ((frequency * travelTime) % 1),
    frequency,
    reflections: ray[row + Word.Reflections]!,
  };
}
