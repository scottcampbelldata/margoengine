// One bounce of light from point, spot and opening lights (`@margoengine/clustered/bounce`): the CPU half, no GPU.
//
// Capture: a reflective shadow map (C. Dachsbacher and M. Stamminger, "Reflective Shadow Maps", I3D 2005,
// doi:10.1145/1053427.1053460). Each bouncing source is drawn from its own position into a few square views; a texel
// holds the diffuse albedo of the first surface along its ray and that surface's distance (0: nothing there).
// Reduce: instant radiosity (A. Keller, "Instant Radiosity", SIGGRAPH 1997, doi:10.1145/258734.258769). Each texel's
// surface patch reflects flux = albedo x irradiance x area; the texels, walked in Morton order, are cut into strata of
// equal flux that seed a k-means clustering in position and normal (Prutkin, Kaplanyan and Dachsbacher, "Reflective
// Shadow Map Clustering for Real-Time Global Illumination", EG 2012 short papers, doi:10.2312/conf/EG2012/short/009-012);
// each cluster becomes one virtual point light (VPL) at its flux-weighted centre with its mean normal, carrying the
// cluster's flux and area. No random seeds: the same input always gives the same VPLs, so a still scene cannot flicker.
// Gather: E(x) = sum_j flux_j max(n_j.w, 0) max(-n.w, 0) / (pi r^2 + A_j), w the unit vector from the VPL to x. The
// + A_j is the form factor of a disc of area A_j (J. R. Wallace, K. A. Elmquist and E. A. Haines, "A Ray Tracing
// Algorithm for Progressive Radiosity", SIGGRAPH 1989, doi:10.1145/74334.74366): no spike next to a VPL.
// Visibility: imperfect shadow maps (T. Ritschel, T. Grosch, M. H. Kim, H.-P. Seidel, C. Dachsbacher and J. Kautz,
// "Imperfect Shadow Maps for Efficient Computation of Indirect Illumination", SIGGRAPH Asia 2008,
// doi:10.1145/1409060.1409082): every VPL gets a small paraboloid depth map (S. Brabec, T. Annen and H.-P. Seidel,
// "Shadow Mapping for Hemispherical and Omnidirectional Light Sources", CGI 2002) of a point sampling of the scene,
// each point splatted with its own footprint. The points are the captures' texels: every surface a bouncing source
// sees, which holds every VPL and every surface between a lit surface and what it lights round the source. A receiver
// is read with a normal offset (Holbert 2011, as the local shadows).
// Openings (`openingLight` of `@margoengine/clustered/area`) count the room's light once: see `BounceOpening`.

/** A square view of a capture: an eye, its unit forward and up, and the tangent of half its field of view. */
export interface BounceView {
  readonly eye: readonly number[];
  readonly forward: readonly number[];
  readonly up: readonly number[];
  /** tan(fov / 2): 1 for a cube face. */
  readonly tan: number;
}
/** What a source's capture holds: `views.length` square images of `resolution` texels, rows from the top. */
export interface BounceCapture {
  readonly views: readonly BounceView[];
  readonly resolution: number;
  /** Per texel: diffuse albedo r, g, b, then the distance from the view's eye to the surface (0: nothing there). */
  readonly texels: Float32Array;
}
/** A point or spot light as clustered shades it (inverse square or `decay`, the range window, the cone). */
export interface BouncePointSource {
  readonly kind: 'point';
  readonly position: readonly number[];
  /** The range window's end; 0 or less is unlimited. */
  readonly range: number;
  /** Falloff exponent; 2 is the inverse square. */
  readonly decay?: number;
  /** A spot's unit axis, with `cosOuter` and `cosInner`. */
  readonly direction?: readonly number[];
  readonly cosOuter?: number;
  readonly cosInner?: number;
  /**
   * The light's emitted intensity toward world point `p` relative to its plain falloff and cone, per channel: its
   * clustered light terms' CPU twins (an IES profile, a projector or cube image, its layers; `lightEmission` of
   * `@margoengine/clustered/bounce`). Absent: 1, the plain point or spot light.
   */
  readonly emission?: (p: readonly number[]) => readonly number[];
}
/** A one-sided rectangle of uniform radiance (an opening's light), emitting along `normal`. */
export interface BounceRectSource {
  readonly kind: 'rect';
  readonly position: readonly number[];
  readonly normal: readonly number[];
  /** Half extents, along the rectangle. */
  readonly u: readonly number[];
  readonly v: readonly number[];
  /** The light's `RectAreaLight.recess` and `sill` (default 0): its wall's opening shades it (`apertureWindow`). */
  readonly recess?: number;
  readonly sill?: number;
  /**
   * How far in front of `position` the capture must stand to clear the opening's glazing bars, metres (default 0): the
   * bars' front faces plus the capture camera's near distance, which would otherwise clip them and let it see into
   * them. The capture looks out from the centre moved along `normal` by this or `recess`, whichever is further: the
   * opening's mouth, in the open air (KB-BOUNCE-CAPEYE1).
   */
  readonly front?: number;
}
/** A source that bounces: a point or spot light, or an opening's rectangle. */
export type BounceSource = BouncePointSource | BounceRectSource;
/**
 * An opening of a room whose light leaves through it as an `openingLight` (`@margoengine/clustered/area`). That light
 * is the integrating-sphere radiance of the room's inter-reflected light, all orders from the first, plus with
 * `frosted` glass the lamps' direct light on the pane re-emitted diffusely (tau_d E / pi). So each path through the
 * opening is counted once, by the opening light: (1) a VPL on the room side never lights anything through the opening
 * (its first-order light is in the opening's radiance), and (2) with frosted glass a lamp's capture stops at the
 * opening (its beam is the pane's diffuse term; the lamp's shadow map stops it too), so nothing past it is lit by the
 * lamp's bounce. With clear glass the lamp's beam passes (the opening light leaves it out) and lights what it falls
 * on outside, which bounces. The opening light itself bounces off what it lights outside, a source of its own.
 */
export interface BounceOpening {
  readonly position: readonly number[];
  /** Unit outward normal (the way out of the room). */
  readonly normal: readonly number[];
  readonly u: readonly number[];
  readonly v: readonly number[];
  readonly frosted: boolean;
  /** The light's `RectAreaLight.recess` and `sill` (default 0). */
  readonly recess?: number;
  readonly sill?: number;
}
/** A virtual point light: position, unit normal, flux per unit of its source (rgb), the area it stands for. */
export interface BounceVpl {
  readonly position: [number, number, number];
  readonly normal: [number, number, number];
  readonly flux: [number, number, number];
  readonly area: number;
  /** Index of its source in the list given to {@link packBounce}. */
  readonly source: number;
}
/** A point of the visibility sampling: a surface point, its unit normal and the area it stands for. */
export interface BouncePoint {
  readonly position: [number, number, number];
  readonly normal: [number, number, number];
  readonly area: number;
  /**
   * The unit ray it was seen along, from its capture's eye. Its patch is 1 / cos longer along the ray's projection on
   * the surface than across it, so {@link buildVisibility} splats it as an ellipse; without it, a disc of its area.
   */
  readonly ray?: [number, number, number];
  /** The surfel's radius when it is known to cover its patch ({@link sampleSurfaces}): drawn as that disc, unscaled. */
  readonly reach?: number;
  /** A triangle's three corners (9 numbers, world), drawn exactly: each texel's centre ray against it. */
  readonly corners?: readonly number[];
}
/** A triangle mesh for {@link sampleSurfaces}: core's interleaved vertices (position then normal, 6 floats each). */
export interface BounceMesh {
  readonly vertices: Float32Array;
  readonly indices: ArrayLike<number>;
  /** Column-major 4 x 4 world matrix. */
  readonly matrix: ArrayLike<number>;
}
/** {@link reduceBounce} settings. */
export interface ReduceOptions {
  /** VPLs to make, at most. */
  readonly vpls: number;
  /** Surfaces nearer the eye than this are skipped (a lamp's own fixture). */
  readonly near: number;
  readonly openings?: readonly BounceOpening[];
  /** Index stored on the VPLs. Default 0. */
  readonly source?: number;
}

