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
import { hullSections, type LewisForm, lewisForm, type Section } from './strips.js';
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
  /** The step the kernels are sampled at. */
  readonly dt: number;
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
  const waterline = stillWaterline(mesh, mass, density),
    sections = hullSections(mesh, waterline, stations).filter((s) => s.breadth > 0 && s.draft > 0),
    // The centre of mass's depth under the waterline (the sections' y runs down): the roll is about it.
    pivot = waterline - centre[1];
  if (sections.length === 0)
    return { waterline, frequencies: new Float64Array(1), pairs: [], lateralInfinite: new Float64Array(36), dt };
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
      list.push({
        b33: heaveSection(form, w, density, GRAVITY).damping,
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
  return { waterline, frequencies, pairs: tables, lateralInfinite, dt };
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
