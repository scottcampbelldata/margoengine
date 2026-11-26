// A hull's radiation memory (SEA-08): the waves a moving hull makes take energy away, and the force they leave on it depends
// on how it moved before (Cummins, "The impulse response function and ship motions", Schiffstechnik 9, 1962; Ogilvie
// 1964; both known through Journee and Massie, *Offshore Hydromechanics*, TU Delft 2001, and Perez and Fossen, MIC 29(1),
// 2008). For each pair of the hull's motions the force is
//     F_i(t) = -A_inf,ij x_j''(t) - integral from 0 to t of K_ij(t - s) x_j'(s) ds,  K_ij(t) = (2 / pi) integral of B_ij(w) cos(w t) dw,
// with B_ij(w) the hull's damping at frequency w. The convolution is here, over the hull's velocity history, sampled at the
// solver's step and summed by the trapezoid rule. B_ij(w) is strip theory at the hull's still-water draft (Journee and Massie
// eq. 8.25): each section's heave damping (`heaveSection`) and its sway, roll and sway-roll damping about the hull's centre of
// mass (`lateralSection`), integrated along the hull in the body's axes (x forward, y up, z to the side; roll about x, yaw
// about y, pitch about z): heave-pitch int b x, pitch int b x^2, sway-yaw -int b x, yaw int b x^2, roll-yaw -int b_42 x, x
// from the centre of mass. The lateral added mass at infinite frequency comes from the same sections: a section's sway and
// roll added mass approach their limits as 1 / xi (xi = w^2 M / g), so two solutions at xi = 64 and 128 give the limit by
// a straight line in 1 / xi (a half circle's sway limit is 0.405 of rho pi R^2 / 2: the free surface reverses the mirrored
// double body's motion, so it is not the rigid-lid value).
// Direct convolution keeps every frequency the table holds; Perez and Fossen fit a state-space model to the same kernel to
// save work, which a later change may do.
import { cos, pow } from '@margoengine/math/pinned';
import { heaveSection, lateralSection } from './radiation.js';
import { heaveAddedMassInfinite, hullSections, type LewisForm, lewisForm, type Section } from './strips.js';
import { eddyRollCoefficient, FRICTION, frictionGirth } from './viscous.js';
import { GRAVITY, type HullMesh, wettedLoads } from './wetted.js';

/** A coupled pair of the hull's motions (0 surge, 1 heave, 2 sway, 3 roll, 4 yaw, 5 pitch), its damping and its kernel. */
export interface RadiationPair {
  readonly i: number;
  readonly j: number;
  /** B_ij at each of the memory's frequencies (SI units of force over velocity). */
  readonly damping: Float64Array;
  /** K_ij(n dt) for n = 0 .. length - 1. */
  readonly kernel: Float64Array;
}

/**
 * A section as the waves' diffraction loads it (Journee and Massie eqs. 8.19 and 8.45-8.47, the relative motion principle):
 * where it is along the hull from the centre of mass, its width, the depths at which the water's motion stands for the
 * section's (heave: its mean draft, area over breadth, the long-wave limit of the depth T3* of its mean wave pressure, eq.
 * 8.44; sway: the depth of its area's centroid, where the water's mean horizontal motion over the section is in long
 * waves), and its form's index in `stripForms`.
 */
export interface DiffractionStrip {
  readonly x: number;
  readonly width: number;
  readonly heaveDepth: number;
  readonly swayDepth: number;
  readonly form: number;
}

/**
 * A section form's coefficients per metre for the diffraction loads: its added mass at infinite frequency in heave, sway
 * and sway-roll (roll about the centre of mass), and the kernels of its damping in the same, sampled at the step.
 */
export interface DiffractionForm {
  /** The section's Lewis form and breadth. */
  readonly lewis: LewisForm;
  readonly breadth: number;
  readonly a33: number;
  readonly a22: number;
  readonly a24: number;
  readonly k33: Float64Array;
  readonly k22: Float64Array;
  readonly k24: Float64Array;
}