type V3 = readonly number[];
const WHITE = [1, 1, 1] as const;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross = (a: V3, b: V3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unit = (a: V3): [number, number, number] => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };

/** The six cube faces (+X, -X, +Y, -Y, +Z, -Z) as forward and up, in the order of core's cube cameras. */
export const CUBE_FACES: readonly (readonly [V3, V3])[] = [
  [[1, 0, 0], [0, 1, 0]],
  [[-1, 0, 0], [0, 1, 0]],
  [[0, 1, 0], [0, 0, -1]],
  [[0, -1, 0], [0, 0, 1]],
  [[0, 0, 1], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0]],
];
/**
 * Where an opening's capture looks out from (KB-BOUNCE-CAPEYE1): its centre moved out along its normal past its glazing
 * bars (`front`) and to its wall's outer face (`recess`), whichever stands further out. At the rectangle's centre the
 * eye stood inside a crossing of bars; the capture camera's near plane clipped the faces round it and the capture,
 * which draws back faces, saw along the bars to their inner faces and took them for lit surfaces. Everything the
 * opening lights outside lies in front of its mouth, and the line from the mouth's centre to it crosses no part of the
 * reveal (a sill standing proud still shades, as it does the light).
 */
const rectEye = (source: BounceRectSource): readonly number[] => {
  const d = Math.max(source.recess ?? 0, source.front ?? 0);
  return d > 0 ? [0, 1, 2].map((k) => source.position[k] + source.normal[k] * d) : source.position;
};
/**
 * The views that capture a source: a point light's six cube faces; a spot of 45 degrees or less, one view fitted to its
 * cone; a wider spot, the cube faces that see its cone; an opening, the five faces that see out of it, from its mouth.
 */
export function bounceViews(source: BounceSource): BounceView[] {
  const eye = source.kind === 'rect' ? rectEye(source) : source.position;
  if (source.kind === 'point' && source.direction && (source.cosOuter ?? -1) >= Math.SQRT1_2) {
    const forward = unit(source.direction),
      up = Math.abs(forward[1]) > 0.99 ? [0, 0, -1] : [0, 1, 0],
      right = unit(cross(forward, up)),
      sin = Math.sqrt(Math.max(0, 1 - source.cosOuter! ** 2));
    return [{ eye, forward, up: cross(right, forward), tan: sin / Math.max(source.cosOuter!, 1e-6) }];
  }
  const axis = source.kind === 'rect' ? source.normal : source.direction;
  return CUBE_FACES.filter(([forward]) => {
    if (!axis) return true;
    // A face sees the cone (or the half space) unless the whole face lies behind it: its nearest ray to the axis.
    const c = dot(forward, unit(axis));
    return source.kind === 'rect' ? c > -0.5 : Math.acos(Math.min(1, c)) - Math.atan(Math.SQRT2) < Math.acos(source.cosOuter ?? -1);
  }).map(([forward, up]) => ({ eye, forward, up, tan: 1 }));
}
/** The unit ray through texel (i, j) of `view` at `resolution`, row 0 at the top. */
export function texelRay(view: BounceView, resolution: number, i: number, j: number): [number, number, number] {
  const x = (((i + 0.5) / resolution) * 2 - 1) * view.tan,
    y = (1 - ((j + 0.5) / resolution) * 2) * view.tan,
    right = cross(view.forward, view.up);
  return unit([0, 1, 2].map((k) => view.forward[k] + x * right[k] + y * view.up[k]));
}
/**
 * Solid angle of texel (i, j): the integral of dA / (1 + x^2 + y^2)^(3/2) over the texel's square on the plane at unit
 * distance, F(x1, y1) - F(x0, y1) - F(x1, y0) + F(x0, y0) with F(x, y) = atan(x y / sqrt(1 + x^2 + y^2)). Exact; the
 * texels of a cube sum to 4 pi.
 */
export function texelSolidAngle(tan: number, resolution: number, i: number, j: number): number {
  const at = (k: number) => ((k / resolution) * 2 - 1) * tan,
    F = (x: number, y: number) => Math.atan2(x * y, Math.sqrt(1 + x * x + y * y)),
    x0 = at(i),
    x1 = at(i + 1),
    y0 = at(j),
    y1 = at(j + 1);
  return Math.abs(F(x1, y1) - F(x0, y1) - F(x1, y0) + F(x0, y0));
}
/** The point light's falloff and cone at `x`, as clustered's light loop (the window, the inverse square or `decay`). */
export function pointFalloff(source: BouncePointSource, x: V3): number {
  const d = Math.hypot(source.position[0] - x[0], source.position[1] - x[1], source.position[2] - x[2]),
    reach = source.range > 0 ? d / source.range : 0,
    fade = Math.min(1, Math.max(0, 1 - reach ** 4)),
    falloff = (fade * fade) / Math.max(source.decay === undefined ? d * d : d ** source.decay, 2 ** -12);
  if (!source.direction) return falloff;
  const along = dot(unit(sub(x, source.position)), unit(source.direction)),
    lo = source.cosOuter ?? -1,
    hi = source.cosInner ?? lo;
  if (!(hi > lo)) return along >= lo ? falloff : 0;
  const t = Math.min(1, Math.max(0, (along - lo) / (hi - lo)));
  return falloff * t * t * (3 - 2 * t);
}
/**
 * The part of a one-sided rectangle a point sees through its wall's opening (`RectAreaLight.recess` and `sill`):
 * `[x0, y0, x1, y1]` within [-1, 1] in units of the half extents along `right` and `up`, or null when it sees none.
 * `q` is the point across and up in those units, `z` its distance in front of the rectangle (above 0). The opening's
 * outline `recess` in front, projected from the point onto the light, is the outline scaled by z / (z - recess) about
 * the point's foot; the sill's front edge, level with the lower edge, bounds y the same way from `recess + sill`. A
 * point inside the opening (z up to `recess`) sees the whole light, one beside it sees none, and one under the sill
 * behind its front edge sees none. `AreaLights`' shader (`@margoengine/clustered/area`) is its twin.
 */
