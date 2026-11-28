import { stillWaterline } from '../seakeeping/memory.js';
import { bakeHullPanels, type HullPanelOptions, type HullPanelResponse } from '../seakeeping/panels.js';
import { SEA_WATER, type HullMesh, type Vec3 } from '../seakeeping/wetted.js';
import { invalidLoad } from './errors.js';
import { equivalentEllipsoid } from './shapes.js';

/** A rank-one passive mode in hull coordinates, in the panel response's motion order. */
export interface LoadCoupledRadiationResonance {
  /** Projection of a rigid twist onto the mode. The angular words are in metres. */
  readonly direction: readonly [number, number, number, number, number, number];
  /** Natural angular frequency in rad/s. */
  readonly frequency: number;
  /** Decay coefficient in inverse seconds. */
  readonly decayRate: number;
  /** Positive kernel amplitude in N/m at the reference immersion. */
  readonly strength: number;
}

/**
 * Options for building a coupled radiation profile: mass in kg, optional centre of mass, water density (default
 * 1025 or the panel response's), panel inputs or a baked response, and the number of resonant poles kept
 * (default 12).
 */
export interface LoadCoupledRadiationProfileOptions {
  /** Mass afloat, kg. This must give a partly submerged upright hull. */
  readonly mass: number;
  /** Rigid centre of mass in hull coordinates. Defaults to the closed hull's centroid. */
  readonly centre?: Vec3;
  /** Water density in kg/m³. Defaults to the panel response's density or 1025. */
  readonly density?: number;
  /** Panel inputs or a panel response already baked at the same waterline, centre and density. */
  readonly panels: Pick<HullPanelOptions, 'frequencies' | 'depth' | 'gravity'> | HullPanelResponse;
  /** Maximum number of shared resonant poles retained, default 12. Each may have several independent directions. */
  readonly poles?: number;
  readonly signal?: AbortSignal;
}

/** Residual of the complex impedance fit to the sampled panel frequencies. */
export interface LoadCoupledRadiationFit {
  readonly range: readonly [number, number];
  readonly normalizedRmsError: number;
  readonly normalizedMaxError: number;
  /** Largest negative eigenvalue magnitude of the reference damping, scaled to translational units, N s/m. */
  readonly sourceNegativeDamping: number;
}

/**
 * A hull's coupled radiation response: centre of mass, water density in kg/m³, waterline, draft, immersion, the
 * 6x6 infinite-frequency added inertia and the resonances.
 */
export interface LoadCoupledRadiationProfile {
  /** Rigid centre of mass in hull coordinates, metres. */
  readonly centre: Vec3;
  /** Reference water density in kg/m³. Use this density on the receiving body. */
  readonly density: number;
  /** Still-water level in hull coordinates, metres. */
  readonly waterline: number;
  /** Reference waterline above the keel, metres. */
  readonly draft: number;
  /** Fraction of hull volume below this waterline. Both mass and radiation coefficients are evaluated here. */
  readonly immersion: number;
  /** SI row-major 6×6 instantaneous added inertia, about the centre, at the reference draft. */
  readonly infiniteMass: readonly number[];
  readonly resonances: readonly LoadCoupledRadiationResonance[];
}

const AXES = 6;
const WORDS = AXES * AXES;
const EPSILON = 64 * Number.EPSILON;
type Matrix = Float64Array;

interface PositivePart {
  readonly matrix: Matrix;
  readonly eigenvalues: Float64Array;
  readonly directions: Float64Array;
  readonly negative: number;
}

function norm(matrix: Matrix): number {
  let maximum = 0;
  for (const entry of matrix) maximum = Math.max(maximum, Math.abs(entry));
  return maximum;
}

