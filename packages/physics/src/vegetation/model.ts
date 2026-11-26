import { cos, exp, sin } from '@margoengine/math/pinned';

/** Physical properties and optional initial motion of one rooted plant. */
export interface PlantSwayPlant {
  /** Root coordinates in metres in the solver's origin cell, y up. */
  readonly root: readonly [number, number, number];
  /** Positive stem length in metres. */
  readonly height: number;
  /** Positive outer stem diameter at the root, in metres. */
  readonly baseDiameter: number;
  /** Outer diameter at the tip, in metres. Defaults to the base diameter. */
  readonly tipDiameter?: number;
  /** Inner/outer radius ratio, in [0, 1). Defaults to zero, a solid stem. */
  readonly hollowRatio?: number;
  /** Young's modulus of the stem in Pa. */
  readonly youngModulus: number;
  /** Tissue density in kg/m³. */
  readonly density: number;
  /** Stem drag coefficient. Defaults to one. */
  readonly dragCoefficient?: number;
  /** Transverse added-mass coefficient. Defaults to one in water and zero in air. */
  readonly addedMassCoefficient?: number;
  /** Internal damping ratio of the dry first mode. Defaults to zero. Fluid drag still damps the plant. */
  readonly dampingRatio?: number;
  /** Bending strength in Pa. Omit to leave stem rupture disabled. */
  readonly ruptureStress?: number;
  /** Root resisting moment in N m. Omit to leave uprooting disabled. */
  readonly anchorMoment?: number;
  /** A crown distributed uniformly from its base to the stem tip. */
  readonly crown?: {
    /** Height of the crown base in metres above the root, below the tip. */
    readonly base: number;
    /** Crown mass in kg. */
    readonly mass: number;
    /** Crown area normal to horizontal flow, in m². */
    readonly area: number;
    /** Crown water displacement in m³. Defaults to zero. */
    readonly displacedVolume?: number;
    /** Crown drag coefficient. Defaults to the stem coefficient. */
    readonly dragCoefficient?: number;
  };
  /** Tip-normalized modal displacements [first x,z, second x,z], in metres. Defaults to zero. */
  readonly initialDisplacement?: readonly [number, number, number, number];
  /** Tip-normalized modal velocities [first x,z, second x,z], in m/s. Defaults to zero. */
  readonly initialVelocity?: readonly [number, number, number, number];
}

type Triple = readonly [number, number, number];
type Mode = { beta: number; coefficient: number; tip: number };

export const MODEL_WORDS = 14;
export const STATIONS = 6;
export const STATION_WORDS = 9;
export const SECTIONS = 9;
export const SECTION_WORDS = 3;
/** f64 words per plant in the sway port, in the order described by PlantSway.swayField. */
export const PLANT_SWAY_WORDS = 13;
/** f64 words per plant for generalized modal impulses [first x,z, second x,z], in N s. */
export const PLANT_IMPULSE_WORDS = 4;

const massNodes = [
  [0.09501250983763744, 0.1894506104550685],
  [0.2816035507792589, 0.1826034150449236],
  [0.4580167776572274, 0.16915651939500254],
  [0.6178762444026438, 0.14959598881657673],
  [0.755404408355003, 0.12462897125553387],
  [0.8656312023878318, 0.09515851168249278],
  [0.9445750230732326, 0.06225352393864789],
  [0.9894009349916499, 0.027152459411754095],
] as const;
const forceNodes = [
  [-0.7745966692414834, 5 / 9],
  [0, 8 / 9],
  [0.7745966692414834, 5 / 9],
] as const;

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(name + ' must be finite and nonnegative; pass a quantity within range.');
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || !(value > 0))
    throw new RangeError(name + ' must be finite and positive; pass a quantity within range.');
  return value;
}

function exactShape(value: Mode, s: number): Triple {
  const x = value.beta * s;
  const e = exp(x);
  const cosh = (e + 1 / e) / 2;
  const sinh = (e - 1 / e) / 2;
  const c = cos(x);
  const y = sin(x);
  const k = value.coefficient;
  return [
    (cosh - c - k * (sinh - y)) / value.tip,
    (value.beta * (sinh + y - k * (cosh - c))) / value.tip,
    (value.beta * value.beta * (cosh + c - k * (sinh + y))) / value.tip,
  ];
}