export function apertureWindow(q: readonly [number, number], z: number, recess: number, sill: number): [number, number, number, number] | null {
  let x0 = -1,
    y0 = -1,
    x1 = 1,
    y1 = 1;
  if (z > recess) {
    const k = z / Math.max(z - recess, 1e-6);
    x0 = Math.max(x0, q[0] - (1 + q[0]) * k);
    y0 = Math.max(y0, q[1] - (1 + q[1]) * k);
    x1 = Math.min(x1, q[0] + (1 - q[0]) * k);
    y1 = Math.min(y1, q[1] + (1 - q[1]) * k);
  } else if (Math.abs(q[0]) > 1.001 || Math.abs(q[1]) > 1.001) return null;
  if (sill > 0) {
    if (z > recess + sill) y0 = Math.max(y0, q[1] - ((1 + q[1]) * z) / Math.max(z - recess - sill, 1e-6));
    else if (z > recess && q[1] < -1) return null;
  }
  return x0 < x1 && y0 < y1 ? [x0, y0, x1, y1] : null;
}
/**
 * Irradiance at `x` (unit normal `n`) from a one-sided rectangle of unit radiance: Lambert's polygon formula
 * E = 1/2 sum_i theta_i n.(r_i x r_i+1) / |r_i x r_i+1| (J. Arvo, "The Irradiance Jacobian for Partially Occluded
 * Polyhedral Sources", SIGGRAPH 1994, doi:10.1145/192161.192250, equation 1), over the rectangle clipped to the
 * receiver's upper half space. 0 behind the rectangle. With a `recess` or `sill`, the rectangle is first clipped to
 * the part `x` sees through its wall's opening ({@link apertureWindow}).
 */
export function rectIrradiance(source: BounceRectSource | BounceOpening, x: V3, n: V3): number {
  const c = source.position,
    w = sub(x, c),
    z = dot(w, source.normal);
  if (z <= 0) return 0;
  const recess = source.recess ?? 0,
    sill = source.sill ?? 0,
    clip = recess > 0 || sill > 0 ? apertureWindow([dot(w, source.u) / dot(source.u, source.u), dot(w, source.v) / dot(source.v, source.v)], z, recess, sill) : [-1, -1, 1, 1];
  if (!clip) return 0;
  const [x0, y0, x1, y1] = clip;
  let poly: number[][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([a, b]) => sub([0, 1, 2].map((k) => c[k] + a * source.u[k] + b * source.v[k]), x));
  // Sutherland-Hodgman against the plane n.p = 0.
  const out: number[][] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length],
      dp = dot(n, p),
      dq = dot(n, q);
    if (dp >= 0) out.push(p);
    if (dp >= 0 !== dq >= 0) {
      const t = dp / (dp - dq);
      out.push([0, 1, 2].map((k) => p[k] + t * (q[k] - p[k])));
    }
  }
  poly = out;
  if (poly.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = unit(poly[i]),
      b = unit(poly[(i + 1) % poly.length]),
      g = cross(a, b),
      s = Math.hypot(g[0], g[1], g[2]);
    if (s < 1e-12) continue;
    sum += (Math.atan2(s, dot(a, b)) * dot(n, g)) / s;
  }
  return Math.abs(sum) / 2;
}
/** Whether the segment from `a` to `b` passes through the opening's rectangle. */
export function crossesOpening(opening: BounceOpening, a: V3, b: V3): boolean {
  const da = dot(sub(a, opening.position), opening.normal),
    db = dot(sub(b, opening.position), opening.normal);
  if (da > 0 === db > 0 || da === db) return false;
  const t = da / (da - db),
    p = sub([0, 1, 2].map((k) => a[k] + t * (b[k] - a[k])), opening.position);
  return Math.abs(dot(p, opening.u)) <= dot(opening.u, opening.u) && Math.abs(dot(p, opening.v)) <= dot(opening.v, opening.v);
}
/**
 * Weight of a texel's offset from a cluster's plane in the reduction's distance, against its distance along the plane
 * (KB-BOUNCE-CLUSTER1). On the Cabin Hearth captures (test/fixtures/cabin-bounce-captures.json) 32 VPLs light the log
 * crest at 0.55 (the window) and 0.83 (the lantern) of the texels' own sum with 0, 0.87 to 0.94 with 2 to 128; 8.
 */
const PLANE = 8;
/** 1 - cos of the angle between two steps: 0 when they run straight on. */
const bend = (a: V3, b: V3): number => 1 - dot(a, b) / Math.max(Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]), 1e-30);
/** Morton (Z-order) index of (x, y), 16 bits each. */
const morton = (x: number, y: number): number => {
  const spread = (v: number) => {
    v = (v | (v << 8)) & 0x00ff00ff;
    v = (v | (v << 4)) & 0x0f0f0f0f;
    v = (v | (v << 2)) & 0x33333333;
    return (v | (v << 1)) & 0x55555555;
  };
  return (spread(x) | (spread(y) << 1)) >>> 0;
};
/**
 * Reduces one source's capture to at most `vpls` VPLs, lists the captured surface points for the visibility maps, and
 * sums the flux the texels reflect (`flux`, which the VPLs carry in full).
 * Per texel: the surface point from its distance, its normal from its neighbours (on each axis the side with the smaller
 * jump), area d^2 omega / max(cos, 0.1), irradiance per unit source (`pointFalloff` times the cosine and the
 * source's `emission` toward it, or `rectIrradiance`), flux = albedo x irradiance x area. Same input, same output.
 */
