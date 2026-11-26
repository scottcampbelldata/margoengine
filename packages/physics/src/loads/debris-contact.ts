import { cos, sin } from '@margoengine/math/pinned';
import { add, cross, dot, scale, sub } from '@margoengine/math/vec3';
import { BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import { invalidLoad } from './errors.js';

type Vector = readonly [number, number, number];

/** Inputs for the first compressive pulse of a floating log striking a floodplain structure. */
export interface WoodyDebrisImpactInput {
  /** Contact point closing speed along the normal, in m/s. Zero or negative means no impact. */
  readonly closingSpeed: number;
  /** Relative normal velocity change per unit point impulse, including rotation of both bodies, in 1/kg. */
  readonly inverseEffectiveMass: number;
  /** Wood contact stiffness, in N/m. Defaults to Haehnel and Daly's 2.4 MN/m upper-envelope estimate. */
  readonly woodStiffness?: number;
  /** Structure stiffness along the contact normal, in N/m. Defaults to a rigid support. */
  readonly structureStiffness?: number;
  /** Normal release speed divided by closing speed. Defaults to 1, the undamped elastic model. */
  readonly restitution?: number;
}

/** The load pulse and its mechanical budget for one contact. */
export interface WoodyDebrisImpact {
  /** Peak normal force, in N. */
  readonly peakForce: number;
  /** Time to peak force, in seconds. */
  readonly timeToPeak: number;
  /** Time from first contact to release, in seconds. */
  readonly duration: number;
  /** Total normal impulse over the pulse, in N s. */
  readonly normalImpulse: number;
  /** Energy lost during release, in J. Zero for the original elastic model. */
  readonly dissipatedEnergy: number;
}

/** Linear contact stiffness of Haehnel and Daly (2004), DOI 10.1061/(ASCE)0733-9429(2004)130:2(112). */
export function woodyDebrisImpact(input: WoodyDebrisImpactInput): WoodyDebrisImpact | undefined {
  const {
    closingSpeed,
    inverseEffectiveMass,
    woodStiffness = 2.4e6,
    structureStiffness = Infinity,
    restitution = 1,
  } = input;
  if (!Number.isFinite(closingSpeed) || !(inverseEffectiveMass > 0 && Number.isFinite(inverseEffectiveMass)))
    throw invalidLoad('Provide a finite woody debris closing speed and a positive finite inverse effective mass.');
  if (!(woodStiffness > 0 && Number.isFinite(woodStiffness) && structureStiffness > 0))
    throw invalidLoad(
      'Use a positive finite wood stiffness and a positive structure stiffness or Infinity for a rigid support.',
    );
  if (!(restitution >= 0 && restitution <= 1)) throw invalidLoad('Choose a woody debris restitution between 0 and 1.');
  if (closingSpeed <= 0) return undefined;

  const soft = Math.min(woodStiffness, structureStiffness);
  const stiffness = soft / (1 + soft / Math.max(woodStiffness, structureStiffness));
  const timeToPeak = Math.PI / (2 * Math.sqrt(stiffness) * Math.sqrt(inverseEffectiveMass));
  const compressionImpulse = closingSpeed / inverseEffectiveMass;
  const peakForce = (Math.PI / 2) * (compressionImpulse / timeToPeak);
  // The recovery spring carries the peak force over e times the compression time. Its area gives e times the
  // closing momentum and its recovered energy is e squared times the incident normal-mode energy.
  const duration = timeToPeak * (1 + restitution);
  const normalImpulse = compressionImpulse * (1 + restitution);
  const dissipatedEnergy = 0.5 * (compressionImpulse * (1 - restitution)) * (closingSpeed * (1 + restitution));
  if (
    !(timeToPeak > 0 && peakForce > 0 && normalImpulse > 0) ||
    ![duration, normalImpulse, peakForce, dissipatedEnergy].every(Number.isFinite)
  )
    throw invalidLoad('Choose woody debris masses, speeds, and stiffnesses whose pulse fits in finite SI values.');
  return { peakForce, timeToPeak, duration, normalImpulse, dissipatedEnergy };
}

/** Sample the positive normal load and the impulse elapsed since first contact. */
export function sampleWoodyDebrisImpact(
  impact: WoodyDebrisImpact,
  elapsed: number,
): { readonly force: number; readonly impulse: number } {
  if (!Number.isFinite(elapsed)) throw invalidLoad('Provide a finite elapsed time for the woody debris contact pulse.');
  const { duration, timeToPeak, peakForce, normalImpulse } = impact;
  if (elapsed <= 0) return { force: 0, impulse: 0 };
  if (elapsed >= duration) return { force: 0, impulse: normalImpulse };
  const compressionImpulse = normalImpulse * (timeToPeak / duration);
  if (elapsed <= timeToPeak) {
    const phase = (Math.PI / 2) * (elapsed / timeToPeak);
    const half = sin(phase / 2);
    return { force: peakForce * sin(phase), impulse: compressionImpulse * (2 * half * half) };
  }
  const phase = (Math.PI / 2) * ((elapsed - timeToPeak) / (duration - timeToPeak));
  return {
    force: peakForce * cos(phase),
    impulse: compressionImpulse + (normalImpulse - compressionImpulse) * sin(phase),
  };
}

/** A first crossing of a registered debris/support contact, with positions in the rigid body's port cell. */
export interface WoodyDebrisContact extends Omit<WoodyDebrisImpactInput, 'closingSpeed' | 'inverseEffectiveMass'> {
  /** Rigid row for the debris. */
  readonly debrisRow: number;
  /** Rigid row for the support, which can be fixed or moving. */
  readonly supportRow: number;
  /** The shared point of contact in world axes, in m. */
  readonly point: Vector;
  /** Unit vector from the support towards the debris. */
  readonly normal: Vector;
}

function contactBody(bodies: Float32Array, impulses: Float64Array, row: number, point: Vector, normal: Vector) {
  const offset = row * BODY_WORDS;
  if (!(bodies[offset + 3] || bodies[offset + 4] || bodies[offset + 5] || bodies[offset + 6]))
    throw invalidLoad('Choose live body rows in the rigid port for the woody debris contact.');
  const inverseMass = bodies[offset + 16]!;
  const xx = bodies[offset + 17]!;
  const xy = bodies[offset + 18]!;
  const xz = bodies[offset + 19]!;
  const yy = bodies[offset + 20]!;
  const yz = bodies[offset + 21]!;
  const zz = bodies[offset + 22]!;
  const inverseInertia = ([x, y, z]: Vector): Vector => [
    xx * x + xy * y + xz * z,
    xy * x + yy * y + yz * z,
    xz * x + yz * y + zz * z,
  ];
  const arm = sub(point, bodies.subarray(offset + 7, offset + 10));
  const linear = add(
    bodies.subarray(offset + 10, offset + 13),
    scale(impulses.subarray(row * IMPULSE_WORDS, row * IMPULSE_WORDS + 3), inverseMass),
  );
  const angular = add(
    bodies.subarray(offset + 13, offset + 16),
    inverseInertia([
      impulses[row * IMPULSE_WORDS + 3]!,
      impulses[row * IMPULSE_WORDS + 4]!,
      impulses[row * IMPULSE_WORDS + 5]!,
    ]),
  );
  const moment = cross(arm, normal);
  return {
    arm,
    velocity: dot(add(linear, cross(angular, arm)), normal),
    inverseMass: inverseMass + dot(moment, inverseInertia(moment)),
  };
}

/**
 * Stage one normal impact into layout-2 rigid body state and its layout-1 f64 impulse contribution.
 * Use only for an explicitly paired contact whose native rigid collision is filtered out, once at the first crossing.
 * The caller supplies the crossing point and handles tangential contacts or resting support separately.
 */
export function accumulateFilteredWoodyContact(
  bodies: Float32Array,
  impulses: Float64Array,
  contact: WoodyDebrisContact,
): WoodyDebrisImpact | undefined {
  const { debrisRow, supportRow, point, normal } = contact;
  const rows = bodies.length / BODY_WORDS;
  if (
    !Number.isInteger(rows) ||
    impulses.length !== rows * IMPULSE_WORDS ||
    !Number.isSafeInteger(debrisRow) ||
    !Number.isSafeInteger(supportRow) ||
    debrisRow < 0 ||
    supportRow < 0 ||
    debrisRow >= rows ||
    supportRow >= rows ||
    debrisRow === supportRow
  )
    throw invalidLoad('Use matching rigid body and impulse ports and two distinct woody debris contact rows.');
  const normSquared = dot(normal, normal);
  if (!point.every(Number.isFinite) || !(Math.abs(normSquared - 1) <= 1e-6))
    throw invalidLoad('Provide a finite woody debris contact point and a unit normal from the support to the debris.');
  const axis = scale(normal, 1 / Math.sqrt(normSquared));
  const debris = contactBody(bodies, impulses, debrisRow, point, axis);
  const support = contactBody(bodies, impulses, supportRow, point, axis);
  const impact = woodyDebrisImpact({
    ...contact,
    closingSpeed: support.velocity - debris.velocity,
    inverseEffectiveMass: debris.inverseMass + support.inverseMass,
  });
  if (!impact) return undefined;
  const impulse = scale(axis, impact.normalImpulse);
  const reacted = scale(impulse, -1);
  const debrisDelta = [...impulse, ...cross(debris.arm, impulse)];
  const supportDelta = [...reacted, ...cross(support.arm, reacted)];
  const debrisOffset = debrisRow * IMPULSE_WORDS;
  const supportOffset = supportRow * IMPULSE_WORDS;
  const debrisNext = debrisDelta.map((word, i) => word + impulses[debrisOffset + i]!);
  const supportNext = supportDelta.map((word, i) => word + impulses[supportOffset + i]!);
  if (!debrisNext.every(Number.isFinite) || !supportNext.every(Number.isFinite))
    throw invalidLoad('Use woody debris contact points and velocities whose linear and angular impulses are finite.');
  impulses.set(debrisNext, debrisOffset);
  impulses.set(supportNext, supportOffset);
  return impact;
}
