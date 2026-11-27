import { invalidLoad } from './errors.js';
import type { LoadCoupledRadiationProfile } from './radiation-coupled-profile.js';
import { prepareRadiationResonance, type RadiationResonance } from './radiation.js';

type Vector3 = readonly [number, number, number];
type Quaternion = readonly [number, number, number, number];
type Six = readonly [number, number, number, number, number, number];

interface CoupledMode extends RadiationResonance {
  readonly direction: Six;
}

export interface PreparedCoupledRadiation {
  readonly centre: Vector3;
  readonly immersion: number;
  readonly infiniteMass: readonly number[];
  readonly modes: readonly CoupledMode[];
  readonly index: number;
  readonly words: number;
}

interface CoupledWrench {
  readonly force: [number, number, number];
  readonly torque: [number, number, number];
  coupled?: Float64Array;
}

export function prepareCoupledRadiation(
  profile: LoadCoupledRadiationProfile,
  dt: number,
  index: number,
): PreparedCoupledRadiation {
  // One previous quaternion and exposure, then the spring position and momentum of each mode.
  const modes = profile.resonances.map((mode, i) => ({
    ...prepareRadiationResonance({ ...mode, axis: 0 }, dt, index + 5 + 2 * i),
    direction: [...mode.direction] as Six,
  }));
  const maxExposure = 1 / profile.immersion;
  if (
    !profile.infiniteMass.every((value) => Number.isFinite(maxExposure * value)) ||
    !modes.every((mode) => {
      const maxDirection = Math.max(...mode.direction.map(Math.abs));
      const stepDirection = dt * maxDirection;
      return Number.isFinite(maxExposure * mode.strength * stepDirection * stepDirection);
    })
  )
    throw invalidLoad('Coupled radiation exceeds numeric range at full immersion; use physical SI coefficients.');
  return {
    centre: [...profile.centre],
    immersion: profile.immersion,
    infiniteMass: [...profile.infiniteMass],
    modes,
    index,
    words: 5 + 2 * modes.length,
  };
}

function rotation(q: Quaternion): [Vector3, Vector3, Vector3] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

export function validateCoupledCentre(
  profile: PreparedCoupledRadiation,
  q: Quaternion,
  origin: Vector3,
  com: Vector3,
): void {
  const world = rotation(q);
  const centreSize = Math.max(1, ...profile.centre.map(Math.abs));
  for (const [i, axis] of world.entries()) {
    const expected = axis[0] * profile.centre[0] + axis[1] * profile.centre[1] + axis[2] * profile.centre[2];
    // BODIES exports origin, COM and rotation separately as f32. Bound their rounding in local-cell metres.
    const tolerance = (Math.abs(origin[i]!) + Math.abs(com[i]!) + 6 * centreSize) / 8_388_608;
    if (Math.abs(com[i]! - origin[i]! - expected) > tolerance)
      throw invalidLoad('Coupled radiation is referenced to another centre of mass; use the rigid body’s local COM.');
  }
}

function worldDirection(direction: Six, basis: readonly Vector3[]): Six {
  const [x, y, z] = basis as [Vector3, Vector3, Vector3];
  return [
    x[0] * direction[0] + x[1] * direction[1] + x[2] * direction[2],
    y[0] * direction[0] + y[1] * direction[1] + y[2] * direction[2],
    z[0] * direction[0] + z[1] * direction[1] + z[2] * direction[2],
    x[0] * direction[3] + x[1] * direction[4] + x[2] * direction[5],
    y[0] * direction[3] + y[1] * direction[4] + y[2] * direction[5],
    z[0] * direction[3] + z[1] * direction[4] + z[2] * direction[5],
  ];
}

function projection(direction: Six, v: Vector3, w: Vector3): number {
  return (
    direction[0] * v[0] +
    direction[1] * v[1] +
    direction[2] * v[2] +
    direction[3] * w[0] +
    direction[4] * w[1] +
    direction[5] * w[2]
  );
}

/** Congruence by the rotation repeated in both blocks, with no translation of the COM wrench. */
function addWorldMass(matrix: Float64Array, local: readonly number[], basis: readonly Vector3[], scale: number): void {
  for (let i = 0; i < 6; i++) {
    const left = basis[i % 3]!;
    const row = i < 3 ? 0 : 18;
    for (let j = i; j < 6; j++) {
      const right = basis[j % 3]!;
      const column = j < 3 ? 0 : 3;
      let entry = 0;
      for (let k = 0; k < 3; k++)
        for (let l = 0; l < 3; l++) entry += left[k]! * local[row + 6 * k + column + l]! * right[l]!;
      const value = scale * entry;
      matrix[6 * i + j]! += value;
      if (i !== j) matrix[6 * j + i]! += value;
    }
  }
}