/** A hull's radiation at its still-water draft: its damping B(w), the kernels K(t) sampled at the step, and its lateral A_inf. */
export interface HullMemory {
  /** The waterline in the body's frame the hull floats at in still water. */
  readonly waterline: number;
  /** The frequencies (rad/s) the damping is taken at. */
  readonly frequencies: Float64Array;
  /** Each coupled pair, i <= j (the matrices are symmetric). */
  readonly pairs: readonly RadiationPair[];
  /** The added mass at infinite frequency in sway, roll, yaw and their couplings, 6 by 6 row-major, about the centre of mass. */
  readonly lateralInfinite: Float64Array;
  /** Integrated heave added mass at infinite frequency, kg. */
  readonly heaveInfinite: number;
  /** The step the kernels are sampled at. */
  readonly dt: number;
  /**
   * The roll moment its bilge eddies shed, -rollEddy p |p| for a roll rate p about the centre of mass (N m s^2): the sum over the
   * sections of 1/2 rho d^4 C_R times their width, C_R Ikeda's (viscous.ts).
   */
  readonly rollEddy: number;
  /** Its skin friction in roll at frequency w is rollFriction sqrt(2 pi nu w) (N m s), nu the water's kinematic viscosity. */
  readonly rollFriction: number;
  /** The depth of the centre of mass under the still waterline: the sections roll about it. */
  readonly pivot: number;
  /** Its sections for the diffraction loads, and their forms. */
  readonly strips: readonly DiffractionStrip[];
  readonly stripForms: readonly DiffractionForm[];
}

interface WaveResponse {
  readonly added: Float64Array;
  readonly damping: Float64Array;
  readonly staticMass: number;
}

export interface HullWaveMemory extends HullMemory {
  readonly waveResponses?: readonly WaveResponse[];
}

/** The still-water waterline in the body's frame at which `mesh` (upright) displaces `mass` of water of `density`. */
export function stillWaterline(mesh: HullMesh, mass: number, density: number): number {
  const { vertices } = mesh;
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 1; i < vertices.length; i += 3) {
    lo = Math.min(lo, vertices[i]!);
    hi = Math.max(hi, vertices[i]!);
  }
  const loads = {
      force: [0, 0, 0] as [number, number, number],
      torque: [0, 0, 0] as [number, number, number],
      area: 0,
    },
    displaced = (level: number) =>
      wettedLoads(
        mesh,
        { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
        { density, elevation: () => level },
        0,
        [0, 0, 0],
        loads,
      ).force[1] /
      (density * GRAVITY);
  // Bisection: the displaced volume grows with the level.
  let a = lo,
    b = hi;
  for (let step = 0; step < 60; step++) {
    const mid = (a + b) / 2;
    if (displaced(mid) * density < mass) a = mid;
    else b = mid;
  }
  return (a + b) / 2;
}

/** A section's coefficients at one frequency: heave damping, sway, roll and sway-roll damping (b42 the roll moment of a sway). */
interface SectionDamping {
  readonly a33: number;
  readonly b33: number;
  readonly b22: number;
  readonly b44: number;
  readonly b24: number;
  readonly b42: number;
}

/**
 * The radiation memory of `mesh` floating upright at the draft that holds `mass` in water of `density`, about the centre of
 * mass at `centre` (body frame), its kernels sampled every `dt` seconds over up to `window` seconds.
 */
export function hullMemory(
  mesh: HullMesh,
  mass: number,
  centre: readonly [number, number, number],
  density: number,
  dt: number,
  { stations = 24, count = 56, window = 20 } = {},
): HullMemory {
  return buildHullMemory(mesh, mass, centre, density, dt, { stations, count, window });
}

