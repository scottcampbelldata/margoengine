import { MargoError } from '@margoengine/math/errors';
import { hypot } from '@margoengine/math/pinned';

type Vec3 = readonly [number, number, number];
type Symmetric3 = readonly [number, number, number, number, number, number];

/** Wet footprint entry. Weight is the relative overlap; x and z are cell centres in metres. */
export interface FloodBlockageCell {
  readonly index: number;
  readonly weight: number;
  readonly x: number;
  readonly z: number;
  readonly depth: number;
  readonly dischargeX: number;
  readonly dischargeZ: number;
}

/**
 * A rigid body in a flood: centre, linear and angular velocity, inverse mass, optional per-axis inverse mass and
 * the inverse inertia in port order xx, xy, xz, yy, yz, zz.
 */
export interface FloodBlockageBody {
  readonly centre: Vec3;
  readonly velocity: Vec3;
  readonly angularVelocity: Vec3;
  readonly inverseMass: number;
  /** World-axis inverse mass including locked translations. Defaults to the scalar mass on every axis. */
  readonly effectiveInverseMass?: Vec3;
  /** Rigid body port order xx, xy, xz, yy, yz, zz. */
  readonly inverseInertia: Symmetric3;
}

/**
 * Inputs for a flood blockage exchange: the water cells, the body, cell area, water density, interval, drag
 * coefficient, wetted area in m² and the elevation in m of the exchange.
 */
export interface FloodBlockageInput {
  readonly cells: readonly FloodBlockageCell[];
  readonly body: FloodBlockageBody;
  readonly cellArea: number;
  readonly density: number;
  readonly interval: number;
  readonly dragCoefficient: number;
  /** Wetted silhouette in m², optionally evaluated at the initial relative velocity in m/s. */
  readonly wetArea: number | ((relativeX: number, relativeZ: number) => number);
  /** Elevation (m) of the representative horizontal exchange. */
  readonly elevation: number;
}

/**
 * Result of a flood blockage exchange: the world impulse on the body, the impulse on each cell and the kinetic
 * energy dissipated in joules.
 */
export interface FloodBlockageExchange {
  /** World linear and angular impulse about the body centre, N·s and N·m·s. */
  readonly bodyImpulse: readonly [number, number, number, number, number, number];
  /** Cell index, x impulse and z impulse, both N·s. No volume is transferred. */
  readonly cellImpulses: ReadonlyArray<readonly [number, number, number]>;
  /** Loss of coupled kinetic energy in this drag exchange (J). */
  readonly dissipatedEnergy: number;
}

const EMPTY: FloodBlockageExchange = Object.freeze({
  bodyImpulse: Object.freeze([0, 0, 0, 0, 0, 0] as const),
  cellImpulses: Object.freeze([]),
  dissipatedEnergy: 0,
});

function invalid(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#hydrodynamic-loads`);
}

const finitePositive = (value: number) => value > 0 && Number.isFinite(value);
const finiteNonnegative = (value: number) => value >= 0 && Number.isFinite(value);