function rootMode(low: number, high: number): Mode {
  const initialSign = cos(low) > 0;
  for (let i = 0; i < 56; i++) {
    const middle = (low + high) / 2;
    const e = exp(middle);
    const positiveResidual = cos(middle) + 2 / (e + 1 / e) > 0;
    if (positiveResidual === initialSign) low = middle;
    else high = middle;
  }
  const beta = (low + high) / 2;
  const e = exp(beta);
  const value = {
    beta,
    coefficient: ((e + 1 / e) / 2 + cos(beta)) / ((e - 1 / e) / 2 + sin(beta)),
    tip: 1,
  };
  value.tip = exactShape(value, 1)[0];
  return value;
}

export function stemModes(): readonly [Mode, Mode] {
  return [rootMode(0, Math.PI), rootMode(Math.PI, 2 * Math.PI)];
}

export function modeValues(modes: readonly [Mode, Mode], fraction: number): readonly [Triple, Triple] {
  const at = (mode: Mode): Triple => {
    if (fraction === 0) return [0, 0, (2 * mode.beta * mode.beta) / mode.tip];
    const values = exactShape(mode, fraction);
    return fraction === 1 ? [1, values[1], 0] : values;
  };
  return [at(modes[0]), at(modes[1])];
}

function integrate(end: number, start: number, f: (s: number, w: number) => void): void {
  const mid = (end + start) * 0.5;
  const half = (end - start) * 0.5;
  for (let i = massNodes.length - 1; i >= 0; i--) {
    const [point, weight] = massNodes[i]!;
    f(mid - half * point, half * weight);
  }
  for (const [point, weight] of massNodes) f(mid + half * point, half * weight);
}

function matrixAdd(a: number[], u: number, v: number, scale: number): void {
  a[0] = a[0]! + scale * u * u;
  a[1] = a[1]! + scale * u * v;
  a[2] = a[2]! + scale * v * v;
}

// Largest generalized eigenvalue first avoids cancellation for the low mode.
// Both matrices are scaled before their determinants and mixed trace.
function frequencies(m: number[], k: number[]): readonly [number, number] {
  const mScale = Math.max(m[0]!, m[2]!);
  const kScale = Math.max(k[0]!, k[2]!);
  const a = m[0]! / mScale;
  const b = m[1]! / mScale;
  const d = m[2]! / mScale;
  const p = k[0]! / kScale;
  const q = k[1]! / kScale;
  const r = k[2]! / kScale;
  const detM = a * d - b * b;
  const detK = p * r - q * q;
  const mixed = a * r + d * p - 2 * b * q;
  const high = (mixed + Math.sqrt(Math.max(0, mixed * mixed - 4 * detM * detK))) / (2 * detM);
  const low = detK / (detM * high);
  if (
    !(detM > 0 && detK > 0 && mixed > 0) ||
    !Number.isFinite(high) ||
    !(low > 0) ||
    !(kScale / mScale > 0) ||
    !Number.isFinite(kScale / mScale)
  )
    throw new RangeError(
      'Plant modal mass and stiffness must be finite and positive definite; check stem dimensions and material.',
    );
  return [
    positive(Math.sqrt(low * (kScale / mScale)), 'First plant natural angular frequency'),
    positive(Math.sqrt(high * (kScale / mScale)), 'Second plant natural angular frequency'),
  ];
}

