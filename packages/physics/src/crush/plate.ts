import { MargoError } from '@margoengine/math/errors';
import { cos, hypot, sin } from '@margoengine/math/pinned';
import { positive } from './material.js';

/** Elastic rectangular plate, simply supported with straight edges free of in-plane shear. */
export interface CrushPlate {
  /** Loaded length in metres along local x. */
  readonly length: number;
  /** Transverse width in metres along local y. */
  readonly width: number;
  /** Wall thickness, m. */
  readonly thickness: number;
  /** Young's modulus, Pa. */
  readonly young: number;
  /** Poisson's ratio. Default 0.3. */
  readonly poisson?: number;
  /** Signed initial crest in metres, with the same shape as the first buckling mode. Default 0. */
  readonly initialCrest?: number;
}

/** Pinned plate surface sampled at authored rest-plane coordinates. */
export interface CrushPlateSurface {
  /** Deformed XYZ triples in the plate's frame, m. */
  readonly positions: Float64Array;
  /** Unit normals facing the plate's positive local z. */
  readonly normals: Float64Array;
}

/** Equilibrium of the first elastic buckling mode under an imposed end shortening. */
export interface CrushPlateResponse {
  /** Critical compressive force of the initially flat plate, N. */
  readonly criticalForce: number;
  /** Total compressive force at this shortening, N. */
  readonly force: number;
  /** Number of half-waves along the length. One spans the width. */
  readonly halfWaves: number;
  /** Total signed crest displacement out of the plate's original plane, m. */
  readonly crest: number;
  /** Surface samples when local rest XY coordinates were supplied. */
  readonly surface?: CrushPlateSurface;
}

function firstMode(length: number, width: number): number {
  const aspect = length / width; // float division: continuous lowest half-wave count
  const low = Math.max(1, Math.floor(aspect));
  if (!Number.isSafeInteger(low + 1))
    throw new MargoError('state', 'Choose plate dimensions with a representable number of longitudinal half-waves.');
  const high = low + 1;
  // Compare (q + 1/q)^2 for q = m / aspect. The two are equal when aspect² is low × high.
  return aspect > Math.sqrt(low * high) ? high : low;
}

function modeCrest(initial: number, strain: number, critical: number, stiffness: number): number {
  if (initial === 0) return Math.sqrt(Math.max(0, strain - critical) / stiffness); // float division
  if (strain === 0) return initial;
  let low = initial;
  let high = Math.sqrt(initial * initial + strain / stiffness); // float division: geometric-only shortening bound
  for (let i = 0; i < 52; i++) {
    const middle = low + 0.5 * (high - low);
    const change = (middle - initial) * (middle + initial);
    const shortening = stiffness * change + critical * ((middle - initial) / middle); // float division
    if (shortening < strain) low = middle;
    else high = middle;
  }
  return low + 0.5 * (high - low);
}

function deform(
  points: ArrayLike<number>,
  length: number,
  width: number,
  alpha: number,
  beta: number,
  crest: number,
  stretchX: number,
  stretchY: number,
): CrushPlateSurface {
  if (points.length % 2 !== 0)
    throw new MargoError('state', 'Give the crush plate surface as pairs of rest-plane x and y coordinates.');
  const positions = new Float64Array((points.length / 2) * 3); // float division: pairs in, triples out
  const normals = new Float64Array(positions.length);
  for (let i = 0, j = 0; i < points.length; i += 2, j += 3) {
    const x = points[i]!;
    const y = points[i + 1]!;
    if (!(x >= 0 && x <= length && y >= 0 && y <= width))
      throw new MargoError('state', 'Keep plate rest-plane points inside the authored length and width.');
    const sx = x === 0 || x === length ? 0 : sin(alpha * x);
    const sy = y === 0 || y === width ? 0 : sin(beta * y);
    const dx = (-crest * alpha * cos(alpha * x) * sy) / stretchX; // float division: deformed x coordinate
    const dy = (-crest * beta * sx * cos(beta * y)) / stretchY; // float division: deformed y coordinate
    const inverse = 1 / hypot(dx, dy, 1); // float division: unit normal
    positions[j] = x * stretchX;
    positions[j + 1] = y * stretchY;
    positions[j + 2] = crest * sx * sy;
    normals[j] = dx * inverse;
    normals[j + 1] = dy * inverse;
    normals[j + 2] = inverse;
  }
  return { positions, normals };
}

/** Resolves elastic longitudinal buckling and can sample its deformed surface at flat rest XY coordinates. */
export function resolvePlateBuckling(
  plate: CrushPlate,
  shortening: number,
  rest?: ArrayLike<number>,
): CrushPlateResponse {
  const length = positive(plate.length, 'plate length');
  const width = positive(plate.width, 'plate width');
  const thickness = positive(plate.thickness, 'plate thickness');
  const young = positive(plate.young, 'plate Young’s modulus');
  const poisson = plate.poisson ?? 0.3;
  const initial = plate.initialCrest ?? 0;
  if (!(poisson > -1 && poisson < 0.5) || !Number.isFinite(initial))
    throw new MargoError('state', 'Use a finite plate crest and Poisson’s ratio between −1 and 0.5.');
  const strain = positive(shortening, 'plate shortening', 0, length) / length; // float division
  if (strain === 1) throw new MargoError('state', 'Keep plate shortening below its undeformed length.');

  const halfWaves = firstMode(length, width);
  const alpha = (Math.PI * halfWaves) / length; // float division: wave numbers in radians per metre
  const beta = Math.PI / width; // float division
  const xx = alpha * alpha;
  const yy = beta * beta;
  const bend = (thickness * thickness) / (12 * (1 - poisson * poisson)); // float division: D / Et
  const critical = (bend * (xx + yy) ** 2) / xx; // float division: eigenstrain of the flat plate
  const membrane = (xx * xx + yy * yy) / (16 * xx); // float division: Airy stress projected on the mode
  const axial = xx * 0.125;
  if (!(Number.isFinite(critical) && critical > 0 && Number.isFinite(membrane) && membrane > 0))
    throw new MargoError('state', 'Choose plate dimensions with representable bending and membrane coefficients.');

  const initialAmount = Math.abs(initial);
  const amplitude = modeCrest(initialAmount, strain, critical, axial + membrane);
  const delta = (amplitude - initialAmount) * (amplitude + initialAmount);
  const elastic = strain - axial * delta;
  const force = elastic * young * thickness * width;
  const criticalForce = critical * young * thickness * width;
  const across = 1 + poisson * elastic - yy * 0.125 * delta;
  const crest = initial < 0 ? -amplitude : amplitude;
  if (!(Number.isFinite(force) && Number.isFinite(criticalForce) && Number.isFinite(crest) && across > 0))
    throw new MargoError(
      'state',
      'Choose plate geometry and shortening within the representable elastic buckling range.',
    );
  return {
    criticalForce,
    force,
    halfWaves,
    crest,
    surface: rest && deform(rest, length, width, alpha, beta, crest, 1 - strain, across),
  };
}