/** Jacobi diagonalization of a real symmetric six-axis matrix. */
function positivePart(input: Matrix): PositivePart {
  const work = input.slice();
  const directions = new Float64Array(WORDS);
  for (let i = 0; i < AXES; i++) directions[i * AXES + i] = 1;
  const bound = EPSILON * norm(work);
  for (let sweep = 0; sweep < 16; sweep++) {
    let changed = false;
    for (let p = 0; p < AXES; p++) {
      for (let q = p + 1; q < AXES; q++) {
        const off = work[p * AXES + q]!;
        if (Math.abs(off) <= bound) continue;
        changed = true;
        const difference = (work[q * AXES + q]! - work[p * AXES + p]!) / 2;
        const ratio = difference / off;
        const tangent = Math.sign(ratio || 1) / (Math.abs(ratio) + Math.sqrt(1 + ratio * ratio));
        const cosine = 1 / Math.sqrt(1 + tangent * tangent);
        const sine = tangent * cosine;
        work[p * AXES + p]! -= tangent * off;
        work[q * AXES + q]! += tangent * off;
        work[p * AXES + q] = work[q * AXES + p] = 0;
        for (let row = 0; row < AXES; row++) {
          if (row !== p && row !== q) {
            const a = work[row * AXES + p]!;
            const b = work[row * AXES + q]!;
            work[row * AXES + p] = work[p * AXES + row] = cosine * a - sine * b;
            work[row * AXES + q] = work[q * AXES + row] = sine * a + cosine * b;
          }
          const x = directions[row * AXES + p]!;
          const y = directions[row * AXES + q]!;
          directions[row * AXES + p] = cosine * x - sine * y;
          directions[row * AXES + q] = sine * x + cosine * y;
        }
      }
    }
    if (!changed) break;
  }
  const matrix = new Float64Array(WORDS);
  const eigenvalues = new Float64Array(AXES);
  let negative = 0;
  for (let axis = 0; axis < AXES; axis++) {
    const eigenvalue = work[axis * AXES + axis]!;
    negative = Math.max(negative, -eigenvalue);
    if (eigenvalue <= bound) continue;
    eigenvalues[axis] = eigenvalue;
    for (let row = 0; row < AXES; row++)
      for (let column = row; column < AXES; column++)
        matrix[row * AXES + column]! += eigenvalue * directions[row * AXES + axis]! * directions[column * AXES + axis]!;
  }
  for (let row = 0; row < AXES; row++)
    for (let column = row + 1; column < AXES; column++) matrix[column * AXES + row] = matrix[row * AXES + column]!;
  return { matrix, eigenvalues, directions, negative };
}

/** Congruence normalizes rotation to a linear velocity before weighing residuals and imposing passivity. */
function normalized(source: ArrayLike<number>, scale: Float64Array): Matrix {
  if (source?.length !== WORDS)
    throw invalidLoad('Provide 36 row-major finite SI entries in each panel radiation matrix.');
  const result = new Float64Array(WORDS);
  for (let row = 0; row < AXES; row++)
    for (let column = row; column < AXES; column++) {
      const a = source[row * AXES + column]!;
      const b = source[column * AXES + row]!;
      const value = (0.5 * a + 0.5 * b) / scale[row]! / scale[column]!;
      if (!Number.isFinite(value) || Math.abs(a - b) > EPSILON * Math.max(Math.abs(a), Math.abs(b)))
        throw invalidLoad('Use a finite symmetric panel response in the correct rigid motion order.');
      result[row * AXES + column] = result[column * AXES + row] = value;
    }
  return result;
}

function removeMassRoundoff(mass: Matrix): Matrix {
  const projected = positivePart(mass);
  if (projected.negative > EPSILON * norm(mass))
    throw invalidLoad('Refine the hull panel mesh or supply positive semidefinite instantaneous added inertia.');
  return projected.negative === 0 ? mass : projected.matrix;
}