/**
 * Rank-one realization of the Cummins memory: reciprocal maps make input power equal to
 * S q u. Backward Euler dissipates S λ q² plus a nonnegative state increment at each tick.
 * The end-of-step acceleration coefficient is positive semidefinite and joins A∞ in the hold.
 */
export function addCoupledRadiation(
  loads: CoupledWrench,
  profile: PreparedCoupledRadiation,
  q: Quaternion,
  v: Vector3,
  w: Vector3,
  wet: number,
  dt: number,
  history: Float64Array,
): void {
  const scale = wet / profile.immersion;
  const exposed = Math.sqrt(scale);
  const { index } = profile;
  const lastExposed = history[index + 4]!;
  const basis = rotation(q);
  const lastBasis =
    lastExposed > 0
      ? rotation([history[index]!, history[index + 1]!, history[index + 2]!, history[index + 3]!])
      : undefined;
  history.set(q, index);
  history[index + 4] = exposed;
  const mass = wet > 0 ? (loads.coupled ??= new Float64Array(36)) : undefined;
  if (mass) addWorldMass(mass, profile.infiniteMass, basis, scale);
  for (const mode of profile.modes) {
    const at = mode.index;
    const lastInput = lastBasis ? lastExposed * projection(worldDirection(mode.direction, lastBasis), v, w) : 0;
    history[at + 1] = mode.inverse * (history[at + 1]! - mode.stiffnessTime * history[at]! + dt * lastInput);
    history[at]! += dt * history[at + 1]!;
    if (!mass) continue;
    const direction = worldDirection(mode.direction, basis);
    const predicted =
      mode.inverse *
      (history[at + 1]! - mode.stiffnessTime * history[at]! + dt * exposed * projection(direction, v, w));
    const wrench = -mode.strength * exposed * predicted;
    const inertia = mode.strength * scale * dt * dt * mode.inverse;
    for (let i = 0; i < 3; i++) {
      loads.force[i]! += wrench * direction[i]!;
      loads.torque[i]! += wrench * direction[i + 3]!;
    }
    for (let i = 0; i < 6; i++) {
      const left = inertia * direction[i]!;
      for (let j = i; j < 6; j++) {
        const value = left * direction[j]!;
        mass[6 * i + j]! += value;
        if (i !== j) mass[6 * j + i]! += value;
      }
    }
  }
}

/** Solve (I + A · dryMobility) held = wrench. Mobility may be singular on locked axes. */
export function holdCoupledRadiation(
  coupled: Float64Array,
  added: Float64Array,
  rotational: Float64Array | undefined,
  inverseMass: number,
  bodies: Float32Array,
  inertia: number,
  wrench: number[],
): number[] {
  const [xx, xy, xz, yy, yz, zz] = bodies.subarray(inertia, inertia + 6);
  const mobility = [xx!, xy!, xz!, xy!, yy!, yz!, xz!, yz!, zz!];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      coupled[6 * i + j]! += added[3 * i + j]!;
      if (rotational) coupled[6 * (i + 3) + (j + 3)]! += rotational[3 * i + j]!;
    }
  }
  const system = new Float64Array(36);
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 3; col++) {
      system[6 * row + col] = (row === col ? 1 : 0) + coupled[6 * row + col]! * inverseMass;
      let angular = row === col + 3 ? 1 : 0;
      for (let k = 0; k < 3; k++) angular += coupled[6 * row + k + 3]! * mobility[3 * k + col]!;
      system[6 * row + col + 3] = angular;
    }
  }
  for (let i = 0; i < 6; i++) {
    let pivot = i;
    for (let k = i + 1; k < 6; k++) {
      if (Math.abs(system[6 * k + i]!) > Math.abs(system[6 * pivot + i]!)) pivot = k;
    }
    for (let j = i; j < 6; j++) {
      const value = system[6 * i + j]!;
      system[6 * i + j] = system[6 * pivot + j]!;
      system[6 * pivot + j] = value;
    }
    const value = wrench[i]!;
    wrench[i] = wrench[pivot]!;
    wrench[pivot] = value;
    const diagonal = system[7 * i]!;
    if (!(Number.isFinite(diagonal) && diagonal !== 0))
      throw invalidLoad('Cannot hold the coupled water wrench; use physical SI inertia and force values.');
    for (let k = i + 1; k < 6; k++) {
      const factor = system[6 * k + i]! / diagonal;
      for (let j = i + 1; j < 6; j++) system[6 * k + j]! -= factor * system[6 * i + j]!;
      wrench[k]! -= factor * wrench[i]!;
    }
  }
  for (let i = 5; i >= 0; i--) {
    for (let k = i + 1; k < 6; k++) wrench[i]! -= system[6 * i + k]! * wrench[k]!;
    wrench[i]! /= system[7 * i]!;
  }
  if (!wrench.every(Number.isFinite))
    throw invalidLoad('Coupled water inertia exceeds numeric range; use physical SI inertia and force values.');
  return wrench;
}
