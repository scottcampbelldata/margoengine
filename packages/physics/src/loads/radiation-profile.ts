import { hullMemory, stillWaterline } from '../seakeeping/memory.js';
import { bakeHullPanels, type HullPanelOptions } from '../seakeeping/panels.js';
import { SEA_WATER, type HullMesh, type Vec3 } from '../seakeeping/wetted.js';
import { invalidLoad } from './errors.js';
import type { LoadRadiationResonance } from './radiation.js';
import { equivalentEllipsoid } from './shapes.js';

export interface LoadRadiationProfileOptions {
  /** Mass of the hull and its load, kg. The upright hull must clear the waterline and displace this mass. */
  readonly mass: number;
  /** Centre of mass in hull coordinates, in m. Defaults to the closed hull's geometric centroid. */
  readonly centre?: Vec3;
  /** Water density in kg/m³, default 1025. Match the runtime LoadSolver. */
  readonly density?: number;
  /** Longitudinal strip count, default 24. The hull's forward direction is +X and up is +Y. */
  readonly stations?: number;
  /** Number of angular frequencies for the strip reference, default 56. */
  readonly frequencyCount?: number;
  /** Maximum number of nonnegative terms retained per direction, default 12. */
  readonly modesPerAxis?: number;
  /** Select native panels, with the requested frequencies and optional bottom and gravity. Omit for deep-water strips. */
  readonly panels?: Pick<HullPanelOptions, 'frequencies' | 'depth' | 'gravity'>;
  readonly signal?: AbortSignal;
}

/** Axis-major damping samples in physical SI units at the computed still-water draft. */
export interface LoadRadiationFrequencyResponse {
  /** The sampled range of the underlying linear water model, in rad/s. */
  readonly range: readonly [number, number];
  readonly frequencies: readonly number[];
  /** Diagonal projection of the source's frequency-domain damping along each load axis. */
  readonly damping: readonly (readonly number[])[];
  /** Real part of the fitted positive-real impedance at each source frequency. */
  readonly fittedDamping: readonly (readonly number[])[];
  /** Per-axis RMS error divided by that axis's peak absolute source damping. Zero for a non-radiating axis. */
  readonly normalizedRmsError: readonly number[];
  /** Per-axis maximum absolute error divided by that axis's peak absolute source damping. */
  readonly normalizedMaxError: readonly number[];
  /** Per-axis largest negative source ordinate removed to enforce passivity, in physical SI units. */
  readonly clippedNegativeDamping: readonly number[];
}

export interface LoadRadiationProfile {
  readonly method: 'strip' | 'panel';
  /** Still-water level in hull coordinates, m. */
  readonly waterline: number;
  /** Waterline minus the lowest vertex, m. */
  readonly draft: number;
  /** Fraction of the closed mesh volume submerged at the reference waterline. */
  readonly immersion: number;
  /** Infinite-frequency translational added mass per displaced kg, in LoadBody's principal-axis order. */
  readonly addedMass: Vec3;
  /** Infinite-frequency added rotational inertia per displaced kg, in m² and in the same order. */
  readonly addedInertia: Vec3;
  readonly resonances: readonly LoadRadiationResonance[];
  readonly frequencyResponse: LoadRadiationFrequencyResponse;
}

const AXES = [0, 1, 2, 3, 4, 5] as const;

interface Reference {
  readonly waterline: number;
  readonly frequencies: readonly number[];
  readonly infinite: ArrayLike<number>;
  readonly tables: readonly ArrayLike<number>[];
}

function stripReference(
  mesh: HullMesh,
  mass: number,
  centre: Vec3,
  density: number,
  stations: number,
  count: number,
): Reference {
  // The coarse time grid avoids baking a convolution we will replace. It does not enter the reference frequency tables.
  const memory = hullMemory(mesh, mass, centre, density, 1, { stations, count, window: 2 });
  const frequencies = Array.from(memory.frequencies);
  if (frequencies.length < 2) throw invalidLoad('Use a hull with wetted transverse sections at the computed draft.');
  const infinite = memory.lateralInfinite.slice();
  infinite[7] = memory.heaveInfinite;
  for (const strip of memory.strips) {
    const inertia = strip.width * memory.stripForms[strip.form]!.a33;
    infinite[35]! += inertia * strip.x * strip.x;
    infinite[11]! += inertia * strip.x;
    infinite[31]! += inertia * strip.x;
  }
  const tables = frequencies.map(() => new Float64Array(36));
  for (const { i, j, damping } of memory.pairs)
    for (const [k, table] of tables.entries()) {
      table[6 * i + j] = damping[k]!;
      table[6 * j + i] = damping[k]!;
    }
  return { waterline: memory.waterline, frequencies, infinite, tables };
}