/** Validates and takes ownership of referenced radiation data for the world step. */
export function prepareCoupledRadiationProfile(profile: LoadCoupledRadiationProfile): LoadCoupledRadiationProfile {
  if (
    !profile ||
    !Number.isFinite(profile.waterline) ||
    !(profile.draft > 0 && Number.isFinite(profile.draft)) ||
    !(profile.density > 0 && Number.isFinite(profile.density)) ||
    !(profile.immersion > 0 && profile.immersion < 1) ||
    !Array.isArray(profile.centre) ||
    profile.centre.length !== 3 ||
    !profile.centre.every(Number.isFinite) ||
    !Array.isArray(profile.resonances)
  )
    throw invalidLoad(
      'Supply finite draft, water density, rigid centre of mass and resonances for a partly wet reference.',
    );
  const radius = profile.draft;
  const scale = Float64Array.of(1, 1, 1, radius, radius, radius);
  const mass = removeMassRoundoff(normalized(profile.infiniteMass, scale));
  const infiniteMass = Array.from(mass, (value, i) => value * scale[Math.floor(i / AXES)]! * scale[i % AXES]!);
  const resonances = profile.resonances.map((mode: LoadCoupledRadiationResonance): LoadCoupledRadiationResonance => {
    if (
      !mode ||
      !(
        mode.frequency > 0 &&
        mode.frequency * mode.frequency > 0 &&
        Number.isFinite(mode.frequency * mode.frequency)
      ) ||
      !(mode.decayRate > 0 && Number.isFinite(mode.decayRate)) ||
      !(mode.strength >= 0 && Number.isFinite(mode.strength)) ||
      !Array.isArray(mode.direction) ||
      mode.direction.length !== AXES ||
      !mode.direction.every((value) => Number.isFinite(mode.strength * value * value) && Number.isFinite(value)) ||
      !mode.direction.some((value) => value !== 0)
    )
      throw invalidLoad(
        'Use finite nonzero directions, positive radiation frequency and decay, and nonnegative strength.',
      );
    const [x, y, z, roll, yaw, pitch] = mode.direction;
    return {
      frequency: mode.frequency,
      decayRate: mode.decayRate,
      strength: mode.strength,
      direction: [x, y, z, roll, yaw, pitch],
    };
  });
  const [x, y, z] = profile.centre;
  return { ...profile, centre: [x, y, z], infiniteMass, resonances };
}

interface Pole {
  readonly frequency: number;
  readonly decayRate: number;
  readonly real: Float64Array;
  readonly imaginary: Float64Array;
  readonly normSquared: number;
}

function polesOf(frequencies: readonly number[]): Pole[] {
  const inBand = frequencies.map((frequency, index) => {
    const low = frequencies[Math.max(0, index - 1)]!;
    const high = frequencies[Math.min(frequencies.length - 1, index + 1)]!;
    return { frequency, width: high - low };
  });
  // Poles outside the fit interval can represent inertance from unmeasured wave frequencies.
  // Their damping and inertia still enter the objective only at the supplied samples.
  const lowest = frequencies[0]!;
  const highest = frequencies.at(-1)!;
  const outside = [lowest / 4, lowest / 2, 2 * highest, 4 * highest].map((frequency) => ({
    frequency,
    width: frequency / 8,
  }));
  return [...inBand, ...outside].flatMap(({ frequency, width }) =>
    [1, 2, 4].map((multiple) => {
      const decayRate = width * multiple;
      const real = new Float64Array(frequencies.length);
      const imaginary = new Float64Array(frequencies.length);
      let normSquared = 0;
      for (const [i, w] of frequencies.entries()) {
        const ratio = ((frequency - w) / decayRate) * ((frequency + w) / w);
        // Both coordinates tend to zero as the pole moves away from the sample.
        real[i] = 1 / (1 + ratio * ratio);
        imaginary[i] = Number.isFinite(ratio) ? ratio * real[i]! : 0;
        normSquared += real[i]! * real[i]! + imaginary[i]! * imaginary[i]!;
      }
      return { frequency, decayRate, real, imaginary, normSquared };
    }),
  );
}

interface Residual {
  readonly real: Matrix[];
  readonly imaginary: Matrix[];
}

function projectedResidue(residual: Residual, pole: Pole): PositivePart {
  const gradient = new Float64Array(WORDS);
  for (let i = 0; i < residual.real.length; i++)
    for (let j = 0; j < WORDS; j++)
      gradient[j]! += pole.real[i]! * residual.real[i]![j]! + pole.imaginary[i]! * residual.imaginary[i]![j]!;
  for (let j = 0; j < WORDS; j++) gradient[j]! /= pole.normSquared;
  return positivePart(gradient);
}