export function reduceBounce(
  capture: BounceCapture,
  source: BounceSource,
  { vpls: count, near, openings = [], source: index = 0 }: ReduceOptions,
): { vpls: BounceVpl[]; points: BouncePoint[]; flux: [number, number, number] } {
  const res = capture.resolution,
    texels = capture.texels,
    order: number[] = [],
    keys: number[] = [];
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) keys[j * res + i] = morton(i, j);
  for (let i = 0; i < res * res; i++) order.push(i);
  order.sort((a, b) => keys[a] - keys[b]);
  const points: BouncePoint[] = [],
    lit: { p: [number, number, number]; n: [number, number, number]; flux: number[]; area: number; weight: number }[] = [],
    reflected: [number, number, number] = [0, 0, 0];
  const frosted = source.kind === 'point' ? openings.filter((o) => o.frosted) : [];
  capture.views.forEach((view, face) => {
    const base = face * res * res,
      distance = (i: number, j: number) => (i < 0 || j < 0 || i >= res || j >= res ? 0 : texels[(base + j * res + i) * 4 + 3]),
      at = (i: number, j: number, d: number) => {
        const r = texelRay(view, res, i, j);
        return [0, 1, 2].map((k) => view.eye[k] + r[k] * d);
      };
    for (const t of order) {
      const i = t % res,
        j = (t / res) | 0,
        d = distance(i, j);
      if (!(d > near)) continue;
      const ray = texelRay(view, res, i, j),
        p: [number, number, number] = [0, 1, 2].map((k) => view.eye[k] + ray[k] * d) as [number, number, number];
      // Tangents on each axis from the side that stays on this texel's plane (KB-BOUNCE-SHADOWSNOW1). A row of texel
      // rays lies in one plane through the eye, so three texels on one flat surface are collinear in 3D; the side
      // whose next two texels bend least stays on the surface, where the smaller distance jump alone took the floor's
      // neighbour at a wall's foot and tilted the wall's bottom row 27 degrees. The smaller jump decides only when a
      // side lacks its second texel or both bend alike.
      const side = (di: number, dj: number) => {
        const a = distance(i + di, j + dj),
          b = distance(i - di, j - dj);
        if (!(a > 0) && !(b > 0)) return undefined;
        const pa = a > 0 ? at(i + di, j + dj, a) : undefined,
          pb = b > 0 ? at(i - di, j - dj, b) : undefined;
        if (!pa || !pb) return pa ? sub(pa, p) : sub(p, pb as V3);
        const a2 = distance(i + 2 * di, j + 2 * dj),
          b2 = distance(i - 2 * di, j - 2 * dj);
        if (a2 > 0 && b2 > 0) {
          const ta = sub(pa, p),
            tb = sub(p, pb),
            ba = bend(ta, sub(at(i + 2 * di, j + 2 * dj, a2), pa)),
            bb = bend(sub(pb, at(i - 2 * di, j - 2 * dj, b2)), tb);
          if (Math.abs(ba - bb) > 1e-3) return ba < bb ? ta : tb;
        }
        return Math.abs(a - d) <= Math.abs(b - d) ? sub(pa, p) : sub(p, pb);
      };
      const tx = side(1, 0),
        ty = side(0, 1);
      let n = tx && ty ? unit(cross(tx, ty)) : [-ray[0], -ray[1], -ray[2]];
      if (dot(n, ray) > 0) n = [-n[0], -n[1], -n[2]];
      const cos = -dot(n, ray),
        area = (d * d * texelSolidAngle(view.tan, res, i, j)) / Math.max(cos, 0.1);
      points.push({ position: p, normal: n as [number, number, number], area, ray });
      if (frosted.some((o) => crossesOpening(o, view.eye, p))) continue;
      const irradiance = source.kind === 'point' ? pointFalloff(source, p) * Math.max(cos, 0) : rectIrradiance(source, p, n);
      if (!(irradiance > 0)) continue;
      // The light the source really sends this way (KB-BOUNCE-TERMS1): its IES profile, projector image and layers.
      const tint = source.kind === 'point' && source.emission ? source.emission(p) : WHITE,
        k = (base + t) * 4,
        flux = [0, 1, 2].map((c) => texels[k + c] * irradiance * area * Math.max(tint[c], 0)),
        weight = flux[0] + flux[1] + flux[2];
      for (let c = 0; c < 3; c++) reflected[c] += flux[c];
      if (weight > 0) lit.push({ p, n: n as [number, number, number], flux, area, weight });
    }
  });
  // Strata of equal flux in Morton order seed the clusters; four Lloyd steps then move each lit texel to the nearest
  // cluster in position and normal, d^2 = |p - c|^2 + s^2 (1 - n.m), s the mean distance to the eye (Prutkin et al.
  // 2012 cluster the reflective shadow map in that space), so a cluster does not span a wall and the snow beyond it,
  // plus PLANE x the offset from the cluster's plane squared, ((p - c).m)^2, the L2 distance to a proxy plane of
  // variational shape approximation (Cohen-Steiner, Alliez and Desbrun, SIGGRAPH 2004, doi:10.1145/1015706.1015817),
  // so a cluster does not span two parallel surfaces either: a sill over the snow, a glazing bar's face. Each VPL is
  // lifted to its highest member (below), so one member on a ledge 1.4 m up raised the snow's light there
  // (KB-BOUNCE-CLUSTER1).
  const total = lit.reduce((s, t) => s + t.weight, 0),
    member = new Int32Array(lit.length);
  let seeds = 0,
    sum = 0,
    scale = 0;
  // As many VPLs as lit texels: one texel a cluster, exact.
  const each = count >= lit.length;
  for (let t = 0; t < lit.length; t++) {
    member[t] = each ? t : seeds;
    sum += lit[t].weight;
    if (sum >= (total * (seeds + 1)) / count && seeds < count - 1) seeds++;
    scale += Math.hypot(lit[t].p[0] - source.position[0], lit[t].p[1] - source.position[1], lit[t].p[2] - source.position[2]);
  }
  const k = each ? lit.length : lit.length ? member[lit.length - 1] + 1 : 0,
    s2 = (scale / Math.max(lit.length, 1)) ** 2,
    centre = new Float64Array(k * 3),
    normal = new Float64Array(k * 3),
    mass = new Float64Array(k);
  const update = () => {
    centre.fill(0);
    normal.fill(0);
    mass.fill(0);
    for (let t = 0; t < lit.length; t++) {
      const c = member[t],
        e = lit[t];
      for (let a = 0; a < 3; a++) {
        centre[c * 3 + a] += e.p[a] * e.weight;
        normal[c * 3 + a] += e.n[a] * e.weight;
      }
      mass[c] += e.weight;
    }
    for (let c = 0; c < k; c++) {
      if (!(mass[c] > 0)) continue;
      const l = Math.hypot(normal[c * 3], normal[c * 3 + 1], normal[c * 3 + 2]) || 1;
      for (let a = 0; a < 3; a++) {
        centre[c * 3 + a] /= mass[c];
        normal[c * 3 + a] /= l;
      }
    }
  };
  update();
  for (let step = 0; step < (each ? 0 : 4); step++) {
    for (let t = 0; t < lit.length; t++) {
      const e = lit[t];
      let best = member[t],
        bestD = Infinity;
      for (let c = 0; c < k; c++) {
        if (!(mass[c] > 0)) continue;
        const dx = e.p[0] - centre[c * 3],
          dy = e.p[1] - centre[c * 3 + 1],
          dz = e.p[2] - centre[c * 3 + 2],
          off = dx * normal[c * 3] + dy * normal[c * 3 + 1] + dz * normal[c * 3 + 2],
          d = dx * dx + dy * dy + dz * dz + PLANE * off * off + s2 * (1 - (e.n[0] * normal[c * 3] + e.n[1] * normal[c * 3 + 1] + e.n[2] * normal[c * 3 + 2]));
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      member[t] = best;
    }
    update();
  }
  // A cluster's centroid lies below a convex surface (a snow drift's crest, a log), inside what its own surfels draw
  // in the visibility maps, so the VPL would be hidden from everything by its own surface (KB-BOUNCE-VPL-BURIED1).
  // Each VPL is lifted along its normal to its highest member: no member is then above the VPL's tangent plane.
  const out: BounceVpl[] = [],
    flux = new Float64Array(k * 3),
    area = new Float64Array(k),
    lift = new Float64Array(k);
  for (let t = 0; t < lit.length; t++) {
    const c = member[t],
      e = lit[t];
    for (let a = 0; a < 3; a++) flux[c * 3 + a] += e.flux[a];
    area[c] += e.area;
    lift[c] = Math.max(
      lift[c],
      (e.p[0] - centre[c * 3]) * normal[c * 3] + (e.p[1] - centre[c * 3 + 1]) * normal[c * 3 + 1] + (e.p[2] - centre[c * 3 + 2]) * normal[c * 3 + 2],
    );
  }
  for (let c = 0; c < k; c++)
    if (mass[c] > 0)
      out.push({
        position: [0, 1, 2].map((a) => centre[c * 3 + a] + normal[c * 3 + a] * lift[c]) as [number, number, number],
        normal: [normal[c * 3], normal[c * 3 + 1], normal[c * 3 + 2]],
        flux: [flux[c * 3], flux[c * 3 + 1], flux[c * 3 + 2]],
        area: area[c],
        source: index,
      });
  return { vpls: out, points, flux: reflected };
}
/**
 * The orthonormal basis of a unit normal: T. Duff, J. Burgess, P. Christensen, C. Hery, A. Kensler, M. Liani and
 * R. Villemin, "Building an Orthonormal Basis, Revisited", JCGT 6(1), 2017, listing 3. The GPU uses the same.
 */