function diagonal(matrix: ArrayLike<number>, axis: number, direction: Vec3): number {
  const start = axis < 3 ? 0 : 3;
  let value = 0;
  let scale = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const coefficient = matrix[6 * (start + i) + start + j]!;
      scale = Math.max(scale, Math.abs(coefficient));
      value += direction[i]! * coefficient * direction[j]!;
    }
  const roundoff = 32 * Number.EPSILON * scale;
  if (!Number.isFinite(value)) throw invalidLoad('Use a finer closed hull mesh and a finite radiation reference band.');
  return Math.abs(value) > roundoff ? value : 0;
}

interface Candidate {
  readonly frequency: number;
  readonly decayRate: number;
  readonly shape: Float64Array;
  readonly norm: number;
}

function resonatorColumns(frequencies: readonly number[]): Candidate[] {
  return frequencies.flatMap((frequency, i) => {
    const low = frequencies[Math.max(0, i - 1)]!;
    const high = frequencies[Math.min(frequencies.length - 1, i + 1)]!;
    // Different overlap widths let a selected resonator describe narrow peaks or a whole broadband shoulder.
    return [1, 2, 4].map((width) => {
      const decayRate = (high - low) * width;
      const shape = Float64Array.from(frequencies, (w) => {
        const delta = (frequency - w) * (frequency + w);
        const loss = decayRate * w;
        const ratio = delta / loss;
        return 1 / (1 + ratio * ratio);
      });
      const norm = shape.reduce((sum, value) => sum + value * value, 0);
      return { frequency, decayRate, shape, norm };
    });
  });
}

function dot(a: Float64Array, b: Float64Array): number {
  let value = 0;
  for (let i = 0; i < a.length; i++) value += a[i]! * b[i]!;
  return value;
}

function fit(
  axis: LoadRadiationResonance['axis'],
  reference: readonly number[],
  columns: readonly Candidate[],
  maxModes: number,
  immersion: number,
) {
  const peak = reference.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const fitted = new Array<number>(reference.length).fill(0);
  const resonances: LoadRadiationResonance[] = [];
  if (peak === 0) return { fitted, resonances, rms: 0, max: 0 };
  // Some strip tables undershoot zero at the tail. Retain that discrepancy in the reported source and fit error.
  const residual = Float64Array.from(reference, (value) => Math.max(0, value / peak));
  const active: { column: Candidate; amplitude: number }[] = [];
  for (let step = 0; step < maxModes; step++) {
    let best: Candidate | undefined;
    let improvement = Number.EPSILON;
    for (const column of columns) {
      if (active.some((mode) => mode.column === column)) continue;
      const slope = dot(residual, column.shape) / Math.sqrt(column.norm);
      if (slope > improvement) {
        best = column;
        improvement = slope;
      }
    }
    if (!best) break;
    active.push({ column: best, amplitude: 0 });
    // Nonnegative coordinate descent on the selected columns. Update the residual in place after each coefficient.
    for (let sweep = 0; sweep < 32; sweep++) {
      let change = 0;
      for (const mode of active) {
        const { shape, norm } = mode.column;
        const adjusted = Math.max(0, mode.amplitude + dot(residual, shape) / norm);
        const delta = adjusted - mode.amplitude;
        mode.amplitude = adjusted;
        change = Math.max(change, Math.abs(delta));
        for (let i = 0; i < residual.length; i++) residual[i]! -= delta * shape[i]!;
      }
      if (change <= 1e-10) break;
    }
  }
  for (const { column, amplitude } of active) {
    if (amplitude === 0) continue;
    const { frequency, decayRate, shape } = column;
    const strength = (amplitude * peak * decayRate) / immersion;
    if (!(strength >= 0 && Number.isFinite(strength) && decayRate > 0 && Number.isFinite(decayRate)))
      throw invalidLoad('Choose physical hull dimensions and a finite band for the radiation strengths.');
    resonances.push({ axis, frequency, decayRate, strength });
    for (let i = 0; i < fitted.length; i++) fitted[i]! += amplitude * peak * shape[i]!;
  }
  let max = 0;
  let squared = 0;
  for (let i = 0; i < fitted.length; i++) {
    const error = (fitted[i]! - reference[i]!) / peak;
    max = Math.max(max, Math.abs(error));
    squared += error * error;
  }
  return { fitted, resonances, rms: Math.sqrt(squared / reference.length), max };
}