function inverseTimes(matrix: Symmetric3, vector: Vec3): Vec3 {
  const [xx, xy, xz, yy, yz, zz] = matrix;
  const [x, y, z] = vector;
  return [xx * x + xy * y + xz * z, xy * x + yy * y + yz * z, xz * x + yz * y + zz * z];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * One reciprocal momentum resistance exchange for a wetted body footprint.
 * The Morison drag term uses relative flow at the end of an implicit step.
 * Both samplers use the same weights and the body receives the opposite
 * moment at their barycentre (Sanders, Schubert and Gallegos 2008).
 * The consumer must settle all cell impulses through the same interval.
 */
export function floodBlockageExchange(input: FloodBlockageInput): FloodBlockageExchange {
  const { cells, body, cellArea, density, interval, dragCoefficient, wetArea, elevation } = input;
  const inverseMass = body.effectiveInverseMass ?? [body.inverseMass, body.inverseMass, body.inverseMass];
  if (
    !finitePositive(cellArea) ||
    !finitePositive(density) ||
    !finitePositive(interval) ||
    !finiteNonnegative(dragCoefficient) ||
    (typeof wetArea !== 'function' && !finiteNonnegative(wetArea)) ||
    !Number.isFinite(elevation) ||
    !finiteNonnegative(body.inverseMass) ||
    !inverseMass.every(finiteNonnegative) ||
    ![...body.centre, ...body.velocity, ...body.angularVelocity, ...body.inverseInertia].every(Number.isFinite)
  )
    throw invalid('Invalid flood drag parameters; use finite SI quantities, positive cell area, density and interval.');
  if (wetArea === 0 || dragCoefficient === 0 || cells.length === 0) return EMPTY;

  let totalWeight = 0;
  const indices = new Set<number>();
  for (const cell of cells) {
    if (
      !Number.isSafeInteger(cell.index) ||
      cell.index < 0 ||
      !finitePositive(cell.weight) ||
      !finitePositive(cell.depth) ||
      ![cell.x, cell.z, cell.dischargeX, cell.dischargeZ].every(Number.isFinite) ||
      indices.has(cell.index)
    )
      throw invalid('Invalid flood overlap; pass one entry per wet cell with positive weight and depth.');
    indices.add(cell.index);
    totalWeight += cell.weight;
  }
  if (!finitePositive(totalWeight)) throw invalid('Flood overlap overflowed; rescale the footprint weights.');
  const densityArea = density * cellArea;
  let inverseWaterMass = 0;
  let x = 0;
  let z = 0;
  let wx = 0;
  let wz = 0;
  for (const cell of cells) {
    const share = cell.weight / totalWeight;
    inverseWaterMass += (share * share) / (densityArea * cell.depth);
    x += share * cell.x;
    z += share * cell.z;
    wx += (share * cell.dischargeX) / cell.depth;
    wz += (share * cell.dischargeZ) / cell.depth;
  }
  const [cx, cy, cz] = body.centre;
  const rx = x - cx;
  const ry = elevation - cy;
  const rz = z - cz;
  const [omegaX, omegaY, omegaZ] = body.angularVelocity;
  wx -= body.velocity[0] + omegaY * rz - omegaZ * ry;
  wz -= body.velocity[2] + omegaX * ry - omegaY * rx;
  const speed = hypot(wx, wz);
  if (speed === 0) return EMPTY;
  const area = typeof wetArea === 'function' ? wetArea(wx, wz) : wetArea;
  if (!finiteNonnegative(area)) throw invalid('Choose a projected wet area within the finite drag range.');
  if (area === 0) return EMPTY;

  const torqueX: Vec3 = [0, rz, -ry];
  const torqueZ: Vec3 = [ry, -rx, 0];
  const invTorqueX = inverseTimes(body.inverseInertia, torqueX);
  const invTorqueZ = inverseTimes(body.inverseInertia, torqueZ);
  const rotationX = dot(torqueX, invTorqueX);
  const rotationZ = dot(torqueZ, invTorqueZ);
  const massX = inverseMass[0] + inverseWaterMass;
  const massZ = inverseMass[2] + inverseWaterMass;
  const kxx = massX + rotationX;
  const kxz = dot(torqueX, invTorqueZ);
  const kzz = massZ + rotationZ;
  const drag = 0.5 * density * dragCoefficient * area * interval;
  if (
    ![speed, kxx, kxz, kzz, drag].every(Number.isFinite) ||
    !(massX > 0 && massZ > 0 && rotationX >= 0 && rotationZ >= 0 && kzz - (kxz / kxx) * kxz > 0)
  )
    throw invalid(
      'Invalid flood drag mass metric; use positive water mass and a positive semidefinite inverse inertia.',
    );
  if (drag === 0) return EMPTY;

  // J = drag |w'| w' and w' = w - KJ. The mapped speed decreases
  // monotonically with the trial speed, making the scalar root unique.
  // Normalize the 2×2 system even in the stiff limit.
  const evaluate = (trial: number): readonly [number, number, number] => {
    const resistance = 1 / (drag * trial);
    if (!Number.isFinite(resistance)) return [0, 0, speed];
    const scale = Math.max(resistance, kxx, kzz);
    const r = resistance / scale;
    const xx = kxx / scale + r;
    const xz = kxz / scale;
    const zz = kzz / scale + r;
    const z = (wz - (xz / xx) * wx) / (zz - (xz / xx) * xz);
    const x = (wx - xz * z) / xx;
    return [x / scale, z / scale, r * hypot(x, z)];
  };
  let lower = 0;
  let upper = speed;
  for (let iteration = 0; iteration < 52; iteration++) {
    const guess = 0.5 * (lower + upper);
    if (evaluate(guess)[2] > guess) lower = guess;
    else upper = guess;
  }
  const [jx, jz] = evaluate(upper);
  const changeX = kxx * jx + kxz * jz;
  const changeZ = kxz * jx + kzz * jz;
  const dissipatedEnergy = (wx - 0.5 * changeX) * jx + (wz - 0.5 * changeZ) * jz;
  if (![jx, jz, dissipatedEnergy].every(Number.isFinite) || dissipatedEnergy < 0)
    throw invalid('Flood drag exceeded the finite impulse range; check body inertia, projected area and interval.');
  return {
    bodyImpulse: [jx, 0, jz, ry * jz, rz * jx - rx * jz, -ry * jx],
    cellImpulses: cells.map((cell) => {
      const share = cell.weight / totalWeight;
      return [cell.index, -share * jx, -share * jz] as const;
    }),
    dissipatedEnergy,
  };
}