export function basis(n: V3): [[number, number, number], [number, number, number]] {
  const s = n[2] >= 0 ? 1 : -1,
    a = -1 / (s + n[2]),
    b = n[0] * n[1] * a;
  return [
    [1 + s * n[0] * n[0] * a, s * b, -s * n[0]],
    [b, s + n[1] * n[1] * a, -n[1]],
  ];
}
/** The paraboloid texel of unit direction `d` in the hemisphere of normal `n` (with its basis), or -1 behind it. */
function paraboloidTexel(d: V3, n: V3, t: V3, b: V3, res: number): number {
  const z = dot(d, n);
  if (z <= 0) return -1;
  const x = Math.min(res - 1, Math.max(0, Math.floor(((dot(d, t) / (1 + z)) * 0.5 + 0.5) * res))),
    y = Math.min(res - 1, Math.max(0, Math.floor(((dot(d, b) / (1 + z)) * 0.5 + 0.5) * res)));
  return y * res + x;
}
/** The unit direction through the centre of paraboloid texel (x, y) of the hemisphere of `n` (basis t, b). */
function texelCentre(x: number, y: number, res: number, n: V3, t: V3, b: V3): number[] {
  const u = ((x + 0.5) / res) * 2 - 1,
    v = ((y + 0.5) / res) * 2 - 1,
    q = u * u + v * v;
  return [0, 1, 2].map((k) => (2 * u * t[k] + 2 * v * b[k] + (1 - q) * n[k]) / (1 + q));
}
/** The biggest finite distance a visibility map stores: nothing seen in that direction. */
export const OPEN = 65504;
/** Side of the tiles {@link buildVisibility} skips whole, in texels. */
const TILE = 4;
/** {@link sampleSurfaces} settings. */
export interface SampleOptions {
  /** The visibility maps' size per VPL: the points are spaced to their texels. */
  readonly resolution: number;
  /** Points to make, at most; the spacing grows by powers of two until they fit. Default 16384. */
  readonly budget?: number;
}
/**
 * Occluders over every surface of `meshes`, at the detail each VPL's map resolves (KB-BOUNCE-SHADOWSNOW1). The captures'
 * texels hold only what a source sees, so a wall no source sees (behind a table) was in no map and VPLs lit the snow
 * through it; imperfect shadow maps sample the scene's own surfaces (Ritschel et al. 2008). A uniform sampling of a
 * 180 m snowfield gave each point about 1 m2 and its disc hid a log crest from the whole bounce, so the detail follows
 * the VPLs, as view-adaptive imperfect shadow maps place their points by the solid angle a surface covers (T. Ritschel,
 * E. Eisemann, I. Ha, J. D. K. Kim and H.-P. Seidel, "Making Imperfect Shadow Maps View-Adaptive: High-Quality Global
 * Illumination in Large Dynamic Scenes", Computer Graphics Forum 30(8), 2011, doi:10.1111/j.1467-8659.2011.02012.x) and
 * a hierarchy of the scene is cut to the angle its nodes cover from each view (M. Hollander, T. Ritschel, E. Eisemann
 * and T. Boubekeur, "ManyLoDs: Parallel Many-View Level-of-Detail Selection for Real-Time Global Illumination", EGSR
 * 2011, doi:10.1111/j.1467-8659.2011.01980.x; P. H. Christensen, "Point-Based Approximate Color Bleeding", Pixar
 * technical memo 08-01, 2008). A triangle whose circumradius is at least the cell size s = 2^floor(log2(theta d)), d its
 * distance to the nearest VPL that has a vertex of it above its plane (a VPL's own surface never occludes it), theta =
 * 2 / resolution the narrowest texel of a paraboloid map, is kept as itself and drawn exactly ({@link buildVisibility}):
 * no disc stands out of a curved log or past a wall's edge. Smaller triangles (a tree's leaves, a far snowfield's) are
 * merged per cell of size s and dominant normal axis of their mesh into one surfel at their area-weighted centre,
 * normal the unit vector area (a thin board's two faces agree), its reach the farthest member's centre plus its
 * circumradius, so it covers them all. Surfaces no VPL faces
 * are left out; past `budget` the cells double. Same input, same output.
 */
export function sampleSurfaces(meshes: readonly BounceMesh[], vpls: readonly BounceVpl[], { resolution, budget = 16384 }: SampleOptions): BouncePoint[] {
  const vp = Float64Array.from(vpls.flatMap((v) => [...v.position, ...v.normal])),
    worlds = meshes.map((mesh) => {
      const v = mesh.vertices,
        M = mesh.matrix,
        world = new Float64Array((v.length / 6) * 3),
        lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < world.length / 3; i++)
        for (let k = 0; k < 3; k++) {
          const p = M[k] * v[i * 6] + M[4 + k] * v[i * 6 + 1] + M[8 + k] * v[i * 6 + 2] + M[12 + k];
          world[i * 3 + k] = p;
          lo[k] = Math.min(lo[k], p);
          hi[k] = Math.max(hi[k], p);
        }
      return { world, lo, hi };
    });
  for (let theta = 2 / resolution; ; theta *= 2) {
    const out: BouncePoint[] = [],
      keys = new Map<number, Map<number | string, number>>(),
      // Per cell: area, area-weighted centre (3), vector area (3); per merged triangle: centre (3), circumradius, cell.
      acc: number[] = [],
      merged: number[] = [];
    worlds.forEach(({ world: w, lo, hi }, m) => {
      const ix = meshes[m].indices,
        // The VPLs facing the mesh's bounding sphere; a mesh farther from all of them than its radius takes their
        // nearest distance for every triangle, with no test per triangle (a tree across the clearing).
        C = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2),
        R = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
        facing: number[] = [];
      let near = Infinity;
      for (let j = 0; j < vp.length; j += 6)
        if ((C[0] - vp[j]) * vp[j + 3] + (C[1] - vp[j + 1]) * vp[j + 4] + (C[2] - vp[j + 2]) * vp[j + 5] > -R) {
          facing.push(j);
          near = Math.min(near, Math.hypot(C[0] - vp[j], C[1] - vp[j + 1], C[2] - vp[j + 2]) - R);
        }
      if (!facing.length) return;
      const far = near > R,
        stack: number[] = [],
        t = new Float64Array(9);
      for (let f = 0; f + 2 < ix.length; f += 3) {
        for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) stack.push(w[ix[f + c] * 3 + k]);
        while (stack.length) {
          for (let k = 8; k >= 0; k--) t[k] = stack.pop()!;
          const gx = (t[0] + t[3] + t[6]) / 3,
            gy = (t[1] + t[4] + t[7]) / 3,
            gz = (t[2] + t[5] + t[8]) / 3,
            x = cross([t[3] - t[0], t[4] - t[1], t[5] - t[2]], [t[6] - t[0], t[7] - t[1], t[8] - t[2]]),
            twice = Math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
          if (!(twice > 0)) continue;
          let r2 = 0;
          for (let c = 0; c < 9; c += 3) r2 = Math.max(r2, (t[c] - gx) ** 2 + (t[c + 1] - gy) ** 2 + (t[c + 2] - gz) ** 2);
          const r = Math.sqrt(r2);
          let d = far ? near : Infinity;
          if (!far)
            for (const j of facing) {
              const dx = gx - vp[j],
                dy = gy - vp[j + 1],
                dz = gz - vp[j + 2],
                l = Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
              if (l >= d) continue;
              // In front: a vertex above the VPL's plane.
              for (let c = 0; c < 9; c += 3)
                if ((t[c] - vp[j]) * vp[j + 3] + (t[c + 1] - vp[j + 1]) * vp[j + 4] + (t[c + 2] - vp[j + 2]) * vp[j + 5] > 1e-3 * (l + r)) {
                  d = l;
                  break;
                }
            }
          if (d === Infinity) continue;
          const L = Math.floor(Math.log2(theta * Math.max(d, 0.01))),
            s = 2 ** L;
          if (r >= s) {
            out.push({ position: [gx, gy, gz], normal: unit(x), area: twice / 2, reach: r, corners: Array.from(t) });
            continue;
          }
          const ax = x.map(Math.abs),
            axis = ax[0] >= ax[1] && ax[0] >= ax[2] ? 0 : ax[1] >= ax[2] ? 1 : 2,
            sign = x[axis] < 0 ? -0.5 : 0.5,
            span = [0, 1, 2].map((k) => Math.floor((hi[k] - lo[k]) / s) + 2),
            at = [gx, gy, gz].map((p, k) => Math.floor((p - lo[k]) / s)),
            grid = (m * 64 + L + 32) * 3 + axis,
            key = span[0] * span[1] * span[2] < 2 ** 50 ? at[0] + span[0] * (at[1] + span[1] * at[2]) : at.join(' ');
          let cells = keys.get(grid);
          if (!cells) keys.set(grid, (cells = new Map()));
          let cell = cells.get(key);
          if (cell === undefined) cells.set(key, (cell = acc.push(0, 0, 0, 0, 0, 0, 0) / 7 - 1));
          const o = cell * 7,
            area = twice / 2;
          acc[o] += area;
          acc[o + 1] += gx * area;
          acc[o + 2] += gy * area;
          acc[o + 3] += gz * area;
          for (let k = 0; k < 3; k++) acc[o + 4 + k] += x[k] * sign;
          merged.push(gx, gy, gz, r, cell);
        }
      }
    });
    if (out.length + acc.length / 7 > budget) continue;
    const first = out.length;
    for (let o = 0; o < acc.length; o += 7)
      out.push({ position: [acc[o + 1] / acc[o], acc[o + 2] / acc[o], acc[o + 3] / acc[o]], normal: unit(acc.slice(o + 4, o + 7)), area: acc[o], reach: 0 });
    for (let i = 0; i < merged.length; i += 5) {
      const p = out[first + merged[i + 4]] as { position: number[]; reach: number };
      p.reach = Math.max(p.reach, Math.hypot(merged[i] - p.position[0], merged[i + 1] - p.position[1], merged[i + 2] - p.position[2]) + merged[i + 3]);
    }
    return out;
  }
}
/**
 * Imperfect shadow maps (Ritschel et al. 2008): one paraboloid depth map of `resolution`^2 per VPL, the nearest
 * surfel per texel centre ray. At most `budget` points (an even subset, each standing for the area of the points it
 * replaces), each an ellipse along the ray it was seen by (a disc without one). Openings a VPL must not light
 * through are drawn exactly, as the rectangle's distance per texel ray. Returns `vpls.length` maps in one array.
 */
