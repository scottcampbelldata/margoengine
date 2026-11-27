// A hull's sections and the added mass of the water they move (SEA-08). Strip theory: a slender hull's motion in heave,
// pitch, sway and yaw is the sum of its cross sections' two-dimensional motions (Salvesen, Tuck and Faltinsen, "Ship motions
// and sea loads", 1970; Journee and Massie, *Offshore Hydromechanics*, TU Delft 2001, sections 7.3 and 8.3). Each section of
// the hull under its still waterline is mapped to a Lewis form, the two-parameter conformal map of a half circle
// (Journee and Massie eqs. 7.88-7.95, after Lewis, "The inertia of the water surrounding a vibrating ship", SNAME 1929): its
// breadth B, its draft T and its area coefficient sigma = A / (B T) fix the map's a1 and a3. At high frequency the free
// surface holds the potential at zero, so a heaving section moves the water as half of its mirrored double body in an
// unbounded fluid does: rho pi B^2 / 8 times Lewis's coefficient ((1 + a1)^2 + 3 a3^2) / (1 + a1 + a3)^2, which meets the exact
// limits of a half circle (rho pi R^2 / 2) and of a flat plate on the surface (rho pi B^2 / 8, half the unbounded plate's
// rho pi (B/2)^2). In sway the mirror image moves the other way at high frequency, so the double body is not rigid and the
// limit is smaller (radiation.ts finds it): rho pi T^2 / 2 times ((1 - a1)^2 + 3 a3^2) / (1 - a1 + a3)^2 is the sway added
// mass under a rigid lid, the zero-frequency limit, where the image moves with the section (a vertical plate: rho pi T^2 / 2).
// The sections then add along the hull to the added mass the rigid body carries with it (Journee and Massie eq. 8.25 at
// zero speed). Each section's breadth, draft and area come from the mesh cut by the plane of the station (Green's theorem
// over the cut's segments under the waterline).

/**
 * A hull section: its station along the body's x, its width along x, its breadth, draft and area under the waterline, and
 * the depth of its area's centroid under the waterline.
 */
export interface Section {
  readonly x: number;
  readonly width: number;
  readonly breadth: number;
  readonly draft: number;
  readonly area: number;
  readonly centroid: number;
}

/** A Lewis form: the scale M and the coefficients a1, a3 of z = M (zeta + a1 / zeta + a3 / zeta^3). */
export interface LewisForm {
  readonly scale: number;
  readonly a1: number;
  readonly a3: number;
  /** The area coefficient the map was made with, once held to Lewis's range. */
  readonly sigma: number;
}

/**
 * The sections of a closed hull mesh (vertices x, y, z in the body's frame, triangles wound outward) under the body-frame
 * waterline y = `waterline`: `count` stations of equal width along x, each cut through its middle.
 */
export function hullSections(
  mesh: { readonly vertices: ArrayLike<number>; readonly indices: ArrayLike<number> },
  waterline: number,
  count = 24,
): Section[] {
  return measureSections(mesh, waterline, count);
}

type SectionMesh = { readonly vertices: ArrayLike<number>; readonly indices: ArrayLike<number> };

/** Wet section areas and first lateral moments, using the same outline as the hydrostatic strips. */
export function hullSectionMoments(mesh: SectionMesh, waterline: number, count: number) {
  const lateralMoments = new Float64Array(count);
  return { sections: measureSections(mesh, waterline, count, lateralMoments), lateralMoments };
}

