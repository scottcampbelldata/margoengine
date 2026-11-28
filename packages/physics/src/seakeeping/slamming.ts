// Slamming (SEA-11): a hull section hitting the water. The water it meets has to be set moving in a moment, and the
// momentum it takes up is the section's added mass m(h) at its depth of entry h times their relative speed; its rate is
// the slamming force (von Karman, "The impact on seaplane floats during landing", NACA TN 321, 1929):
//     F = d(m V) / dt = m dV/dt + (dm/dh) V^2,
// the second term the impact: large while m grows fast with h, as it does when a flat bottom or a flared bow comes down.
// Wagner ("Uber Stoss- und Gleitvorgange an der Oberflache von Flussigkeiten", ZAMM 12, 1932) took the water piling up
// against the hull into the wetted width: with the section's height above the keel f(x) at half-breadth x, the wetted
// half-breadth c(h) solves
//     integral from 0 to pi/2 of f(c sin(theta)) d theta = (pi / 2) h,
// so a wedge of deadrise beta is wet to c = (pi / 2) h / tan(beta), pi / 2 farther than its still-water cut, and the added
// mass is a flat plate of half-width c on the free surface, m = rho pi c^2 / 2. Known through Faltinsen, *Sea Loads on Ships
// and Offshore Structures* (1990) and Zhao, Faltinsen and Aarsnes, "Water entry of arbitrary two-dimensional sections with
// and without flow separation" (21st Symposium on Naval Hydrodynamics, 1996), which found Wagner's force high at larger
// deadrise and the exact similarity solution between it and von Karman's. Past the section's full breadth (a chine, a
// knuckle) the wetted width stops growing: the flow leaves the hull, and the impact ends.

import { sin } from '@margoengine/math/pinned';
import { validateSlamInputs } from './slamming-validation.js';
import { hullSections } from './strips.js';
import type { HullMesh } from './wetted.js';

export { validateSlamInputs } from './slamming-validation.js';

/**
 * A station's slamming table: at heights `heights` above its keel (m), Wagner's wetted half-breadth and the added mass's
 * slope dm/dh per metre of hull (kg/m^2), for the momentum force (dm/dh) V^2 a metre.
 */
export interface SlamStation {
  /** The station along the body's x and its width along x. */
  readonly x: number;
  readonly width: number;
  /** Its keel's height in the body's frame. */
  readonly keel: number;
  readonly heights: Float64Array;
  readonly wetted: Float64Array;
  readonly slope: Float64Array;
}

export interface SlamGeometry {
  readonly x: number;
  readonly width: number;
  readonly keel: number;
  readonly heights: Float64Array;
  readonly half: Float64Array;
}

// Evaluate pinned sine at the same 32 midpoint angles in both the scalar and native quadrature.
export function slamQuadratureNodes(): Float64Array {
  return Float64Array.from({ length: 32 }, (_, i) => sin((Math.PI / 2) * ((i + 0.5) / 32)));
}

/**
 * The slamming tables of a closed hull mesh (body frame, y up), one a station of `stations` along x: each section's
 * half-breadth at `levels` heights from its keel to its top, Wagner's wetted half-breadth from them, and the added mass's
 * slope.
 */
export function slamStations(mesh: HullMesh, density: number, stations = 24, levels = 48): SlamStation[] {
  validateSlamInputs(mesh, density, stations, levels);
  const nodes = slamQuadratureNodes();
  return slamGeometry(mesh, stations, levels).map((section) => scalarStation(section, density, nodes));
}