export function preparePlant(plant: PlantSwayPlant, modes: readonly [Mode, Mode], water: boolean) {
  if (!plant || typeof plant !== 'object' || plant.root?.length !== 3 || !Array.from(plant.root).every(Number.isFinite))
    throw new TypeError('A plant needs three finite root coordinates; pass its position in the solver origin.');
  const h = positive(plant.height, 'Plant height');
  const r0 = positive(plant.baseDiameter, 'Plant base diameter') / 2;
  const r1 = nonnegative(plant.tipDiameter ?? plant.baseDiameter, 'Plant tip diameter') / 2;
  const hollow = nonnegative(plant.hollowRatio ?? 0, 'Plant hollow ratio');
  if (hollow >= 1) throw new RangeError('Plant hollow ratio leaves no material; pass a ratio below one.');
  const e = positive(plant.youngModulus, 'Plant Young’s modulus');
  const density = positive(plant.density, 'Plant tissue density');
  const cd = nonnegative(plant.dragCoefficient ?? 1, 'Plant drag coefficient');
  const ca = nonnegative(plant.addedMassCoefficient ?? (water ? 1 : 0), 'Plant added mass coefficient');
  const damping = nonnegative(plant.dampingRatio ?? 0, 'Plant damping ratio');
  const rupture = plant.ruptureStress === undefined ? 0 : 1 / positive(plant.ruptureStress, 'Plant rupture stress');
  const anchor = plant.anchorMoment === undefined ? 0 : 1 / positive(plant.anchorMoment, 'Plant anchorage');
  const areaFactor = (1 - hollow) * (1 + hollow);
  const inertiaFactor = (areaFactor * (1 + hollow * hollow)) / 4;
  const radius = (s: number) => r0 + (r1 - r0) * s;
  const outerArea = (r: number) => Math.PI * r * r;
  const inertia = (r: number) => outerArea(r) * r * r * inertiaFactor;
  const crown = plant.crown;
  const start = crown ? nonnegative(crown.base, 'Crown base height') / h : 0;
  if (crown && !(start < 1)) throw new RangeError('Crown base is at or above the tip; put it below the stem height.');
  const crownMass = crown ? nonnegative(crown.mass, 'Crown mass') : 0;
  const crownArea = crown ? nonnegative(crown.area, 'Crown drag area') : 0;
  const crownVolume = crown ? nonnegative(crown.displacedVolume ?? 0, 'Crown displaced volume') : 0;
  const crownDrag = crown ? nonnegative(crown.dragCoefficient ?? cd, 'Crown drag coefficient') : 0;

  const m = [0, 0, 0];
  const k = [0, 0, 0];
  integrate(1, 0, (s, w) => {
    const r = radius(s);
    const [a, b] = modeValues(modes, s);
    matrixAdd(m, a[0], b[0], density * areaFactor * outerArea(r) * (w * h));
    matrixAdd(k, a[2] / h / h, b[2] / h / h, e * inertia(r) * (w * h));
  });
  if (crownMass > 0) {
    integrate(1, start, (s, w) => {
      const [a, b] = modeValues(modes, s);
      matrixAdd(m, a[0], b[0], crownMass * (w / (1 - start)));
    });
  }
  const angular = frequencies(m, k);
  const dampingScale = (2 * damping) / angular[0];
  const [a0, b0] = modeValues(modes, 0);
  const baseEI = e * inertia(r0);
  const model = [
    ...m,
    ...k,
    ...k.map((value) => value * dampingScale),
    h,
    ca,
    (baseEI * (a0[2] / h)) / h,
    (baseEI * (b0[2] / h)) / h,
    anchor,
  ];
  const stations: number[] = [];
  for (const [point, weight] of forceNodes) {
    const s = (1 + point) / 2;
    const ds = (weight * h) / 2;
    const r = radius(s);
    const volume = outerArea(r) * ds;
    const [a, b] = modeValues(modes, s);
    const below = [0, 0, 0];
    if (water) {
      integrate(s, 0, (v, w) => {
        const [u, z] = modeValues(modes, v);
        matrixAdd(below, u[1] / h, z[1] / h, w * h);
      });
    }
    stations.push(s * h, a[0], b[0], cd * (2 * r) * ds, volume, density * areaFactor * volume, ...below);
  }
  for (const [point, weight] of forceNodes) {
    const s = start + ((1 + point) / 2) * (1 - start);
    const w = weight / 2;
    const [a, b] = modeValues(modes, s);
    const below = [0, 0, 0];
    if (water && crown) {
      integrate(s, 0, (v, dw) => {
        const [u, z] = modeValues(modes, v);
        matrixAdd(below, u[1] / h, z[1] / h, dw * h);
      });
    }
    stations.push(s * h, a[0], b[0], crownDrag * crownArea * w, crownVolume * w, crownMass * w, ...below);
  }
  const sections: number[] = [];
  for (let i = 0; i < SECTIONS; i++) {
    const s = i / (SECTIONS - 1);
    const [a, b] = modeValues(modes, s);
    const factor = e * radius(s) * rupture;
    sections.push(s * h, (factor * (a[2] / h)) / h, (factor * (b[2] / h)) / h);
  }
  const initial = [...(plant.initialDisplacement ?? [0, 0, 0, 0]), ...(plant.initialVelocity ?? [0, 0, 0, 0])];
  if (
    initial.length !== 8 ||
    (plant.initialDisplacement !== undefined && plant.initialDisplacement.length !== 4) ||
    (plant.initialVelocity !== undefined && plant.initialVelocity.length !== 4) ||
    [...initial, ...model, ...stations, ...sections].some((value) => !Number.isFinite(value))
  )
    throw new RangeError(
      'Plant model values exceed the numeric range; use finite geometry, material and four components per initial vector.',
    );
  return { root: Array.from(plant.root), model, stations, sections, angular, initial };
}