export function buildVisibility(
  vpls: readonly BounceVpl[],
  points: readonly BouncePoint[],
  {
    resolution: res,
    budget = 4096,
    openings = [],
    occluders = [],
    stats,
  }: {
    resolution: number;
    budget?: number;
    openings?: readonly BounceOpening[];
    occluders?: readonly BouncePoint[];
    /** Receives the work done: `rays`, the texel centre rays tested against triangles. */
    stats?: { rays: number };
  },
): Float32Array {
  const maps = new Float32Array(vpls.length * res * res).fill(OPEN),
    stride = Math.max(1, Math.ceil(points.length / budget)),
    count = Math.ceil(points.length / stride),
    texels = res * res,
    // Each VPL's texel centre rays (texelCentre's values, made once a VPL), and the map's tiles of TILE^2 texels,
    // each its rays' mean direction and the longest chord from it to one of them.
    rays = new Float64Array(texels * 3),
    tiles = Math.ceil(res / TILE),
    axes = new Float64Array(tiles * tiles * 3),
    chords = new Float64Array(tiles * tiles),
    // Texel i's ray, a view of the table (dot and sub read only its three indices).
    ray = (i: number) => rays.subarray(i * 3, i * 3 + 3) as unknown as V3;
  let tested = 0;
  vpls.forEach((vpl, j) => {
    const n = vpl.normal,
      [t, b] = basis(n),
      map = j * texels,
      origin = vpl.position;
    for (let y = 0, k = 0; y < res; y++)
      for (let x = 0; x < res; x++, k += 3) {
        const c = texelCentre(x, y, res, n, t, b);
        rays[k] = c[0];
        rays[k + 1] = c[1];
        rays[k + 2] = c[2];
      }
    for (let ty = 0; ty < tiles; ty++)
      for (let tx = 0; tx < tiles; tx++) {
        const i = ty * tiles + tx,
          x1 = Math.min(res, tx * TILE + TILE),
          y1 = Math.min(res, ty * TILE + TILE);
        let ax = 0,
          ay = 0,
          az = 0;
        for (let y = ty * TILE; y < y1; y++)
          for (let x = tx * TILE; x < x1; x++) {
            const k = (y * res + x) * 3;
            ax += rays[k];
            ay += rays[k + 1];
            az += rays[k + 2];
          }
        const l = Math.hypot(ax, ay, az) || 1;
        ax /= l;
        ay /= l;
        az /= l;
        let chord = 0;
        for (let y = ty * TILE; y < y1; y++)
          for (let x = tx * TILE; x < x1; x++) {
            const k = (y * res + x) * 3;
            chord = Math.max(chord, Math.hypot(rays[k] - ax, rays[k + 1] - ay, rays[k + 2] - az));
          }
        axes[i * 3] = ax;
        axes[i * 3 + 1] = ay;
        axes[i * 3 + 2] = az;
        chords[i] = chord * (1 + 1e-6) + 1e-9;
      }
    for (let s = 0; s < count + occluders.length; s++) {
      const point = s < count ? points[s * stride] : occluders[s - count],
        w = sub(point.position, origin),
        r = Math.hypot(w[0], w[1], w[2]);
      if (r < 1e-4) continue;
      const z = dot(w, n) / r,
        corners = point.corners;
      if (corners) {
        // A triangle: every texel its circumscribed disc can reach (the whole map once that disc reaches the VPL's
        // plane), each centre ray against the triangle (Moller and Trumbore, "Fast, Minimum Storage Ray/Triangle
        // Intersection", JGT 2(1), 1997, doi:10.1080/10867651.1997.10487468).
        if (z * r + point.reach! <= 0) continue;
        const e1 = [corners[3] - corners[0], corners[4] - corners[1], corners[5] - corners[2]],
          e2 = [corners[6] - corners[0], corners[7] - corners[1], corners[8] - corners[2]],
          o = [origin[0] - corners[0], origin[1] - corners[1], origin[2] - corners[2]],
          q = cross(o, e1),
          whole = z * r <= point.reach! || r <= 2 * point.reach!,
          u = whole ? 0 : dot(w, t) / r / (1 + z),
          v = whole ? 0 : dot(w, b) / r / (1 + z),
          radius = whole ? 2 : point.reach! / Math.sqrt(r * r - point.reach! * point.reach!) + 1 / res,
          x0 = Math.max(0, Math.floor(((u - radius) * 0.5 + 0.5) * res)),
          x1 = Math.min(res - 1, Math.floor(((u + radius) * 0.5 + 0.5) * res)),
          y0 = Math.max(0, Math.floor(((v - radius) * 0.5 + 0.5) * res)),
          y1 = Math.min(res - 1, Math.floor(((v + radius) * 0.5 + 0.5) * res));
        // The tiles of the map the triangle can cover: a centre ray c meets it in front of the VPL with barycentric
        // weights l_k = (c . N_k) / (c . (N_0 + N_1 + N_2)), N_k the normal of the plane through the VPL and the edge
        // facing corner k (the edge functions of A. Olano and T. Greer, "Triangle Scan Conversion using 2D Homogeneous
        // Coordinates", Graphics Hardware 1997, on the VPL's sphere of directions; J. Pineda, "A Parallel Algorithm for
        // Polygon Rasterization", SIGGRAPH 1988, for whole tiles), and in front only where c . sum N has the sign of the
        // triple product V. A tile all of whose rays have sign(V) c . N_k below -1e-6 |sum N| for one edge holds no ray
        // the test below takes (its slack is l_k >= -1e-6), so the tile is skipped: a ray is within its chord of the
        // tile's mean direction, and c . N_k is at most mean . N_k + chord |N_k|. The margin covers rounding. The
        // whole map, which the disc bound gave a triangle beside the VPL, was 1,024 rays a triangle at resolution 32
        // (KB-SHOT-COMPAT-SKYCOV1: 230 million rays, 10 s, per rebuild of the cabin's bounce).
        const v0 = [corners[0] - origin[0], corners[1] - origin[1], corners[2] - origin[2]],
          v1 = [corners[3] - origin[0], corners[4] - origin[1], corners[5] - origin[2]],
          v2 = [corners[6] - origin[0], corners[7] - origin[1], corners[8] - origin[2]],
          N0 = cross(v1, v2),
          N1 = cross(v2, v0),
          N2 = cross(v0, v1),
          V = dot(v0, N0),
          sense = Math.abs(V) > 1e-9 * Math.hypot(v0[0], v0[1], v0[2]) * Math.hypot(v1[0], v1[1], v1[2]) * Math.hypot(v2[0], v2[1], v2[2]) ? Math.sign(V) : 0,
          sum = Math.hypot(N0[0] + N1[0] + N2[0], N0[1] + N1[1] + N2[1], N0[2] + N1[2] + N2[2]),
          l0 = Math.hypot(N0[0], N0[1], N0[2]),
          l1 = Math.hypot(N1[0], N1[1], N1[2]),
          l2 = Math.hypot(N2[0], N2[1], N2[2]),
          slack = 1.01e-6 * sum,
          m0 = slack + 1e-5 * (l0 + sum),
          m1 = slack + 1e-5 * (l1 + sum),
          m2 = slack + 1e-5 * (l2 + sum);
        for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++)
          for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
            if (sense !== 0) {
              const i = ty * tiles + tx,
                ax = axes[i * 3],
                ay = axes[i * 3 + 1],
                az = axes[i * 3 + 2],
                chord = chords[i];
              if (sense * (ax * N0[0] + ay * N0[1] + az * N0[2]) + chord * l0 < -m0) continue;
              if (sense * (ax * N1[0] + ay * N1[1] + az * N1[2]) + chord * l1 < -m1) continue;
              if (sense * (ax * N2[0] + ay * N2[1] + az * N2[2]) + chord * l2 < -m2) continue;
            }
            const ya = Math.max(y0, ty * TILE),
              yb = Math.min(y1, ty * TILE + TILE - 1),
              xa = Math.max(x0, tx * TILE),
              xb = Math.min(x1, tx * TILE + TILE - 1);
            tested += (yb - ya + 1) * (xb - xa + 1);
            for (let y = ya; y <= yb; y++)
              for (let x = xa; x <= xb; x++) {
                const at = (y * res + x) * 3,
                  c0 = rays[at],
                  c1 = rays[at + 1],
                  c2 = rays[at + 2],
                  // cross(c, e2) and the dot products of Moller and Trumbore, written out.
                  p0 = c1 * e2[2] - c2 * e2[1],
                  p1 = c2 * e2[0] - c0 * e2[2],
                  p2 = c0 * e2[1] - c1 * e2[0],
                  det = e1[0] * p0 + e1[1] * p1 + e1[2] * p2;
                if (Math.abs(det) < 1e-12) continue;
                const a = (o[0] * p0 + o[1] * p1 + o[2] * p2) / det,
                  bb = (c0 * q[0] + c1 * q[1] + c2 * q[2]) / det;
                if (a < -1e-6 || bb < -1e-6 || a + bb > 1 + 1e-6) continue;
                const depth = dot(e2, q) / det,
                  k = map + y * res + x;
                // The map's near plane, 0.02 m, the receiver's own slack: a VPL stands for a patch of texels, and a step
                // of a few millimetres beside its point (a sash against its frame) is no occluder of the patch.
                if (depth > 0.02 && depth < maps[k]) maps[k] = depth;
              }
          }
        continue;
      }
      if (z <= 1e-3) continue;
      const u = dot(w, t) / r / (1 + z),
        v = dot(w, b) / r / (1 + z),
        // A surfel (Pfister, Zwicker, van Baar and Gross, "Surfels: Surface Elements as Rendering Primitives",
        // SIGGRAPH 2000) 1.5 times the size of its area, so neighbours overlap. A capture texel meeting its surface at
        // cos to the ray covers a patch 1 / cos longer along the ray's projection on the surface than across it (the
        // texel's footprint, P. S. Heckbert, "Fundamentals of Texture Mapping and Image Warping", UC Berkeley 1989), so
        // the surfel is that ellipse of the same area, semi-axes reach sqrt(e) along and reach / sqrt(e) across,
        // e = 1 / max(cos, 0.1) as its area takes (elliptical surface splats: M. Zwicker, H. Pfister, J. van Baar and
        // M. Gross, "Surface Splatting", SIGGRAPH 2001; M. Botsch, A. Hornung, M. Zwicker and L. Kobbelt,
        // "High-Quality Surface Splatting on Today's GPUs", PBG 2005). A disc of the same reach left gaps along grazing
        // walls (KB-BOUNCE-SHADOWSNOW1). Each texel its projection can reach (the long semi-axis's angular radius over
        // d|uv|/d(theta) = 1 / (1 + cos theta)) takes the depth where its centre ray meets the surfel, as a rasteriser
        // would, so receivers can be compared at their own plane (bounceIrradiance).
        reach = point.reach ?? 1.5 * Math.sqrt((point.area * stride) / Math.PI),
        pn = point.normal,
        along = point.ray ? sub(point.ray, pn.map((c) => c * dot(point.ray as V3, pn))) : undefined,
        span = along ? Math.hypot(along[0], along[1], along[2]) : 0,
        // span = sin of the ray to the surface normal; cos = sqrt(1 - span^2).
        e = 1 / Math.max(Math.sqrt(Math.max(0, 1 - span * span)), 0.1),
        axis = span > 1e-6 ? (along as number[]).map((c) => c / span) : undefined,
        long = axis ? reach * Math.sqrt(e) : reach,
        short = axis ? reach / Math.sqrt(e) : reach,
        radius = long / r / (1 + z),
        x0 = Math.max(0, Math.floor(((u - radius) * 0.5 + 0.5) * res)),
        x1 = Math.min(res - 1, Math.floor(((u + radius) * 0.5 + 0.5) * res)),
        y0 = Math.max(0, Math.floor(((v - radius) * 0.5 + 0.5) * res)),
        y1 = Math.min(res - 1, Math.floor(((v + radius) * 0.5 + 0.5) * res));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const c = ray(y * res + x),
            den = dot(c, point.normal);
          if (Math.abs(den) < 1e-3) continue;
          const depth = dot(w, point.normal) / den,
            k = map + y * res + x;
          if (!(depth > 0) || depth >= maps[k]) continue;
          const hx = c[0] * depth - w[0],
            hy = c[1] * depth - w[1],
            hz = c[2] * depth - w[2];
          if (axis) {
            const sa = hx * axis[0] + hy * axis[1] + hz * axis[2],
              q = hx * hx + hy * hy + hz * hz - sa * sa;
            if ((sa * sa) / (long * long) + q / (short * short) > 1) continue;
          } else if (hx * hx + hy * hy + hz * hz > reach * reach) continue;
          if (depth < maps[k]) maps[k] = depth;
        }
    }
    for (const o of openings) {
      const room = dot(sub(origin, o.position), o.normal) < 0;
      if (!room && !o.frosted) continue;
      // Each texel's centre ray against the rectangle's plane.
      for (let y = 0; y < res; y++)
        for (let x = 0; x < res; x++) {
          const d = ray(y * res + x),
            denom = dot(d, o.normal);
          if (Math.abs(denom) < 1e-9) continue;
          const along = dot(sub(o.position, origin), o.normal) / denom;
          if (!(along > 0)) continue;
          const hit = sub([0, 1, 2].map((k) => origin[k] + d[k] * along), o.position);
          if (Math.abs(dot(hit, o.u)) > dot(o.u, o.u) || Math.abs(dot(hit, o.v)) > dot(o.v, o.v)) continue;
          const k = j * res * res + y * res + x;
          if (along < maps[k]) maps[k] = along;
        }
    }
  });
  if (stats) stats.rays = tested;
  return maps;
}
/**
 * Lays the bounce out as the lit shader reads it (one array of vec4f): a header (sources, VPLs, map resolution,
 * 1 / resolution), each source's rgb scale (colour x intensity of a light, the radiance of an opening), each VPL as
 * three vec4f (position and source index; normal and area; flux), then the visibility maps, four depths a vec4f.
 */
