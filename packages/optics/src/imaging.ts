// Image formation.
// - Thin lens 1/f = 1/s_o + 1/s_i and magnification -s_i / s_o; pinhole projection; cos^4 relative illumination:
//   Hecht, Optics, 5th ed., 2017, sections 5.2.3 and 5.7.
// - Astigmatism: tangential and sagittal focal lines with the circle of least confusion at their harmonic mean (for a
//   symmetric pupil): Born and Wolf, Principles of Optics, 7th ed., 1999, section 5.5; Hecht 2017, section 6.3.1.
// - Fresnel lens facets designed ring by ring so the ray through each facet's middle leaves parallel to the axis from a
//   source at the focus: Fresnel's lighthouse lens (1822) as described in Hecht 2017, section 5.2.5; facet angle from
//   Snell's law at the tilted exit face (prism refraction, Born and Wolf 1999, section 4.7.2).
// - Corner-cube retroreflector: three mutually perpendicular mirrors each flip one direction component, so any ray that
//   meets all three returns antiparallel (Hecht 2017, section 4.3.4).
// - Knife-edge schlieren: a deflection epsilon moves the source image by f epsilon at the knife edge, so a source image
//   of width w cut to a fraction c transmits 1 - c + f epsilon / w (clamped): G. S. Settles, Schlieren and Shadowgraph
//   Techniques, Springer 2001, chapter 3. Air index from temperature by the Gladstone-Dale relation, n - 1 proportional
//   to density (Settles 2001, section 2.2).
import { snell } from './refraction.js';
import { checkFinite, checkPositive } from './validate.js';

/** The image a thin lens forms. */
export interface ThinLensImage {
  /** Image distance (positive real, negative virtual); Infinity with the object at the focus. */
  readonly imageDistance: number;
  /** Lateral magnification -s_i / s_o. */
  readonly magnification: number;
}

/** Image of an object `objectDistance` in front of a thin lens of focal length `focalLength` (same unit). */
export function thinLens(focalLength: number, objectDistance: number): ThinLensImage {
  checkFinite('thinLens', 'focalLength', focalLength);
  checkPositive('thinLens', 'objectDistance', objectDistance);
  const inv = 1 / focalLength - 1 / objectDistance;
  const imageDistance = inv === 0 ? Infinity : 1 / inv;
  return { imageDistance, magnification: Number.isFinite(imageDistance) ? -imageDistance / objectDistance : -Infinity };
}

/** Projects point (u, v) at `sourceDistance` in front of a pinhole onto a screen `screenDistance` behind it (inverted). */
export function pinholeImage(
  u: number,
  v: number,
  sourceDistance: number,
  screenDistance: number,
  out: [number, number] = [0, 0],
): [number, number] {
  checkPositive('pinholeImage', 'sourceDistance', sourceDistance);
  const k = -screenDistance / sourceDistance;
  out[0] = u * k;
  out[1] = v * k;
  return out;
}

/** Relative irradiance cos^4(theta) off axis, for a ray of slope tan(theta) = `slope`. */
export function relativeIllumination(slope: number): number {
  checkFinite('relativeIllumination', 'slope', slope);
  const c2 = 1 / (1 + slope * slope);
  return c2 * c2;
}

/** Focal planes of an astigmatic lens. */
export interface AstigmaticFoci {
  /** Tangential (meridional) focal distance. */
  readonly tangential: number;
  /** Sagittal focal distance. */
  readonly sagittal: number;
  /** Distance of the circle of least confusion, 2 t s / (t + s). */
  readonly leastConfusion: number;
}

/** Focal planes of a lens with mean focal length `focalLength` and astigmatic difference `separation`. */
export function astigmaticFoci(focalLength: number, separation: number): AstigmaticFoci {
  checkPositive('astigmaticFoci', 'focalLength', focalLength);
  checkFinite('astigmaticFoci', 'separation', separation);
  const tangential = focalLength - separation / 2,
    sagittal = focalLength + separation / 2;
  return { tangential, sagittal, leastConfusion: (2 * tangential * sagittal) / (tangential + sagittal) };
}

/**
 * Where a pupil point (u sagittal, v tangential) lands on a screen at `distance` for a collimated beam through an
 * astigmatic lens: each direction converges to its own focal line.
 */