export function slamGeometry(mesh: HullMesh, stations: number, levels: number): SlamGeometry[] {
  const { vertices: v } = mesh;
  let top = -Infinity,
    bottom = Infinity;
  for (let i = 1; i < v.length; i += 3) {
    top = Math.max(top, v[i]!);
    bottom = Math.min(bottom, v[i]!);
  }
  // Each station's half-breadth at each height, from the mesh cut at that height (the breadth at the waterline there).
  const span = top - bottom,
    cuts = Array.from({ length: levels }, (_, k) => hullSections(mesh, bottom + (span * (k + 1)) / levels, stations));
  const out: SlamGeometry[] = [];
  for (let s = 0; s < stations; s++) {
    // The keel: the lowest height with any breadth (its draft at the top cut).
    const first = cuts[levels - 1]![s]!,
      keel = top - first.draft;
    if (!(first.draft > 0)) continue;
    // Half-breadth b(h) at heights h above the keel, rising (a hull that tucks in above its widest keeps its widest: the
    // flow left it there).
    const hs = [0],
      bs = [0];
    for (let k = 0; k < levels; k++) {
      const h = bottom + (span * (k + 1)) / levels - keel;
      if (!(h > 0)) continue;
      hs.push(h);
      bs.push(Math.max(bs.at(-1)!, cuts[k]![s]!.breadth / 2));
    }
    // A sheer deck can sit below the global top. Keep an entering section if any sampled cut wets it.
    if (bs.at(-1)! > 0)
      out.push({ x: first.x, width: first.width, keel, heights: Float64Array.from(hs), half: Float64Array.from(bs) });
  }
  return out;
}

function scalarStation(section: SlamGeometry, density: number, nodes: Float64Array): SlamStation {
  const { x, width, keel, heights, half } = section;
  const // f(x): the height of the section at half-breadth x, the inverse of b(h) (the first height that wide).
    f = (x: number) => {
      if (x <= 0) return 0;
      for (let k = 1; k < half.length; k++)
        if (half[k]! >= x) {
          const t = half[k]! > half[k - 1]! ? (x - half[k - 1]!) / (half[k]! - half[k - 1]!) : 1;
          return heights[k - 1]! + t * (heights[k]! - heights[k - 1]!);
        }
      return Infinity;
    },
    widest = half[half.length - 1]!,
    // Wagner's condition at depth h: the mean of f over the wetted width, by a 32-point midpoint rule in theta.
    mean = (c: number) => {
      let sum = 0;
      for (const node of nodes) sum += f(c * node);
      return sum / 32;
    },
    wetted = new Float64Array(heights.length);
  for (let k = 1; k < heights.length; k++) {
    const h = heights[k]!;
    // c with mean f(c sin theta) = h, by bisection; past the widest the flow has left the hull.
    if (mean(widest) <= h) {
      wetted[k] = widest;
      continue;
    }
    let lo = 0,
      hi = widest;
    for (let step = 0; step < 50; step++) {
      const mid = (lo + hi) / 2;
      if (mean(mid) < h) lo = mid;
      else hi = mid;
    }
    wetted[k] = (lo + hi) / 2;
  }
  // m = rho pi c^2 / 2, its slope by central differences in h (one-sided at the ends).
  const mass = Float64Array.from(wetted, (c) => (density * Math.PI * c * c) / 2),
    slope = new Float64Array(heights.length);
  for (let k = 0; k < heights.length; k++) {
    const a = Math.max(0, k - 1),
      b = Math.min(heights.length - 1, k + 1);
    slope[k] = b > a ? (mass[b]! - mass[a]!) / (heights[b]! - heights[a]!) : 0;
  }
  return { x, width, keel, heights, wetted, slope };
}

/** dm/dh of a station at depth `h` above its keel (kg/m^2), linear between its table's heights, 0 out of the water or past it. */
export function slamSlope(station: SlamStation, h: number): number {
  const { heights, slope } = station,
    n = heights.length;
  if (!(h > 0) || h >= heights[n - 1]!) return 0;
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (heights[mid]! <= h) lo = mid;
    else hi = mid;
  }
  const t = (h - heights[lo]!) / (heights[hi]! - heights[lo]!);
  return slope[lo]! + t * (slope[hi]! - slope[lo]!);
}