function update(residual: Residual, pole: Pole, matrix: Matrix, sign: number): void {
  for (let i = 0; i < residual.real.length; i++)
    for (let j = 0; j < WORDS; j++) {
      residual.real[i]![j]! += sign * pole.real[i]! * matrix[j]!;
      residual.imaginary[i]![j]! += sign * pole.imaginary[i]! * matrix[j]!;
    }
}

/** Fit positive matrix residues to both parts of K(iω) = B(ω) + iω(A(ω) - A∞). */
function fitCoupled(
  residual: Residual,
  frequencies: readonly number[],
  scale: Float64Array,
  peak: number,
  count: number,
  signal?: AbortSignal,
) {
  const resonances: LoadCoupledRadiationResonance[] = [];
  if (peak === 0) return { resonances, normalizedRmsError: 0, normalizedMaxError: 0 };
  for (const matrix of [...residual.real, ...residual.imaginary]) for (let j = 0; j < WORDS; j++) matrix[j]! /= peak;
  const choices = polesOf(frequencies);
  const selected: { pole: Pole; residue: PositivePart }[] = [];
  for (let iteration = 0; iteration < count; iteration++) {
    signal?.throwIfAborted();
    let best: (typeof selected)[number] | undefined;
    let score = 0;
    for (const pole of choices) {
      if (selected.some((entry) => entry.pole === pole)) continue;
      const residue = projectedResidue(residual, pole);
      const gain = residue.eigenvalues.reduce((sum, value) => sum + value * value, 0) * pole.normSquared;
      if (gain > score) {
        score = gain;
        best = { pole, residue };
      }
    }
    if (!best || score <= EPSILON * EPSILON) break;
    selected.push(best);
    update(residual, best.pole, best.residue.matrix, -1);

    // Refine the selected cone-constrained coefficients as each pole is added.
    for (let pass = 0; pass < 12; pass++) {
      for (const entry of selected) {
        update(residual, entry.pole, entry.residue.matrix, 1);
        entry.residue = projectedResidue(residual, entry.pole);
        update(residual, entry.pole, entry.residue.matrix, -1);
      }
    }
  }
  for (const {
    pole: { frequency, decayRate },
    residue,
  } of selected)
    for (let axis = 0; axis < AXES; axis++) {
      const value = residue.eigenvalues[axis]!;
      if (value === 0) continue;
      const direction = [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number];
      for (let j = 0; j < AXES; j++) direction[j] = residue.directions[j * AXES + axis]! * scale[j]!;
      const strength = value * peak * decayRate;
      if (!(strength > 0 && Number.isFinite(strength)))
        throw invalidLoad('Use a hull and frequency band whose radiation strengths fit finite SI values.');
      resonances.push({ direction, frequency, decayRate, strength });
    }
  let sum = 0;
  let maximum = 0;
  for (let i = 0; i < frequencies.length; i++)
    for (let j = 0; j < WORDS; j++) {
      const a = residual.real[i]![j]!;
      const b = residual.imaginary[i]![j]!;
      const squared = a * a + b * b;
      sum += squared;
      maximum = Math.max(maximum, squared);
    }
  return {
    resonances,
    normalizedRmsError: Math.sqrt(sum / (frequencies.length * WORDS)),
    normalizedMaxError: Math.sqrt(maximum),
  };
}

/**
 * Bakes passive radiation for a floating rigid body with coupled motion.
 * The panel bake supplies the complete SI matrices. Jointly fit their complex impedance as in Pérez and
 * Fossen (2008), DOI 10.4173/mic.2008.1.1, with positive semidefinite residues at shared stable poles.
 * Reference motion is linear and at zero forward speed.
 */