export function astigmaticImage(
  u: number,
  v: number,
  distance: number,
  foci: AstigmaticFoci,
  out: [number, number] = [0, 0],
): [number, number] {
  out[0] = u * (1 - distance / foci.sagittal);
  out[1] = v * (1 - distance / foci.tangential);
  return out;
}

/** Options of {@link designFresnelLens}. */
export interface FresnelLensOptions {
  /** Glass index. */
  readonly index: number;
  /** Focal distance: a point source there leaves as a parallel beam. */
  readonly focalDistance: number;
  /** Flat central disc radius. */
  readonly centerRadius: number;
  /** Radial width of each ring. */
  readonly ringWidth: number;
  /** Number of rings. */
  readonly rings: number;
  /** Glass thickness under the facets. */
  readonly baseDepth: number;
}

/** One designed facet ring. */
export interface FresnelFacet {
  readonly inner: number;
  readonly outer: number;
  /** Tilt of the exit face normal from the axis, radians. */
  readonly normal: number;
  /** Exit face slope (-tan normal). */
  readonly slope: number;
  /** Glass depth at the inner edge. */
  readonly innerDepth: number;
  /** Entry radius of the design ray. */
  readonly entry: number;
}

/** A ray through one facet of a {@link FresnelLens}. */
export interface FresnelRay {
  readonly entry: number;
  readonly incident: number;
  readonly inside: number;
  readonly depth: number;
  readonly exit: number;
  /** Exit angle from the axis, radians (0 is parallel, positive diverging). */
  readonly exterior: number;
}

/** A designed Fresnel lens. */
export interface FresnelLens {
  readonly options: FresnelLensOptions;
  readonly facets: readonly FresnelFacet[];
  /** Outer radius. */
  readonly radius: number;
  /** Traces the ray from an on-axis point source at `distance` through facet `index`. */
  trace(distance: number, index: number): FresnelRay;
  /** Radius where a traced ray crosses a plane `plane` beyond the flat face. */
  radiusAt(ray: FresnelRay, plane: number): number;
}

/** Designs a plano Fresnel lens (flat face toward the source) ring by ring, by bisection on each facet's tilt. */
export function designFresnelLens(options: FresnelLensOptions): FresnelLens {
  const { index: n, focalDistance: f, centerRadius, ringWidth, rings, baseDepth } = options;
  checkPositive('designFresnelLens', 'index', n);
  checkPositive('designFresnelLens', 'focalDistance', f);
  checkPositive('designFresnelLens', 'ringWidth', ringWidth);
  if (!Number.isInteger(rings) || rings < 1) throw new RangeError('designFresnelLens: rings must be 1 or more');
  const inside = (r: number, d: number) => snell(1, n, Math.atan2(r, d)) as number;
  const entryFor = (mid: number, depth: number) => {
    let low = 0,
      high = mid;
    for (let i = 0; i < 32; i++) {
      const r = (low + high) / 2;
      if (r + depth * Math.tan(inside(r, f)) < mid) low = r;
      else high = r;
    }
    return (low + high) / 2;
  };
  const facets: FresnelFacet[] = [];
  for (let i = 0; i < rings; i++) {
    const inner = centerRadius + ringWidth * i,
      outer = inner + ringWidth,
      half = ringWidth / 2,
      mid = inner + half;
    let low = 0,
      high = 1;
    for (let k = 0; k < 38; k++) {
      const beta = (low + high) / 2;
      const t = inside(entryFor(mid, baseDepth + half * Math.tan(beta)), f);
      const required = Math.atan2(n * Math.sin(t), n * Math.cos(t) - 1);
      if (beta < required) low = beta;
      else high = beta;
    }
    const normal = (low + high) / 2,
      slope = -Math.tan(normal);
    facets.push({
      inner,
      outer,
      normal,
      slope,
      innerDepth: baseDepth - (outer - inner) * slope,
      entry: entryFor(mid, baseDepth - half * slope),
    });
  }
  return {
    options,
    facets,
    radius: centerRadius + ringWidth * rings,
    trace(distance, i) {
      const facet = facets[i];
      if (!facet) throw new RangeError(`FresnelLens.trace: no facet ${i}`);
      const entry = facet.entry,
        incident = Math.atan2(entry, distance),
        t = inside(entry, distance);
      const tangent = Math.tan(t);
      const depth = (facet.innerDepth + facet.slope * (entry - facet.inner)) / (1 - facet.slope * tangent);
      const s = n * Math.sin(t - facet.normal);
      const exterior = facet.normal + (Math.abs(s) <= 1 ? Math.asin(s) : Math.sign(s) * (Math.PI / 2));
      return { entry, incident, inside: t, depth, exit: entry + depth * tangent, exterior };
    },
    radiusAt(ray, plane) {
      return ray.exit + (plane - ray.depth) * Math.tan(ray.exterior);
    },
  };
}