function measureSections(
  mesh: SectionMesh,
  waterline: number,
  count: number,
  lateralMoments?: Float64Array,
): Section[] {
  const { vertices, indices } = mesh;
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    lo = Math.min(lo, vertices[i]!);
    hi = Math.max(hi, vertices[i]!);
  }
  const width = (hi - lo) / count,
    out: Section[] = [];
  for (let s = 0; s < count; s++) {
    const x = lo + (s + 0.5) * width;
    let area = 0,
      moment = 0,
      lateralMoment = 0,
      zmin = Infinity,
      zmax = -Infinity,
      ymin = Infinity;
    for (let k = 0; k + 2 < indices.length; k += 3) {
      // The segment where the plane x = const crosses the triangle, in the triangle's turn (so the cut runs round the hull's
      // section one way, and Green's theorem gives its area).
      const p = [indices[k]!, indices[k + 1]!, indices[k + 2]!].map((i) => [
        vertices[3 * i]!,
        vertices[3 * i + 1]!,
        vertices[3 * i + 2]!,
      ]);
      let negativeToPositive: [number, number] | undefined,
        positiveToNegative: [number, number] | undefined;
      for (let e = 0; e < 3; e++) {
        const a = p[e]!,
          b = p[(e + 1) % 3]!,
          da = a[0]! - x,
          db = b[0]! - x;
        if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
          const t = da / (da - db);
          const crossing: [number, number] = [a[1]! + t * (b[1]! - a[1]!), a[2]! + t * (b[2]! - a[2]!)];
          if (da < 0) negativeToPositive = crossing;
          else positiveToNegative = crossing;
        }
      }
      // Orient the cut by the direction of each crossing, independently of the triangle's starting corner.
      if (!negativeToPositive || !positiveToNegative) continue;
      let [y0, z0] = negativeToPositive,
        [y1, z1] = positiveToNegative;
      // Keep the part under the waterline.
      if (y0 > waterline && y1 > waterline) continue;
      if (y0 > waterline || y1 > waterline) {
        const t = (waterline - y0) / (y1 - y0),
          zc = z0 + t * (z1 - z0);
        if (y0 > waterline) [y0, z0] = [waterline, zc];
        else [y1, z1] = [waterline, zc];
      }
      // Green: the area is the integral of z dy round the section (the waterline adds nothing, dy being 0 along it).
      area += 0.5 * (z0 + z1) * (y1 - y0);
      // and its first moment about y = 0, the integral of y z dy (z linear along the segment).
      moment += ((y1 - y0) * (z0 * (2 * y0 + y1) + z1 * (y0 + 2 * y1))) / 6;
      if (lateralMoments) lateralMoment += ((y1 - y0) * (z0 * z0 + z0 * z1 + z1 * z1)) / 6;
      ymin = Math.min(ymin, y0, y1);
      for (const [y, z] of [
        [y0, z0],
        [y1, z1],
      ] as const)
        if (Math.abs(y - waterline) <= 1e-9 * (1 + Math.abs(waterline)) || y === waterline) {
          zmin = Math.min(zmin, z);
          zmax = Math.max(zmax, z);
        }
    }
    const draft = ymin < waterline ? waterline - ymin : 0;
    if (lateralMoments) lateralMoments[s] = area < 0 ? -lateralMoment : lateralMoment;
    out.push({
      x,
      width,
      breadth: zmax > zmin ? zmax - zmin : 0,
      draft,
      area: Math.abs(area),
      centroid: area !== 0 ? waterline - moment / area : 0,
    });
  }
  return out;
}

/**
 * The Lewis form of a section of breadth B, draft T and area A (Journee and Massie eqs. 7.89-7.95): the area coefficient
 * held to Lewis's range for its breadth-to-draft ratio, which keeps the map's contour from looping.
 */
export function lewisForm(breadth: number, draft: number, area: number): LewisForm {
  const h0 = Math.min(100, Math.max(0.01, breadth / (2 * draft))),
    low = h0 <= 1 ? ((3 * Math.PI) / 32) * (2 - h0) : ((3 * Math.PI) / 32) * (2 - 1 / h0),
    high = (Math.PI / 32) * (10 + h0 + 1 / h0),
    sigma = Math.min(high, Math.max(low, area / (breadth * draft))),
    r = (h0 - 1) / (h0 + 1),
    c1 = 3 + (4 * sigma) / Math.PI + (1 - (4 * sigma) / Math.PI) * r * r,
    a3 = (-c1 + 3 + Math.sqrt(9 - 2 * c1)) / c1,
    a1 = r * (a3 + 1);
  return { scale: breadth / 2 / (1 + a1 + a3), a1, a3, sigma };
}

/** The heave added mass per metre of a Lewis section of breadth B at infinite frequency, kg/m. */
export function heaveAddedMassInfinite(breadth: number, form: LewisForm, density: number): number {
  const { a1, a3 } = form;
  return (
    ((density * Math.PI * breadth * breadth) / 8) *
    (((1 + a1) * (1 + a1) + 3 * a3 * a3) / ((1 + a1 + a3) * (1 + a1 + a3)))
  );
}

/** The sway added mass per metre of a Lewis section of draft T under a rigid lid (the zero-frequency limit), kg/m. */
export function swayAddedMassRigidLid(draft: number, form: LewisForm, density: number): number {
  const { a1, a3 } = form;
  return (
    ((density * Math.PI * draft * draft) / 2) * (((1 - a1) * (1 - a1) + 3 * a3 * a3) / ((1 - a1 + a3) * (1 - a1 + a3)))
  );
}

/**
 * The hull's heave and pitch added mass at infinite frequency, 6 by 6 (row-major), in the body's frame about `centre`
 * (x, y, z): rows and columns surge, heave (y), sway (z), roll (about x), yaw (about y), pitch (about z). Only the heave,
 * the pitch and their coupling are filled, from the sections' heave added mass; the lateral block (sway, roll, yaw) comes
 * from the sections' radiation (memory.ts), as its high-frequency limit needs the full solution.
 */
export function addedMassInfinite(
  sections: readonly Section[],
  centre: readonly [number, number, number],
  density: number,
): Float64Array {
  const a = new Float64Array(36),
    at = (r: number, c: number) => r * 6 + c;
  for (const s of sections) {
    if (!(s.breadth > 0 && s.draft > 0)) continue;
    const form = lewisForm(s.breadth, s.draft, s.area),
      heave = heaveAddedMassInfinite(s.breadth, form, density) * s.width,
      x = s.x - centre[0];
    // Heave y and pitch about z: a pitch rate w_z moves the section along y at w_z x.
    a[at(1, 1)]! += heave;
    a[at(1, 5)]! += heave * x;
    a[at(5, 1)]! += heave * x;
    a[at(5, 5)]! += heave * x * x;
  }
  return a;
}
