// A hull's radiation memory (SEA-08): the waves a moving hull makes take energy away, and the force they leave on it depends
// on how it moved before (Cummins, "The impulse response function and ship motions", Schiffstechnik 9, 1962; Ogilvie
// 1964; both known through Journee and Massie, *Offshore Hydromechanics*, TU Delft 2001, and Perez and Fossen, MIC 29(1),
// 2008). In heave and pitch the force is
//     F(t) = -A_inf x''(t) - integral from 0 to t of K(t - s) x'(s) ds,  K(t) = (2 / pi) integral of B(w) cos(w t) dw,
// with B(w) the damping of the hull at frequency w. The added mass at infinite frequency is the solver's (strips.ts); the
// convolution is here, over the hull's velocity history, sampled at the solver's step and summed by the trapezoid rule.
// B(w) is strip theory: each section's heave damping by Ursell-Tasai (radiation.ts), integrated along the hull at its
// still-water draft (Journee and Massie eq. 8.25): B33 = int b, B35 = -int b x, B55 = int b x^2, x from the centre of mass.
// Direct convolution keeps every frequency the table holds; Perez and Fossen fit a state-space model to the same kernel to
// save work, which a later change may do.
import { cos, pow } from '@margoengine/math/pinned';
import { heaveSection } from './radiation.js';
import { hullSections, lewisForm, type Section } from './strips.js';
import { GRAVITY, type HullMesh, wettedLoads } from './wetted.js';

/** A hull's heave and pitch damping B(w) at its still-water draft, and the kernels K(t) sampled at the step. */
export interface HullMemory {
  /** The waterline in the body's frame the hull floats at in still water. */
  readonly waterline: number;
  /** Frequencies (rad/s) and the damping there: heave (N s/m), heave-pitch (N s), pitch (N m s). */
  readonly frequencies: Float64Array;
  readonly heave: Float64Array;
  readonly coupling: Float64Array;
  readonly pitch: Float64Array;
  /** K(j dt) for j = 0 .. length - 1: heave, heave-pitch, pitch. */
  readonly kernelHeave: Float64Array;
  readonly kernelCoupling: Float64Array;
  readonly kernelPitch: Float64Array;
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
  { stations = 24, count = 40, window = 20 } = {},
): HullMemory {
  const waterline = stillWaterline(mesh, mass, density),
    sections = hullSections(mesh, waterline, stations).filter((s) => s.breadth > 0 && s.draft > 0);
  // Frequencies over the range where the sections damp: from xi = 0.005 on the broadest to xi = 12 on the narrowest
  // (xi = w^2 B / (2 g)), log-spaced.
  let widest = 0,
    narrowest = Infinity;
  for (const s of sections) {
    widest = Math.max(widest, s.breadth);
    narrowest = Math.min(narrowest, s.breadth);
  }
  const frequencies = new Float64Array(count),
    heave = new Float64Array(count),
    coupling = new Float64Array(count),
    pitch = new Float64Array(count);
  if (sections.length === 0) return empty(waterline, dt);
  const wLo = Math.sqrt((0.005 * 2 * GRAVITY) / widest),
    wHi = Math.sqrt((12 * 2 * GRAVITY) / narrowest),
    forms = sections.map((s: Section) => lewisForm(s.breadth, s.draft, s.area));
  for (let i = 0; i < count; i++) {
    const w = wLo * pow(wHi / wLo, i / (count - 1));
    frequencies[i] = w;
    // Sections of one form (a prismatic hull's) damp alike: solved once a frequency.
    const solved = new Map<string, number>();
    sections.forEach((s, k) => {
      const form = forms[k]!,
        key = `${form.scale} ${form.a1} ${form.a3}`;
      let per = solved.get(key);
      if (per === undefined) {
        per = heaveSection(form, w, density, GRAVITY).damping;
        solved.set(key, per);
      }
      const b = per * s.width,
        x = s.x - centre[0];
      heave[i]! += b;
      coupling[i]! -= b * x;
      pitch[i]! += b * x * x;
    });
  }
  // K(t) = (2 / pi) integral of B(w) cos(w t) dw, B taken as rising linearly from 0 at w = 0 (its two-dimensional
  // limit) to the first sample, linear between samples, and 0 past the last, by a fine trapezoid rule.
  const length = Math.max(2, Math.ceil(window / dt)),
    fine = 4000,
    top = frequencies[count - 1]!,
    sample = (table: Float64Array, w: number): number => {
      if (w <= frequencies[0]!) return (table[0]! * w) / frequencies[0]!;
      if (w >= top) return 0;
      let j = 0;
      while (frequencies[j + 1]! < w) j++;
      const t = (w - frequencies[j]!) / (frequencies[j + 1]! - frequencies[j]!);
      return table[j]! + t * (table[j + 1]! - table[j]!);
    },
    kernel = (table: Float64Array): Float64Array => {
      const out = new Float64Array(length),
        h = top / fine,
        values = new Float64Array(fine + 1);
      for (let i = 0; i <= fine; i++) values[i] = sample(table, i * h);
      for (let j = 0; j < length; j++) {
        // cos(i h t) by the recurrence cos((i + 1) a) = 2 cos(a) cos(i a) - cos((i - 1) a): one pinned cosine a lag.
        const c = cos(h * j * dt);
        let previous = c,
          current = 1,
          sum = 0.5 * values[0]!;
        for (let i = 1; i <= fine; i++) {
          const next = i === 1 ? c : 2 * c * current - previous;
          previous = current;
          current = next;
          sum += (i === fine ? 0.5 : 1) * values[i]! * current;
        }
        out[j] = (2 / Math.PI) * sum * h;
      }
      return out;
    };
  return {
    waterline,
    frequencies,
    heave,
    coupling,
    pitch,
    kernelHeave: kernel(heave),
    kernelCoupling: kernel(coupling),
    kernelPitch: kernel(pitch),
    dt,
  };
}

function empty(waterline: number, dt: number): HullMemory {
  const none = new Float64Array(1);
  return {
    waterline,
    frequencies: none,
    heave: none,
    coupling: none,
    pitch: none,
    kernelHeave: none,
    kernelCoupling: none,
    kernelPitch: none,
    dt,
  };
}