export async function coupledRadiationProfile(
  mesh: HullMesh,
  options: LoadCoupledRadiationProfileOptions,
): Promise<LoadCoupledRadiationProfile & { readonly fit: LoadCoupledRadiationFit }> {
  if (!options?.panels || typeof options.panels !== 'object')
    throw invalidLoad('Supply the floating mass and a finite-depth panel frequency band.');
  const { mass, panels, poles = 12, signal } = options;
  const ready = 'samples' in panels;
  const density = options.density ?? (ready ? panels.density : SEA_WATER);
  signal?.throwIfAborted();
  const shape = equivalentEllipsoid(mesh);
  const centre = options.centre ?? (ready ? panels.centre : shape.centre);
  const immersion = mass / (density * shape.volume);
  if (!(mass > 0 && Number.isFinite(mass) && density > 0 && Number.isFinite(density) && immersion > 0 && immersion < 1))
    throw invalidLoad('Choose finite mass and density for a closed hull that floats partly submerged.');
  if (
    !(
      Array.isArray(centre) &&
      centre.length === 3 &&
      centre.every(Number.isFinite) &&
      Number.isSafeInteger(poles) &&
      poles > 0
    )
  )
    throw invalidLoad('Supply a finite rigid centre of mass and a positive whole number of radiation poles.');
  const waterline = stillWaterline(mesh, mass, density);
  const local: [number, number, number] = [0, 0, 0];
  let keel = Infinity;
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis++)
      local[axis] = Math.max(local[axis]!, Math.abs(mesh.vertices[i + axis]! - centre[axis]!));
    keel = Math.min(keel, mesh.vertices[i + 1]!);
  }
  const [x, y, z] = local;
  const scale = Float64Array.of(1, 1, 1, Math.sqrt(y * y + z * z), Math.sqrt(x * x + z * z), Math.sqrt(x * x + y * y));
  const length = Math.max(...local);
  const match = (a: number, b: number) => Math.abs(a - b) <= EPSILON * Math.max(length, Math.abs(a), Math.abs(b));
  const reference = ready
    ? panels
    : await bakeHullPanels(mesh, { ...panels, waterline, centre, density, headings: 0, signal });
  signal?.throwIfAborted();
  const { frequencies, samples } = reference;
  if (
    reference.density !== density ||
    !match(reference.waterline, waterline) ||
    reference.centre?.length !== 3 ||
    !centre.every((value, axis) => match(value, reference.centre[axis]!))
  )
    throw invalidLoad('Bake the panel response at this hull’s floating draft, density and local rigid centre of mass.');
  if (
    !Array.isArray(frequencies) ||
    !Array.isArray(samples) ||
    frequencies.length < 2 ||
    frequencies.length !== samples.length ||
    frequencies.some((value, i) => {
      const upper = 4 * value;
      const lower = value / 4;
      return !(value > (frequencies[i - 1] ?? 0) && lower * lower > 0 && Number.isFinite(upper * upper));
    })
  )
    throw invalidLoad('Use at least two increasing, positive panel frequencies with one radiation sample each.');

  const massMatrix = removeMassRoundoff(normalized(reference.infiniteMass, scale));
  const infiniteMass = Array.from(massMatrix, (value, i) => value * scale[Math.floor(i / AXES)]! * scale[i % AXES]!);
  let peak = 0;
  let sourceNegativeDamping = 0;
  const target: Residual = { real: [], imaginary: [] };
  for (const [index, sample] of samples.entries()) {
    const damping = normalized(sample.damping, scale);
    const added = normalized(sample.addedMass, scale);
    sourceNegativeDamping = Math.max(sourceNegativeDamping, positivePart(damping).negative);
    for (let i = 0; i < WORDS; i++) added[i] = frequencies[index]! * (added[i]! - massMatrix[i]!);
    peak = Math.max(peak, norm(damping), norm(added));
    target.real.push(damping);
    target.imaginary.push(added);
  }
  if (!Number.isFinite(peak))
    throw invalidLoad('Keep the panel impedance within finite SI values for the chosen frequency band.');
  const { resonances, normalizedRmsError, normalizedMaxError } = fitCoupled(
    target,
    frequencies,
    scale,
    peak,
    poles,
    signal,
  );
  return {
    centre: [centre[0], centre[1], centre[2]],
    density,
    waterline,
    draft: waterline - keel,
    immersion,
    infiniteMass,
    resonances,
    fit: {
      range: [frequencies[0]!, frequencies.at(-1)!],
      normalizedRmsError,
      normalizedMaxError,
      sourceNegativeDamping,
    },
  };
}
