import type { MutableVec3, Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { cos, hypot, sin } from '@margoengine/math/pinned';

export const TAU = 2 * Math.PI;
export const ZERO: Vec3 = [0, 0, 0];

export function finite(value: number, name: string, minimum = -Infinity): number {
  if (!Number.isFinite(value) || value < minimum)
    throw new MargoError('state', 'Set ' + name + ' to a finite number in its documented SI range.');
  return value;
}

export function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new MargoError('state', 'Set ' + name + ' to a finite positive number in SI units.');
  return value;
}

export function vector(values: Vec3, name: string): Vec3 {
  if (!values || values.length !== 3 || ![values[0], values[1], values[2]].every(Number.isFinite))
    throw new MargoError('state', 'Set ' + name + ' to a finite three-component vector in SI units.');
  return [...values];
}

/** Fast frequency envelope from Sánchez-Rodríguez, Raufaste and Argentina (2023), Eq. 4 and Fig. 1. */
export function maximumTailFrequency(length: number): number {
  const crossover = 0.4;
  // Solve for f/f0 times max(1,L/Lc). This keeps the root bracket in [0,1] for all positive lengths.
  const forceScale = length > crossover ? 1 : length / crossover;
  const frequencyScale = length > crossover ? crossover / length : 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 53; i++) {
    const mid = (lo + hi) / 2;
    const frequency = mid * frequencyScale;
    const force = mid * forceScale;
    if (force * force * (1 + 4 * frequency) + frequency > 1) hi = mid;
    else lo = mid;
  }
  return (lo + hi) * 0.5 * 22 * frequencyScale;
}

/** One-sided tail displacement, full tail span and travelling wavelength in metres. */
export interface SwimTail {
  readonly amplitude: number;
  readonly span: number;
  readonly wavelength: number;
  /** Deform laterally (default) for fish or vertically for cetaceans. */
  readonly plane?: 'lateral' | 'vertical';
}

/** Cycle-mean force and hydrodynamic power from a travelling wave with a flat trailing envelope. */
export interface SwimPropulsion {
  /** Signed mean thrust in N. A wave travelling slower than the swimmer produces braking. */
  thrust: number;
  /** Signed power transferred to wake and useful work, W, in Lighthill's through-flow model. */
  power: number;
  /** Useful forward work / total input in the propulsive regime, zero outside it. */
  efficiency: number;
  /** Trailing peak-to-peak displacement times frequency / speed, Infinity at zero speed with active displacement. */
  strouhal: number;
}

/** Evaluates Lighthill's slender-body tail result at the given beat frequency (Hz) and forward through-flow (m/s). */
export function swimPropulsion(
  tail: SwimTail,
  frequency: number,
  speed: number,
  density = 1025,
  out: SwimPropulsion = { thrust: 0, power: 0, efficiency: 0, strouhal: 0 },
): SwimPropulsion {
  if (!tail || typeof tail !== 'object')
    throw new MargoError('state', 'Swimming propulsion needs tail geometry. Pass amplitude, span and wavelength.');
  const { amplitude, span, wavelength } = tail;
  finite(amplitude, 'tail.amplitude', 0);
  positive(span, 'tail.span');
  positive(wavelength, 'tail.wavelength');
  finite(frequency, 'frequency', 0);
  finite(speed, 'speed', 0);
  finite(density, 'density', 0);
  const omega = TAU * frequency;
  const flowFrequency = (TAU * speed) / wavelength;
  const scale = (density * Math.PI * span * span * amplitude * amplitude) / 16;
  const difference = omega - flowFrequency;
  const powered = frequency > 0 && amplitude > 0 && density > 0,
    thrust = powered ? scale * difference * (omega + flowFrequency) : 0,
    power = powered ? 2 * scale * speed * omega * difference : 0,
    efficiency = power > 0 ? (1 + flowFrequency / omega) / 2 : 0,
    strouhal = amplitude && frequency ? (2 * (amplitude * frequency)) / speed : 0;
  if (!Number.isFinite(thrust) || !Number.isFinite(power) || (speed > 0 && !Number.isFinite(strouhal)))
    throw new MargoError(
      'state',
      'Swimming propulsion exceeds finite SI units. Reduce amplitude, beat frequency or body scale.',
    );
  out.thrust = thrust;
  out.power = power;
  out.efficiency = efficiency;
  out.strouhal = strouhal;
  return out;
}