export function packBounce(
  scales: readonly (readonly number[])[],
  vpls: readonly BounceVpl[],
  maps: Float32Array,
  resolution: number,
): Float32Array {
  const texels = resolution * resolution,
    head = 1 + scales.length + vpls.length * 3,
    data = new Float32Array((head + Math.ceil((vpls.length * texels) / 4)) * 4);
  data.set([scales.length, vpls.length, resolution, 1 / resolution]);
  scales.forEach((s, i) => data.set([s[0], s[1], s[2], 0], (1 + i) * 4));
  vpls.forEach((v, j) => {
    const o = (1 + scales.length + j * 3) * 4;
    data.set([...v.position, v.source, ...v.normal, v.area, ...v.flux, 0], o);
  });
  data.set(maps.subarray(0, vpls.length * texels), head * 4);
  return data;
}
/** Writes each source's current scale into packed data, in place. */
export function setBounceScales(data: Float32Array, scales: readonly (readonly number[])[]): void {
  scales.forEach((s, i) => data.set([s[0], s[1], s[2]], (1 + i) * 4));
}
/**
 * The bounce's irradiance at `x` (unit normal `n`) from packed data, the JS twin of the lit shader's
 * `clusterBounceLighting` (which multiplies it by the diffuse albedo over pi): per VPL the disc form factor at `x`, if
 * the receiver's plane along the map texel's centre ray is no farther than the map's depth plus 2 cm and 2%.
 */