/**
 * Bake a still-water diagonal radiation profile into the principal coordinates of a closed floating mesh.
 * Based on Cummins (1962) and Pérez and Fossen (2008), DOI 10.4173/mic.2008.1.1. Only geometry and the
 * potential-flow reference enter the fit. Eddy drag, large heel, forward speed and cross-axis memory belong
 * to a resolved hull solver. The fitted impedances are causal and positive real at every frequency.
 */
export async function radiationProfile(
  mesh: HullMesh,
  options: LoadRadiationProfileOptions,
): Promise<LoadRadiationProfile> {
  if (!options) throw invalidLoad('Provide the floating mass and any reference options for the radiation profile.');
  const { mass, density = SEA_WATER, stations = 24, frequencyCount = 56, modesPerAxis = 12, panels, signal } = options;
  signal?.throwIfAborted();
  const shape = equivalentEllipsoid(mesh);
  const centre = options.centre ?? shape.centre;
  const immersion = mass / (density * shape.volume);
  if (!(mass > 0 && density > 0 && Number.isFinite(mass) && Number.isFinite(density) && immersion > 0 && immersion < 1))
    throw invalidLoad('Use finite positive mass and water density with a closed hull that floats partly submerged.');
  if (centre.length !== 3 || !centre.every(Number.isFinite))
    throw invalidLoad('Provide a finite centre of mass in the hull coordinate frame.');
  if (
    !Number.isSafeInteger(stations) ||
    stations < 2 ||
    !Number.isSafeInteger(frequencyCount) ||
    frequencyCount < 3 ||
    !Number.isSafeInteger(modesPerAxis) ||
    modesPerAxis < 1
  )
    throw invalidLoad(
      'Choose at least two strip stations, three reference frequencies and one radiation mode per axis.',
    );
  let keel = Infinity;
  for (let i = 1; i < mesh.vertices.length; i += 3) keel = Math.min(keel, mesh.vertices[i]!);
  let reference: Reference;
  if (panels) {
    const waterline = stillWaterline(mesh, mass, density);
    const response = await bakeHullPanels(mesh, { ...panels, waterline, centre, density, headings: 0, signal });
    reference = {
      waterline,
      frequencies: response.frequencies,
      infinite: response.infiniteMass,
      tables: response.samples.map((sample) => sample.damping),
    };
  } else reference = stripReference(mesh, mass, centre, density, stations, frequencyCount);
  signal?.throwIfAborted();
  const { waterline, frequencies, infinite, tables } = reference;
  const columns = resonatorColumns(frequencies);
  const directions = shape.directions;
  const inertia = (axis: number): number => {
    const projected = diagonal(infinite, axis, directions[axis % 3]!);
    if (projected < 0)
      throw invalidLoad('Use a resolved hull and reference band with nonnegative infinite-frequency inertia.');
    return projected / mass;
  };
  const damping = AXES.map((axis) => tables.map((table) => diagonal(table, axis, directions[axis % 3]!)));
  const fits = AXES.map((axis) => fit(axis, damping[axis]!, columns, modesPerAxis, immersion));
  return {
    method: panels ? 'panel' : 'strip',
    waterline,
    draft: waterline - keel,
    immersion,
    addedMass: [inertia(0), inertia(1), inertia(2)],
    addedInertia: [inertia(3), inertia(4), inertia(5)],
    resonances: fits.flatMap((axis) => axis.resonances),
    frequencyResponse: {
      range: [frequencies[0]!, frequencies[frequencies.length - 1]!],
      frequencies,
      damping,
      fittedDamping: fits.map((axis) => axis.fitted),
      normalizedRmsError: fits.map((axis) => axis.rms),
      normalizedMaxError: fits.map((axis) => axis.max),
      clippedNegativeDamping: damping.map((values) => values.reduce((largest, value) => Math.max(largest, -value), 0)),
    },
  };
}
