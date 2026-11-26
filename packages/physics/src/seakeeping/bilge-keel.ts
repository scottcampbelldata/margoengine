import { MargoError } from '@margoengine/math/errors';
import { exp, hypot, ln, pow } from '@margoengine/math/pinned';
import { atan2 } from '../ship/propeller.js';
import { bilgePressureMoment, type BilgePressureSection, bilgePressureSections } from './bilge-pressure.js';
import type { HullMemory } from './memory.js';
import type { HullMesh, Vec3 } from './wetted.js';

/** A thin rectangular plate along the hull's x axis, below the mean waterline on its side. */
export interface HullBilgeKeel {
  /** Midpoint of the root in hull coordinates, metres. */
  readonly root: Vec3;
  /** Offset from the root to the tip in the cross section's y and z coordinates, metres. */
  readonly span: readonly [number, number];
  /** Plate length along the hull's x axis, metres. */
  readonly length: number;
  /** Roll frequency in rad/s when imposed externally. Default the hull's natural small-amplitude roll frequency. */
  readonly rollFrequency?: number;
}

export interface RollKeel extends HullBilgeKeel {
  readonly arm: number;
  readonly breadth: number;
  readonly velocityFactor: number;
  readonly pressure: readonly (BilgePressureSection | null)[];
}

export function validateBilgeKeels(keels: readonly HullBilgeKeel[]): void {
  if (!Array.isArray(keels)) throw new MargoError('state', 'Use an array of bilge keel plates on the hull.');
  for (const keel of keels) {
    const { root, span, length, rollFrequency } = keel ?? ({} as HullBilgeKeel);
    const breadth = span?.length === 2 ? hypot(span[0], span[1]) : 0;
    if (
      root?.length !== 3 ||
      span?.length !== 2 ||
      !root.every(Number.isFinite) ||
      !span.every(Number.isFinite) ||
      !(breadth > 0 && Number.isFinite(breadth)) ||
      !(length > 0 && Number.isFinite(length)) ||
      (rollFrequency !== undefined && !(rollFrequency > 0 && Number.isFinite(rollFrequency)))
    )
      throw new MargoError(
        'state',
        'A bilge keel has invalid dimensions or roll frequency. Use a finite root, a nonzero finite span, a positive length and an optional positive frequency.',
      );
  }
}

export function rollKeelsOf(
  keels: readonly HullBilgeKeel[],
  centre: Vec3,
  memory: HullMemory,
  mesh: HullMesh,
): readonly RollKeel[] {
  return keels.map((keel) => {
    const { root, span } = keel;
    const breadth = hypot(span[0], span[1]);
    const arm = ((root[1] - centre[1]) * span[0] + (root[2] - centre[2]) * span[1]) / breadth;
    const x = root[0] - centre[0];
    let nearest = memory.strips[0];
    for (const strip of memory.strips) {
      if (nearest && Math.abs(strip.x - x) < Math.abs(nearest.x - x)) nearest = strip;
    }
    const sigma = nearest ? memory.stripForms[nearest.form]!.lewis.sigma : 0;
    return {
      ...keel,
      breadth,
      arm,
      velocityFactor: 1 + 0.3 * exp(-160 * (1 - sigma)),
      pressure: bilgePressureSections(mesh, root, keel.length, centre),
    };
  });
}

function wetInterval(rootDepth: number, tipDepth: number): readonly [number, number] {
  if (rootDepth <= 0 && tipDepth <= 0) return [0, 0];
  if (rootDepth >= 0 && tipDepth >= 0) return [0, 1];
  const intersection = rootDepth / (rootDepth - tipDepth);
  return rootDepth > 0 ? [0, intersection] : [intersection, 1];
}

function normalDrag(kc: number): number {
  if (kc >= 4) return 22.5 / kc + 2.4;
  // Wassermann et al. (2016), Eq. 12. Below the measured range retain its value at the low endpoint.
  const log = ln(Math.max(0.3, kc));
  const small = (0.47 * log - 4.94) * log + 13.75;
  if (kc <= 3) return small;
  // Match Ikeda without a jump in drag or its slope at the start of his applicable range.
  const s = kc - 3;
  return small + s * s * (3 - 2 * s) * (22.5 / kc + 2.4 - small);
}