export function bounceIrradiance(data: Float32Array, x: V3, n: V3): [number, number, number] {
  const sources = data[0],
    count = data[1],
    res = data[2],
    start = 1 + sources,
    maps = (start + count * 3) * 4,
    e: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < count; j++) {
    const o = (start + j * 3) * 4,
      p = [data[o], data[o + 1], data[o + 2]],
      nj = [data[o + 4], data[o + 5], data[o + 6]],
      a = data[o + 7],
      s = (1 + data[o + 3]) * 4;
    const w = sub(x, p),
      r = Math.max(Math.hypot(w[0], w[1], w[2]), 1e-4),
      d = [w[0] / r, w[1] / r, w[2] / r],
      cj = dot(nj, d),
      ci = -dot(n, d);
    if (cj <= 0 || ci <= 0) continue;
    // Adaptive depth bias (H. Dou, Y. Yan, E. Kerzner, Z. Dai and C. Wyman, "Adaptive Depth Bias for Shadow Maps",
    // JCGT 3(4), 2014): the receiver is compared where its tangent plane meets the texel's centre ray, the depth the map
    // holds for a surface there, so a receiver never shadows itself; never farther than the receiver.
    const [t, b] = basis(nj),
      k = paraboloidTexel(d, nj, t, b, res),
      c = texelCentre(k % res, Math.floor(k / res), res, nj, t, b),
      den = dot(c, n),
      plane = den < -1e-3 ? Math.min(r, Math.max(0, dot(w, n) / den)) : r;
    if (plane > data[maps + j * res * res + k] * 1.02 + 0.02) continue;
    const f = (cj * ci) / (Math.PI * r * r + a);
    for (let c = 0; c < 3; c++) e[c] += data[s + c] * data[o + 8 + c] * f;
  }
  return e;
}
/** The lit-shader hook binding of the bounce data. */
export const BOUNCE_BINDING = 164;
/** The WGSL of the bounce in the lit shader: `clusterBounceLighting` in bind group `group`. */
export function bounceWgsl(group: number, binding = BOUNCE_BINDING): string {
  return /* wgsl */ `
@group(${group}) @binding(${binding}) var<storage,read> clusterBounce:array<vec4f>;
fn clusterBounceLighting(position:vec3f,n:vec3f,base:vec3f,metal:f32)->vec3f {
  let head=clusterBounce[0];let res=u32(head.z);let start=1u+u32(head.x);let count=u32(head.y);let maps=start+count*3u;
  var e=vec3f(0);
  for(var j=0u;j<count;j++){
    let a=clusterBounce[start+j*3u];let b=clusterBounce[start+j*3u+1u];
    let w=position-a.xyz;let r=max(length(w),0.0001);let d=w/r;
    let cj=dot(b.xyz,d);let ci=-dot(n,d);if(cj<=0.0||ci<=0.0){continue;}
    let s=select(-1.0,1.0,b.z>=0.0);let ba=-1.0/(s+b.z);let bb=b.x*b.y*ba;
    let t=vec3f(1.0+s*b.x*b.x*ba,s*bb,-s*b.x);let bt=vec3f(bb,s+b.y*b.y*ba,-b.y);
    let uv=vec2f(dot(d,t),dot(d,bt))/(1.0+cj);
    let ij=vec2u(clamp(floor((uv*0.5+0.5)*f32(res)),vec2f(0),vec2f(f32(res-1u))));
    let k=j*res*res+ij.y*res+ij.x;let cu=(vec2f(ij)+0.5)/f32(res)*2.0-1.0;let q=dot(cu,cu);
    let c=(2.0*cu.x*t+2.0*cu.y*bt+(1.0-q)*b.xyz)/(1.0+q);let den=dot(c,n);
    let plane=select(r,min(r,max(0.0,dot(w,n)/den)),den< -0.001);
    if(plane>clusterBounce[maps+k/4u][k%4u]*1.02+0.02){continue;}
    e+=clusterBounce[1u+u32(a.w)].rgb*clusterBounce[start+j*3u+2u].rgb*(cj*ci/(3.14159265*r*r+b.w));
  }
  return base*(1.0-metal)*0.318309886*e;
}
`;
}
