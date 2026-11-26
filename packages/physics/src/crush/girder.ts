import { MargoError } from '@margoengine/math/errors';
import { positive } from './material.js';

/** One load-shortening measurement or constitutive breakpoint for a girder element. */
export interface GirderSample {
  /** Axial strain, with compression negative and tension positive. */
  readonly strain: number;
  /** Axial stress in pascals, with the same sign convention. */
  readonly stress: number;
}

/** One plate strip or stiffener in a cross section perpendicular to the girder. */
export interface GirderFiber {
  /** Signed distance to the section's reference line, m. */
  readonly offset: number;
  /** Cross-sectional area, m². */
  readonly area: number;
  /** Ordered stress–strain points including the unloaded origin. End stresses extend as plateaus. */
  readonly curve: readonly GirderSample[];
}

/** Axial balance and continuation inputs for a bent section. */
export interface GirderLoading {
  /** Total axial force, N. Default 0 for pure bending. */
  readonly axialForce?: number;
  /** Reference strain of the preceding increment. Default 0. */
  readonly previousStrain?: number;
}

/** Equilibrium of one girder cross section at imposed bending curvature. */
export interface GirderResponse {
  /** The adjusted axial strain at the reference line. */
  readonly referenceStrain: number;
  /** Signed neutral-axis offset, m, or undefined at zero curvature. */
  readonly neutralAxis?: number;
  /** Net axial force, N. */
  readonly axialForce: number;
  /** Bending moment about the reference line, N m. */
  readonly bendingMoment: number;
  /** Axial force derivative with respect to reference strain, N. Zero on a plastic plateau. */
  readonly axialStiffness: number;
  /** Computed strain and stress for every element, in the same order as the input. */
  readonly fibers: readonly GirderSample[];
}

interface Breakpoint {
  readonly strain: number;
  readonly slopeChange: number;
}

function stressAt(curve: readonly GirderSample[], strain: number): number {
  let a = curve[0]!;
  if (strain <= a.strain) return a.stress;
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i]!;
    if (strain <= b.strain) {
      const section = (strain - a.strain) / (b.strain - a.strain); // float division: linear branch interpolation
      return a.stress + section * (b.stress - a.stress);
    }
    a = b;
  }
  return a.stress;
}

function breakpoints(fiber: GirderFiber, curvature: number, output: Breakpoint[]): number {
  const { offset, curve } = fiber;
  const area = positive(fiber.area, 'girder fiber area');
  const strainOffset = curvature * offset;
  if (!Number.isFinite(strainOffset) || curve.length < 2 || !curve.some((p) => p.strain === 0 && p.stress === 0))
    throw new MargoError(
      'state',
      'Choose finite girder offsets and curves with at least two points including zero strain and stress.',
    );
  let before = 0;
  for (let i = 0; i < curve.length; i++) {
    const { strain, stress } = curve[i]!;
    const next = curve[i + 1];
    const start = strain - strainOffset;
    const force = area * stress;
    if (!Number.isFinite(start) || !Number.isFinite(force) || strain * stress < 0 || (next && next.strain <= strain))
      throw new MargoError(
        'state',
        'Give girder samples in strictly increasing finite strain order with stress of the same sign.',
      );
    const after = next ? (area * (next.stress - stress)) / (next.strain - strain) : 0; // float division
    if (!Number.isFinite(after))
      throw new MargoError('state', 'Choose girder stresses and strain spacing with a finite tangent.');
    output.push({ strain: start, slopeChange: after - before });
    before = after;
  }
  return area * curve[0]!.stress;
}

function balance(
  events: Breakpoint[],
  initial: number,
  target: number,
  previous: number,
): { strain: number; stiffness: number } | undefined {
  events.sort((a, b) => a.strain - b.strain);
  let force = initial;
  let tangent = 0;
  let scale = 0;
  const span = events.at(-1)!.strain - events[0]!.strain;
  let best: { strain: number; stiffness: number } | undefined;
  let i = 0;
  while (i < events.length) {
    const left = events[i]!.strain;
    do {
      const change = events[i]!.slopeChange;
      tangent += change;
      scale += Math.abs(change);
      i++;
    } while (i < events.length && events[i]!.strain === left);
    if (i === events.length) break;
    const right = events[i]!.strain;
    const end = force + tangent * (right - left);
    if (!Number.isFinite(end) || !Number.isFinite(scale))
      throw new MargoError(
        'state',
        'Choose girder geometry and curves with a representable section force and tangent.',
      );
    const roundoff = scale * Number.EPSILON * events.length;
    const forceRoundoff = (Math.abs(initial) + Math.abs(target)) * Number.EPSILON * events.length + roundoff * span;
    if (!Number.isFinite(forceRoundoff))
      throw new MargoError('state', 'Use smaller strain spans and stresses for the girder balance.');
    if (tangent > roundoff && target >= force - forceRoundoff && target <= end + forceRoundoff) {
      const strain = Math.max(left, Math.min(right, left + (target - force) / tangent)); // float division
      if (!best || Math.abs(strain - previous) < Math.abs(best.strain - previous))
        best = { strain, stiffness: tangent };
    } else if (Math.abs(tangent) <= roundoff && Math.abs(target - force) <= forceRoundoff) {
      const strain = Math.max(left, Math.min(right, previous));
      if (!best || Math.abs(strain - previous) < Math.abs(best.strain - previous)) best = { strain, stiffness: 0 };
    }
    force = end;
  }
  return best;
}

/**
 * Resolves a Smith-method section at one imposed curvature by balancing the axial forces on all elements.
 * If softening gives multiple stable equilibria, continues from the nearest prior reference strain.
 * Returns undefined if the section cannot support the prescribed axial force at that curvature.
 */
export function resolveGirder(
  fibers: readonly GirderFiber[],
  curvature: number,
  { axialForce = 0, previousStrain = 0 }: GirderLoading = {},
): GirderResponse | undefined {
  if (
    fibers.length < 2 ||
    !Number.isFinite(curvature) ||
    !Number.isFinite(axialForce) ||
    !Number.isFinite(previousStrain)
  )
    throw new MargoError(
      'state',
      'Pass two or more girder fibers, a finite curvature, axial force and previous strain.',
    );
  const events: Breakpoint[] = [];
  const initial = fibers.reduce((sum, fiber) => sum + breakpoints(fiber, curvature, events), 0);
  if (!Number.isFinite(initial))
    throw new MargoError('state', 'Choose girder areas and stresses with a finite total force.');
  const reference = balance(events, initial, axialForce, previousStrain);
  if (!reference) return undefined;
  let force = 0;
  let moment = 0;
  const states = fibers.map(({ area, curve, offset }) => {
    const strain = reference.strain + curvature * offset;
    const stress = stressAt(curve, strain);
    const load = area * stress;
    force += load;
    moment += load * offset;
    return { strain, stress };
  });
  if (!Number.isFinite(force) || !Number.isFinite(moment))
    throw new MargoError('state', 'Choose girder geometry and stresses with a representable force and moment.');
  const neutralAxis = curvature === 0 ? undefined : -reference.strain / curvature; // float division: zero-strain offset
  if (neutralAxis !== undefined && !Number.isFinite(neutralAxis))
    throw new MargoError(
      'state',
      'Use a representable combination of curvature and axial load to locate the neutral axis.',
    );
  return {
    referenceStrain: reference.strain,
    neutralAxis,
    axialForce: force,
    bendingMoment: moment,
    axialStiffness: reference.stiffness,
    fibers: states,
  };
}