/**
 * Ikeda's bilge-keel normal force and Jones's forward lift (ITTC 2024, 48, 50–51 and 58–59).
 * The coefficient multiplies roll rate, for the same held implicit drag impulse as the hull's other viscous terms.
 */
export function bilgeKeelDamping(
  keels: readonly RollKeel[],
  rate: number,
  angle: number,
  natural: number,
  density: number,
  courseSpeed: number,
  centre: Vec3,
  depthAt: (point: Vec3) => number,
): number {
  const speed = Math.abs(rate);
  if (speed === 0) return 0;
  let damping = 0;
  for (const keel of keels) {
    const { root, span, breadth, length, velocityFactor, pressure } = keel;
    const arm = Math.abs(keel.arm);
    const frequency = keel.rollFrequency ?? natural;
    const amplitude = frequency > 0 ? hypot(angle, speed / frequency) : Math.abs(angle);
    const excursion = Math.PI * arm * amplitude * velocityFactor;
    const offset = length / (2 * Math.sqrt(3));
    for (const [i, x] of [root[0] - offset, root[0] + offset].entries()) {
      const [start, finish] = wetInterval(
        depthAt([x, root[1], root[2]]),
        depthAt([x, root[1] + span[0], root[2] + span[1]]),
      );
      const wetBreadth = breadth * (finish - start);
      if (wetBreadth === 0) continue;
      const kc = excursion / wetBreadth;
      const cd = normalDrag(kc);
      const flow = velocityFactor * arm;
      const station = pressure[i];
      const suction = 0.3 * excursion + 1.95 * wetBreadth;
      const pressureArm = station
        ? Math.sign(rate) * bilgePressureMoment(station, x, centre, rate > 0, suction, cd, depthAt)
        : 0;
      // The closure transfers pressure across the station, with zero net propulsion from passive roll.
      const momentArm = Math.max(0, wetBreadth * cd * arm + pressureArm);
      damping += 0.25 * density * length * momentArm * flow * flow * speed;
      if (courseSpeed > 0) {
        const liftArm = Math.abs(keel.arm + 0.5 * breadth * (start + finish));
        const crossSpeed = liftArm * speed;
        const relative = hypot(courseSpeed, crossSpeed);
        const attack = atan2(crossSpeed, courseSpeed);
        const normalLift = 0.25 * Math.PI * density * wetBreadth * wetBreadth * attack * courseSpeed * relative;
        damping += (normalLift * liftArm) / speed;
      }
    }
  }
  return damping;
}

/** Add the normal virtual mass of the wetted plates to the hull-frame six-axis inertia. */
export function addBilgeKeelInertia(
  matrix: Float64Array,
  keels: readonly RollKeel[],
  rate: number,
  angle: number,
  natural: number,
  density: number,
  centre: Vec3,
  depthAt: (point: Vec3) => number,
): void {
  for (const keel of keels) {
    const { root, span, length, breadth, velocityFactor } = keel;
    const frequency = keel.rollFrequency ?? natural;
    const amplitude = frequency > 0 ? hypot(angle, rate / frequency) : Math.abs(angle);
    const travel = 2 * Math.PI * Math.abs(keel.arm) * amplitude * velocityFactor;
    const offset = length / (2 * Math.sqrt(3));
    const ny = span[1] / breadth;
    const nz = -span[0] / breadth;
    for (const x of [root[0] - offset, root[0] + offset]) {
      const [start, finish] = wetInterval(
        depthAt([x, root[1], root[2]]),
        depthAt([x, root[1] + span[0], root[2] + span[1]]),
      );
      const width = breadth * (finish - start);
      if (width === 0) continue;
      // Sarpkaya and O'Keefe (1996), Figure 2. K = Um T / b, twice the drag model's KC.
      const samples = pow(Math.min(30, travel / width) / 10.1969, 2.1764);
      const cm = 1.12 + (3.3528 * samples) / (1 + samples);
      const mass = (Math.PI * density * width * width * length * cm) / 8;
      const middle = (start + finish) / 2;
      const rx = x - centre[0];
      const ry = root[1] + middle * span[0] - centre[1];
      const rz = root[2] + middle * span[1] - centre[2];
      const jacobian = [0, ny, nz, ry * nz - rz * ny, -rx * nz, rx * ny];
      for (let i = 1; i < 6; i++) {
        for (let j = 1; j < 6; j++) matrix[6 * i + j]! += mass * jacobian[i]! * jacobian[j]!;
      }
    }
  }
}