export function buildHullMemory(
  mesh: HullMesh,
  mass: number,
  centre: readonly [number, number, number],
  density: number,
  dt: number,
  { stations = 24, count = 56, window = 20, waveResponse = false } = {},
): HullWaveMemory {
  const waterline = stillWaterline(mesh, mass, density),
    sections = hullSections(mesh, waterline, stations).filter((s) => s.breadth > 0 && s.draft > 0),
    // The centre of mass's depth under the waterline (the sections' y runs down): the roll is about it.
    pivot = waterline - centre[1];
  if (sections.length === 0)
    return {
      waterline,
      frequencies: new Float64Array(1),
      pairs: [],
      lateralInfinite: new Float64Array(36),
      heaveInfinite: 0,
      dt,
      rollEddy: 0,
      rollFriction: 0,
      pivot,
      strips: [],
      stripForms: [],
    };
  let widest = 0,
    narrowest = Infinity;
  for (const s of sections) {
    widest = Math.max(widest, s.breadth);
    narrowest = Math.min(narrowest, s.breadth);
  }
  // Frequencies over the range where the sections damp: from xi = 0.005 on the broadest to xi = 48 on the narrowest
  // (xi = w^2 B / (2 g)), log-spaced. Heave damping is gone by xi = 12, but sway and roll damping fall off slowly: a table
  // cut there left a tail that neither the kernel nor the added mass at infinite frequency (taken at xi = 64 and 128) held,
  // and a driven box's roll came out 3.7 percent off at 4 rad/s against 2.3 with the table to 48 (60 steps a second).
  const wLo = Math.sqrt((0.005 * 2 * GRAVITY) / widest),
    wHi = Math.sqrt((48 * 2 * GRAVITY) / narrowest),
    frequencies = new Float64Array(count),
    forms = sections.map((s: Section) => lewisForm(s.breadth, s.draft, s.area)),
    key = (f: LewisForm) => `${f.scale} ${f.a1} ${f.a3}`;
  for (let n = 0; n < count; n++) frequencies[n] = wLo * pow(wHi / wLo, n / (count - 1));
  // Sections of one form (a prismatic hull's) are alike: each form solved once a frequency.
  const solved = new Map<string, SectionDamping[]>();
  for (const form of forms) {
    const k = key(form);
    if (solved.has(k)) continue;
    const list: SectionDamping[] = [];
    for (const w of frequencies) {
      const lateral = lateralSection(form, w, density, pivot, GRAVITY);
      const heave = heaveSection(form, w, density, GRAVITY);
      list.push({
        a33: heave.addedMass,
        b33: heave.damping,
        b22: lateral.sway.damping,
        b44: lateral.roll.damping,
        b24: lateral.swayOfRoll.damping,
        b42: lateral.rollOfSway.damping,
      });
    }
    solved.set(k, list);
  }
  // The pairs in the body's axes (see the head of the file), each a sum over the sections.
  const pairs: [number, number, (d: SectionDamping, x: number) => number][] = [
    [1, 1, (d) => d.b33],
    [1, 5, (d, x) => d.b33 * x],
    [5, 5, (d, x) => d.b33 * x * x],
    [2, 2, (d) => d.b22],
    [2, 3, (d) => (d.b24 + d.b42) / 2],
    [3, 3, (d) => d.b44],
    [2, 4, (d, x) => -d.b22 * x],
    [3, 4, (d, x) => (-(d.b24 + d.b42) / 2) * x],
    [4, 4, (d, x) => d.b22 * x * x],
  ];
  const tables = pairs.map(([i, j, of]) => {
    const damping = new Float64Array(count);
    sections.forEach((s, k) => {
      const list = solved.get(key(forms[k]!))!,
        x = s.x - centre[0];
      for (let n = 0; n < count; n++) damping[n]! += of(list[n]!, x) * s.width;
    });
    return { i, j, damping, kernel: kernelOf(frequencies, damping, dt, window) };
  });
  // The lateral added mass at infinite frequency: each form's limit by a straight line in 1 / xi through xi = 64 and 128.
  const limits = new Map<string, { a22: number; a44: number; a24: number }>();
  for (const form of forms) {
    const k = key(form);
    if (limits.has(k)) continue;
    const at = (xi: number) => lateralSection(form, Math.sqrt((xi * GRAVITY) / form.scale), density, pivot, GRAVITY),
      [near, far] = [at(64), at(128)],
      line = (a: number, b: number) => 2 * b - a;
    limits.set(k, {
      a22: line(near.sway.addedMass, far.sway.addedMass),
      a44: line(near.roll.addedMass, far.roll.addedMass),
      a24: line(
        (near.swayOfRoll.addedMass + near.rollOfSway.addedMass) / 2,
        (far.swayOfRoll.addedMass + far.rollOfSway.addedMass) / 2,
      ),
    });
  }
  const lateralInfinite = new Float64Array(36),
    put = (i: number, j: number, v: number) => {
      lateralInfinite[i * 6 + j]! += v;
      if (i !== j) lateralInfinite[j * 6 + i]! += v;
    };
  sections.forEach((s, k) => {
    const { a22, a44, a24 } = limits.get(key(forms[k]!))!,
      x = s.x - centre[0],
      w = s.width;
    put(2, 2, a22 * w);
    put(2, 3, a24 * w);
    put(3, 3, a44 * w);
    put(2, 4, -a22 * x * w);
    put(3, 4, -a24 * x * w);
    put(4, 4, a22 * x * x * w);
  });
  // The viscous roll damping of each section about the centre of mass, summed along the hull.
  let rollEddy = 0,
    rollFriction = 0;
  sections.forEach((s, k) => {
    const form = forms[k]!,
      d2 = s.draft * s.draft;
    rollEddy += 0.5 * density * d2 * d2 * eddyRollCoefficient(form, s.breadth, s.draft, pivot) * s.width;
    rollFriction += FRICTION * density * frictionGirth(form, pivot) * s.width;
  });
  // The diffraction loads' sections and their forms, each form's kernels taken once.
  const formIndex = new Map<string, number>(),
    stripForms: DiffractionForm[] = [],
    waveResponses: WaveResponse[] | undefined = waveResponse ? [] : undefined,
    strips: DiffractionStrip[] = sections.map((s, k) => {
      const form = forms[k]!,
        id = key(form);
      let index = formIndex.get(id);
      if (index === undefined) {
        const list = solved.get(id)!,
          { a22, a24 } = limits.get(id)!,
          table = (of: (d: SectionDamping) => number) => kernelOf(frequencies, Float64Array.from(list, of), dt, window);
        index = stripForms.length;
        formIndex.set(id, index);
        const a33 = heaveAddedMassInfinite(s.breadth, form, density);
        const k33 = table((d) => d.b33);
        stripForms.push({
          lewis: form,
          breadth: s.breadth,
          a33,
          a22,
          a24,
          k33,
          k22: table((d) => d.b22),
          k24: table((d) => (d.b24 + d.b42) / 2),
        });
        if (waveResponses)
          waveResponses.push({
            added: Float64Array.from(list, (d) => d.a33),
            damping: Float64Array.from(list, (d) => d.b33),
            staticMass: staticAddedMass(a33, k33, dt),
          });
      }
      return {
        x: s.x - centre[0],
        width: s.width,
        heaveDepth: s.area / s.breadth,
        swayDepth: s.centroid,
        form: index,
      };
    });
  return {
    waterline,
    frequencies,
    pairs: tables,
    lateralInfinite,
    heaveInfinite: strips.reduce((mass, strip) => mass + strip.width * stripForms[strip.form]!.a33, 0),
    dt,
    rollEddy,
    rollFriction,
    pivot,
    strips,
    stripForms,
    ...(waveResponses ? { waveResponses } : {}),
  };
}