/** Normalizes a vector; its zero vector has a zero direction. */
export function unit(x: number, y: number, z: number, out: MutableVec3): void {
  const length = hypot(x, y, z);
  out[0] = length ? x / length : 0;
  out[1] = length ? y / length : 0;
  out[2] = length ? z / length : 0;
}

/** Applies a unit quaternion or its inverse to a vector. */
export function rotate(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  x: number,
  y: number,
  z: number,
  out: MutableVec3,
): void {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + qy * tz - qz * ty;
  out[1] = y + qw * ty + qz * tx - qx * tz;
  out[2] = z + qw * tz + qx * ty - qy * tx;
}

/** Locally sampled spine center and unit tangent toward the tail. */
export interface SwimSpinePoint {
  position: MutableVec3;
  tangent: MutableVec3;
}

export function spine(
  length: number,
  tail: SwimTail,
  phase: number,
  amplitude: number,
  recoilBasis: readonly [number, number],
  fraction: number,
  out: SwimSpinePoint,
): SwimSpinePoint {
  const axis = tail.plane === 'vertical' ? 1 : 0;
  const z = length * (0.5 - fraction);
  const waveNumber = TAU / tail.wavelength;
  const angle = TAU * phase - waveNumber * length * fraction;
  const envelope = fraction * fraction * (3 - 2 * fraction);
  const slope = (6 * fraction * (1 - fraction)) / length;
  const correction = (recoilBasis[0] * sin(TAU * phase) - recoilBasis[1] * cos(TAU * phase)) / 0.3;
  const headWeight = 1 - fraction;
  const displacement = amplitude * (envelope * sin(angle) - correction * headWeight * headWeight);
  const derivative =
    amplitude * (slope * sin(angle) - envelope * waveNumber * cos(angle) + (2 * correction * headWeight) / length);
  out.position[0] = axis === 0 ? displacement : 0;
  out.position[1] = axis === 1 ? displacement : 0;
  out.position[2] = z;
  unit(axis === 0 ? derivative : 0, axis === 1 ? derivative : 0, -1, out.tangent);
  return out;
}

/** The volume and vertical first moment of a cut unit sphere, normalized by its full volume. */
export function submerged(level: number): number {
  return level <= -1 ? 0 : level >= 1 ? 1 : ((2 + level) * (1 + level) * (1 + level)) / 4;
}

// The cross section of a unit-length ellipsoid weighs station s by 6s(1-s).
// Integrate this times the smoothstep wave envelope once, in sine and cosine bases.
// At short wavelengths integration by parts evaluates the exact polynomial moments.
export function recoil(waveNumber: number): readonly [number, number] {
  const k = waveNumber;
  if (k >= 4) {
    const su = sin(k) / k;
    const cu = cos(k) / k;
    let c = su;
    let s = 1 / k - cu;
    let resultC = 0;
    let resultS = 0;
    for (let n = 1; n <= 5; n++) {
      [c, s] = [su - (n / k) * s, -cu + (n / k) * c];
      const coefficient = n === 3 ? 18 : n === 4 ? -30 : n === 5 ? 12 : 0;
      resultC += coefficient * c;
      resultS += coefficient * s;
    }
    return [resultC, resultS];
  }
  let resultC = 0;
  let resultS = 0;
  for (let i = 0; i < GAUSS_NODES.length; i++) {
    for (const sign of [-1, 1]) {
      const x = (1 + sign * GAUSS_NODES[i]!) / 2;
      const w = GAUSS_WEIGHTS[i]! * 3 * x * x * x * (1 - x) * (3 - 2 * x);
      resultC += w * cos(k * x);
      resultS += w * sin(k * x);
    }
  }
  return [resultC, resultS];
}

const GAUSS_NODES = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
const GAUSS_WEIGHTS = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

/** Ellipsoid area from the transformed unit sphere surface Jacobian. */
export function ellipsoidArea(a: number, b: number, c: number): number {
  let average = 0;
  for (let i = 0; i < GAUSS_NODES.length; i++) {
    for (const sign of [-1, 1]) {
      const z = (1 + sign * GAUSS_NODES[i]!) / 2;
      const r = Math.sqrt(1 - z * z);
      for (let j = 0; j < GAUSS_NODES.length; j++) {
        for (const side of [-1, 1]) {
          const azimuth = (Math.PI / 4) * (1 + side * GAUSS_NODES[j]!);
          const jacobian = hypot(b * c * r * cos(azimuth), a * c * r * sin(azimuth), a * b * z);
          average += GAUSS_WEIGHTS[i]! * GAUSS_WEIGHTS[j]! * jacobian;
        }
      }
    }
  }
  return Math.PI * average;
}