/** One mirror bounce inside a corner cube. */
export interface CornerHit {
  /** Mirror plane hit (0 x = 0, 1 y = 0, 2 z = 0). */
  readonly axis: 0 | 1 | 2;
  readonly position: readonly [number, number, number];
  /** Direction after the bounce. */
  readonly direction: readonly [number, number, number];
}

/** A ray traced through a corner cube. */
export interface CornerTrace {
  readonly hits: readonly CornerHit[];
  /** Exit point on the aperture plane x + y + z = aperture. */
  readonly exit: readonly [number, number, number];
  /** Exit direction (the reverse of the incoming one when all three mirrors are hit). */
  readonly direction: readonly [number, number, number];
}

/**
 * Traces a ray inside a hollow corner cube whose mirrors are the planes x = 0, y = 0 and z = 0 (cube frame, corner at
 * the origin) from `start` (inside, on or below the aperture plane x + y + z = aperture) along `direction` until it
 * leaves through the aperture plane. Returns null if the ray escapes past an edge without returning (at most 3 bounces).
 */
export function cornerCubeReflect(
  start: readonly [number, number, number],
  direction: readonly [number, number, number],
  aperture: number,
): CornerTrace | null {
  checkPositive('cornerCubeReflect', 'aperture', aperture);
  let p: [number, number, number] = [start[0], start[1], start[2]];
  const d: [number, number, number] = [direction[0], direction[1], direction[2]];
  const hits: CornerHit[] = [];
  for (let step = 0; step <= 3; step++) {
    const along = d[0] + d[1] + d[2];
    const exitTime = along > 0 ? (aperture - (p[0] + p[1] + p[2])) / along : Infinity;
    let time = Infinity,
      axis: 0 | 1 | 2 = 0;
    for (const a of [0, 1, 2] as const) {
      if (d[a] < 0) {
        const t = -p[a] / d[a];
        if (t < time) {
          time = t;
          axis = a;
        }
      }
    }
    if (exitTime < time) {
      return {
        hits,
        exit: [p[0] + d[0] * exitTime, p[1] + d[1] * exitTime, p[2] + d[2] * exitTime],
        direction: [...d],
      };
    }
    if (!Number.isFinite(time)) return null;
    p = [p[0] + d[0] * time, p[1] + d[1] * time, p[2] + d[2] * time];
    p[axis] = 0;
    d[axis] = -d[axis];
    hits.push({ axis, position: [...p], direction: [...d] });
  }
  return null;
}

/** dn/dT per kelvin of air at index `ambientIndex` and temperature `ambientKelvin` (Gladstone-Dale at fixed pressure). */
export function airIndexTemperatureSlope(ambientIndex: number, ambientKelvin: number): number {
  checkPositive('airIndexTemperatureSlope', 'ambientKelvin', ambientKelvin);
  return -(ambientIndex - 1) / ambientKelvin;
}

/** Options of {@link knifeEdgeTransmission}. */
export interface KnifeEdgeOptions {
  /** Fraction of the source image the knife edge cuts off, 0..1. */
  readonly cutoff: number;
  /** Focal length of the schlieren mirror or lens (m). */
  readonly focalLength: number;
  /** Width of the source image at the knife edge (m). */
  readonly sourceWidth: number;
}

/** Image brightness 0..1 at a point whose ray is deflected `deflection` radians toward the uncut side. */
export function knifeEdgeTransmission(deflection: number, options: KnifeEdgeOptions): number {
  checkPositive('knifeEdgeTransmission', 'sourceWidth', options.sourceWidth);
  const v = 1 - options.cutoff + (deflection * options.focalLength) / options.sourceWidth;
  return Math.max(0, Math.min(1, v));
}