/** A(0) is the infinite-frequency mass less the first time moment of the finite radiation kernel. */
export function staticAddedMass(infinite: number, kernel: Float64Array, dt: number): number {
  let mass = infinite;
  for (let lag = 1; lag < kernel.length; lag++) mass -= kernel[lag]! * lag * dt * dt;
  return mass;
}

/**
 * K(t) = (2 / pi) integral of B(w) cos(w t) dw at t = n dt, B taken as rising linearly from 0 at w = 0 (its two-dimensional
 * limit) to the first sample, linear between samples and 0 past the last, by a fine trapezoid rule; cos(i h t) by the
 * recurrence cos((i + 1) a) = 2 cos(a) cos(i a) - cos((i - 1) a), one pinned cosine a lag.
 */
function kernelOf(frequencies: Float64Array, table: Float64Array, dt: number, window: number): Float64Array {
  const count = frequencies.length,
    length = Math.max(2, Math.ceil(window / dt)),
    fine = 4000,
    top = frequencies[count - 1]!,
    h = top / fine,
    values = new Float64Array(fine + 1),
    out = new Float64Array(length);
  let j = 0;
  for (let i = 0; i <= fine; i++) {
    const w = i * h;
    if (w <= frequencies[0]!) values[i] = (table[0]! * w) / frequencies[0]!;
    else if (w >= top) values[i] = 0;
    else {
      while (frequencies[j + 1]! < w) j++;
      const t = (w - frequencies[j]!) / (frequencies[j + 1]! - frequencies[j]!);
      values[i] = table[j]! + t * (table[j + 1]! - table[j]!);
    }
  }
  for (let n = 0; n < length; n++) {
    const c = cos(h * n * dt);
    let previous = c,
      current = 1,
      sum = 0.5 * values[0]!;
    for (let i = 1; i <= fine; i++) {
      const next = i === 1 ? c : 2 * c * current - previous;
      previous = current;
      current = next;
      sum += (i === fine ? 0.5 : 1) * values[i]! * current;
    }
    out[n] = (2 / Math.PI) * sum * h;
  }
  return out;
}
