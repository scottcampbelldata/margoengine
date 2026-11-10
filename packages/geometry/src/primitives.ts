import type { GeometryData, GeometryGroup } from './data.js';
import type { Curve } from './curve.js';
import { finiteNumber, to3, type Vec, type MutableVec2 } from './math.js';

const TAU = Math.PI * 2;

/** Segment counts: non-finite throws before any work; finite values are floored and raised to `min`. */
const count = (value: number, min: number): number => Math.max(min, Math.floor(finiteNumber(value)));

// Evaluate each angular column once per call, retaining Float64 and the original operand order.
function angles(segments: number, length: number, start?: number): Float64Array {
  const out = new Float64Array((segments + 1) * 2);
  for (let c = 0; c <= segments; c++) {
    const offset = (c / segments) * length,
      a = start === undefined ? offset : start + offset;
    out[c * 2] = Math.sin(a);
    out[c * 2 + 1] = Math.cos(a);
  }
  return out;
}

// Which triangle of a lattice quad to leave out: none, the one on the quad's lower row, or the one on its upper row.
// Lower and upper rows collapse to a point at a cone apex or a sphere pole.
const BOTH = 0,
  NO_LOWER = 1,
  NO_UPPER = 2;

/** Growing vertex streams shared by the primitives. */
class Mesh {
  p: number[] = [];
  n: number[] = [];
  t: number[] = [];
  i: number[] = [];
  groups: GeometryGroup[] = [];
  get size(): number {
    return this.p.length / 3;
  }
  add(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): void {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.t.push(u, v);
  }
  /** Closes a draw group over every index added since `start`; empty groups are left out. */
  group(start: number, materialIndex: number): void {
    if (this.i.length > start) this.groups.push({ start, count: this.i.length - start, materialIndex });
  }
  done(withGroups = false): GeometryData {
    const data: GeometryData = {
      positions: Float32Array.from(this.p),
      normals: Float32Array.from(this.n),
      uvs: Float32Array.from(this.t),
      indices: Uint32Array.from(this.i),
    };
    if (withGroups) data.groups = this.groups;
    return data;
  }
}

/**
 * Indexes a lattice of `(cols + 1) x (rows + 1)` vertices written row by row from `first`. Columns must advance
 * along the surface's u direction and rows along v with u x v pointing to the front, so the triangles come out
 * counter-clockwise seen from the front. `drop(row)` leaves out one triangle of each quad in that row.
 */
function lattice(mesh: Mesh, first: number, cols: number, rows: number, drop?: (row: number) => number): void {
  for (let r = 0; r < rows; r++) {
    const skip = drop ? drop(r) : BOTH;
    for (let c = 0; c < cols; c++) {
      const a = first + r * (cols + 1) + c,
        b = a + 1,
        d = a + cols + 1,
        e = d + 1;
      // Split along a-e: the lower triangle owns the edge a-b, the upper one d-e.
      if (skip !== NO_LOWER) mesh.i.push(a, b, e);
      if (skip !== NO_UPPER) mesh.i.push(a, e, d);
    }
  }
}

/**
 * Axis-aligned box centred on the origin: `width` along x, `height` along y, `depth` along z. Each face is its own
 * grid (corners are not shared, normals are flat) and its own group, in the order +x, -x, +y, -y, +z, -z
 * (materialIndex 0 to 5). The x faces use depth by height segments, the y faces width by depth, the z faces width by
 * height. Every face maps UVs 0..1 so the texture reads upright and unmirrored from outside (the y faces have -z, or
 * +z on the bottom, as their up).
 */
export function boxGeometry(
  width = 1,
  height = 1,
  depth = 1,
  widthSegments = 1,
  heightSegments = 1,
  depthSegments = 1,
): GeometryData {
  const segs = [count(widthSegments, 1), count(heightSegments, 1), count(depthSegments, 1)],
    size = [width, height, depth],
    mesh = new Mesh();
  // One face: normal axis and sign, then the axes (and directions) that u and v grow along seen from outside.
  const face = (axis: number, sign: number, ua: number, us: number, va: number, vs: number, material: number) => {
    const first = mesh.size,
      start = mesh.i.length,
      cols = segs[ua],
      rows = segs[va],
      p = [0, 0, 0],
      q = [0, 0, 0];
    q[axis] = sign;
    p[axis] = (sign * size[axis]) / 2;
    // Rows run from the face's top edge down, the layout roundedBoxGeometry uses, so radius 0 there is this box.
    for (let r = 0; r <= rows; r++)
      for (let c = 0; c <= cols; c++) {
        p[ua] = us * (c / cols - 0.5) * size[ua];
        p[va] = vs * (0.5 - r / rows) * size[va];
        mesh.add(p[0], p[1], p[2], q[0], q[1], q[2], c / cols, 1 - r / rows);
      }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = first + r * (cols + 1) + c,
          below = a + cols + 1;
        // Down then right is the face's front-facing turn.
        mesh.i.push(a, below, a + 1, below, below + 1, a + 1);
      }
    mesh.group(start, material);
  };
  face(0, 1, 2, -1, 1, 1, 0);
  face(0, -1, 2, 1, 1, 1, 1);
  face(1, 1, 0, 1, 2, -1, 2);
  face(1, -1, 0, 1, 2, 1, 3);
  face(2, 1, 0, 1, 1, 1, 4);
  face(2, -1, 0, -1, 1, 1, 5);
  return mesh.done(true);
}

/**
 * Rectangle in the XY plane at z = 0, centred on the origin and facing +z: a regular grid of
 * `(widthSegments + 1) * (heightSegments + 1)` vertices with UV (0, 0) at the (-x, -y) corner and (1, 1) at (+x, +y).
 * No groups.
 */
export function planeGeometry(width = 1, height = 1, widthSegments = 1, heightSegments = 1): GeometryData {
  const cols = count(widthSegments, 1),
    rows = count(heightSegments, 1),
    mesh = new Mesh();
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++)
      mesh.add((c / cols - 0.5) * width, (r / rows - 0.5) * height, 0, 0, 0, 1, c / cols, r / rows);
  lattice(mesh, 0, cols, rows);
  return mesh.done();
}

/**
 * Disc, or a sector of one, in the XY plane facing +z: a centre vertex fanned to `segmentCount + 1` rim vertices from
 * `thetaStart` over `thetaLength` (radians from +x toward +y). UVs are the planar map of the unit square around the
 * disc, centre at (0.5, 0.5). No groups.
 */
export function circleGeometry(radius = 1, segmentCount = 32, thetaStart = 0, thetaLength = TAU): GeometryData {
  const n = count(segmentCount, 3),
    mesh = new Mesh(),
    scale = 2 * (radius || 1);
  mesh.add(0, 0, 0, 0, 0, 1, 0.5, 0.5);
  for (let k = 0; k <= n; k++) {
    const a = thetaStart + (k / n) * thetaLength,
      x = radius * Math.cos(a),
      y = radius * Math.sin(a);
    mesh.add(x, y, 0, 0, 0, 1, 0.5 + x / scale, 0.5 + y / scale);
    if (k) mesh.i.push(0, k, k + 1);
  }
  return mesh.done();
}

/**
 * Flat annulus, or a sector of one, in the XY plane facing +z: `phiSegments + 1` concentric rings from `innerRadius`
 * to `outerRadius`, each of `thetaSegments + 1` vertices from `thetaStart` over `thetaLength` (radians from +x toward
 * +y). UVs are the planar map of the square around the outer rim, centre at (0.5, 0.5). No groups.
 */
export function ringGeometry(
  innerRadius = 0.5,
  outerRadius = 1,
  thetaSegments = 32,
  phiSegments = 1,
  thetaStart = 0,
  thetaLength = TAU,
): GeometryData {
  const around = count(thetaSegments, 3),
    rings = count(phiSegments, 1),
    mesh = new Mesh(),
    scale = 2 * (outerRadius || 1);
  // Lattice columns run outward and rows counter-clockwise, so the radial x tangential cross product is +z.
  for (let r = 0; r <= around; r++) {
    const a = thetaStart + (r / around) * thetaLength,
      cos = Math.cos(a),
      sin = Math.sin(a);
    for (let c = 0; c <= rings; c++) {
      const rad = innerRadius + ((outerRadius - innerRadius) * c) / rings,
        x = rad * cos,
        y = rad * sin;
      mesh.add(x, y, 0, 0, 0, 1, 0.5 + x / scale, 0.5 + y / scale);
    }
  }
  lattice(mesh, 0, rings, around);
  return mesh.done();
}

/**
 * Cylinder or frustum along y, centred on the origin, from `radiusTop` at y = +height/2 to `radiusBottom` at
 * -height/2. Angles start at `thetaStart` on +z and turn toward +x. The side is a grid with u around and v = 1 at the
 * top, true slanted normals, and a single triangle per quad next to a zero radius (no slivers at a cone tip). Unless
 * `openEnded`, every end with a radius above zero gets a flat cap facing out along y. Groups: side 0, top cap 1,
 * bottom cap 2; a missing cap has no group.
 */
export function cylinderGeometry(
  radiusTop = 1,
  radiusBottom = 1,
  height = 1,
  radialSegments = 32,
  heightSegments = 1,
  openEnded = false,
  thetaStart = 0,
  thetaLength = TAU,
): GeometryData {
  const cols = count(radialSegments, 1),
    rows = count(heightSegments, 1),
    mesh = new Mesh(),
    angular = angles(cols, thetaLength, thetaStart);
  // Side normal in the (radial, y) plane: the profile runs (radiusTop - radiusBottom, height), so (height, rb - rt)
  // points out. A flat side (height 0) with equal radii has no slope: use the horizontal radial direction.
  const slope = radiusBottom - radiusTop,
    l = Math.hypot(height, slope),
    nr = l ? height / l : 1,
    ny = l ? slope / l : 0;
  for (let r = 0; r <= rows; r++) {
    const t = r / rows,
      rad = radiusBottom + (radiusTop - radiusBottom) * t,
      y = (t - 0.5) * height;
    for (let c = 0; c <= cols; c++) {
      const s = angular[c * 2],
        k = angular[c * 2 + 1];
      // + 0 keeps a flat side's normal free of -0.
      mesh.add(rad * s, y, rad * k, nr * s + 0, ny, nr * k + 0, c / cols, t);
    }
  }
  lattice(mesh, 0, cols, rows, (r) =>
    r === 0 && !(radiusBottom > 0) ? NO_LOWER : r === rows - 1 && !(radiusTop > 0) ? NO_UPPER : BOTH,
  );
  mesh.group(0, 0);
  const cap = (top: boolean) => {
    const rad = top ? radiusTop : radiusBottom;
    if (openEnded || !(rad > 0)) return;
    const y = top ? height / 2 : -height / 2,
      sign = top ? 1 : -1,
      start = mesh.i.length,
      centres = mesh.size;
    // One centre per segment, then the rim. Seen from outside, the cap's u runs toward +x and its v toward -z on top
    // and +z underneath, as on the box.
    for (let c = 0; c < cols; c++) mesh.add(0, y, 0, 0, sign, 0, 0.5, 0.5);
    const rim = mesh.size;
    for (let c = 0; c <= cols; c++) {
      const s = angular[c * 2],
        k = angular[c * 2 + 1];
      mesh.add(rad * s, y, rad * k, 0, sign, 0, 0.5 + s / 2, 0.5 - (sign * k) / 2);
    }
    for (let c = 0; c < cols; c++)
      if (top) mesh.i.push(centres + c, rim + c, rim + c + 1);
      else mesh.i.push(centres + c, rim + c + 1, rim + c);
    mesh.group(start, top ? 1 : 2);
  };
  cap(true);
  cap(false);
  return mesh.done(true);
}

/**
 * Cone along y with its tip at y = +height/2 and a base of `radius` at -height/2: exactly
 * `cylinderGeometry(0, radius, height, ...)`, so the groups are side 0 and (unless `openEnded`) bottom cap 2.
 */
export function coneGeometry(
  radius = 1,
  height = 1,
  radialSegments = 32,
  heightSegments = 1,
  openEnded = false,
  thetaStart = 0,
  thetaLength = TAU,
): GeometryData {
  return cylinderGeometry(0, radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength);
}

/**
 * UV sphere centred on the origin, y up. For u, v in [0, 1] the point is at azimuth phiStart + u * phiLength (0 on -x,
 * turning through +z) and polar angle thetaStart + v * thetaLength (0 at the +y pole, clamped to pi); its UV is
 * (u, 1 - v). A `(widthSegments + 1) * (heightSegments + 1)` grid with radial unit normals. Rows on a pole keep one
 * triangle per quad, and their u moves half a column toward that triangle's middle. No groups.
 */
export function sphereGeometry(
  radius = 1,
  widthSegments = 32,
  heightSegments = 16,
  phiStart = 0,
  phiLength = TAU,
  thetaStart = 0,
  thetaLength = Math.PI,
): GeometryData {
  const cols = count(widthSegments, 3),
    rows = count(heightSegments, 2),
    mesh = new Mesh(),
    angular = angles(cols, phiLength, phiStart),
    top = thetaStart === 0,
    bottom = thetaStart + thetaLength >= Math.PI;
  // Lattice rows go upward (v from the bottom of the band), so azimuth x up points outward.
  for (let r = 0; r <= rows; r++) {
    const v = 1 - r / rows,
      theta = Math.min(thetaStart + v * thetaLength, Math.PI),
      st = Math.sin(theta),
      ct = Math.cos(theta),
      shift = r === rows && top ? 0.5 / cols : r === 0 && bottom ? -0.5 / cols : 0;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols,
        x = -angular[c * 2 + 1] * st,
        z = angular[c * 2] * st;
      mesh.add(radius * x, radius * ct, radius * z, x, ct, z, u + shift, 1 - v);
    }
  }
  lattice(mesh, 0, cols, rows, (r) => (r === 0 && bottom ? NO_LOWER : r === rows - 1 && top ? NO_UPPER : BOTH));
  return mesh.done();
}

/**
 * Capsule along y: a straight section of `height` (negative counts as 0) between two hemispheres of `radius`, so it
 * spans y from -(height/2 + radius) to +(height/2 + radius). Each hemisphere has `capSegments` rows of equal angle and
 * the straight part `heightSegments` rows; every row has `radialSegments + 1` vertices with the sphere's azimuth (u = 0
 * on -x, turning through +z). v is the arc length from the bottom pole over the whole profile length (pi * radius +
 * height). Normals are smooth and unit; the pole rows keep one triangle per quad, with u moved half a column like the
 * sphere's. No groups.
 */
export function capsuleGeometry(
  radius = 1,
  height = 1,
  capSegments = 4,
  radialSegments = 8,
  heightSegments = 1,
): GeometryData {
  const caps = count(capSegments, 1),
    cols = count(radialSegments, 3),
    straight = count(heightSegments, 1),
    h = Math.max(0, height),
    half = h / 2,
    total = Math.PI * radius + h,
    on = radius === 0 ? 0 : 1,
    mesh = new Mesh(),
    angular = angles(cols, TAU);
  // The profile from the bottom pole up: radial distance, height, profile normal (radial, y) and arc length.
  const profile: number[][] = [];
  for (let k = 0; k <= caps; k++) {
    const a = Math.PI - (k / caps) * (Math.PI / 2),
      s = Math.sin(a),
      c = Math.cos(a);
    profile.push([radius * s, -half + radius * c, s, c, radius * (Math.PI - a)]);
  }
  for (let k = 1; k <= straight; k++)
    profile.push([radius, -half + (k / straight) * h, 1, 0, (Math.PI / 2) * radius + (k / straight) * h]);
  for (let k = 1; k <= caps; k++) {
    const a = Math.PI / 2 - (k / caps) * (Math.PI / 2),
      s = Math.sin(a),
      c = Math.cos(a);
    profile.push([radius * s, half + radius * c, s, c, (Math.PI / 2) * radius + h + radius * (Math.PI / 2 - a)]);
  }
  const rows = profile.length - 1;
  profile.forEach(([rad, y, nr, ny, arc], r) => {
    const shift = r === 0 ? -0.5 / cols : r === rows ? 0.5 / cols : 0;
    for (let c = 0; c <= cols; c++) {
      const x = -angular[c * 2 + 1],
        z = angular[c * 2];
      mesh.add(rad * x, y, rad * z, nr * x * on, ny * on, nr * z * on, c / cols + shift, total > 0 ? arc / total : 0);
    }
  });
  lattice(mesh, 0, cols, rows, (r) => (r === 0 ? NO_LOWER : r === rows - 1 ? NO_UPPER : BOTH));
  return mesh.done();
}

/**
 * Torus around the z axis, lying in the XY plane: ring `radius` (centre to tube centre) and tube radius `tube`. The
 * ring runs from +x toward +y over `arc` radians in `tubularSegments` steps and each tube cross-section has
 * `radialSegments` steps; UV is (step along the ring, step around the tube), both 0..1. No groups.
 */
export function torusGeometry(
  radius = 1,
  tube = 0.4,
  radialSegments = 12,
  tubularSegments = 48,
  arc = TAU,
): GeometryData {
  const around = count(radialSegments, 1),
    along = count(tubularSegments, 1),
    mesh = new Mesh(),
    angular = angles(along, arc);
  for (let j = 0; j <= around; j++) {
    const v = (j / around) * TAU,
      cv = Math.cos(v),
      sv = Math.sin(v);
    for (let i = 0; i <= along; i++) {
      const cu = angular[i * 2 + 1],
        su = angular[i * 2],
        reach = radius + tube * cv;
      mesh.add(reach * cu, reach * su, tube * sv, cv * cu, cv * su, sv, i / along, j / around);
    }
  }
  lattice(mesh, 0, along, around);
  return mesh.done();
}

/**
 * Tube of radius `tube` around a (p, q) torus knot: the centre line winds `p` times around the z axis and `q` times
 * through the hole of a torus with major radius `radius` and minor radius `radius / 2`. `tubularSegments + 1` rings
 * of `radialSegments + 1` vertices, outward unit normals, UV (along the knot, around the tube); the two end rings
 * coincide. No groups.
 */
export function torusKnotGeometry(
  radius = 1,
  tube = 0.4,
  tubularSegments = 64,
  radialSegments = 8,
  p = 2,
  q = 3,
): GeometryData {
  const along = count(tubularSegments, 1),
    around = count(radialSegments, 1),
    k = radius / 2,
    ratio = q / p,
    mesh = new Mesh();
  const unit = (v: number[]) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
  };
  for (let i = 0; i <= along; i++) {
    const s = (i / along) * p * TAU,
      w = ratio * s,
      reach = 2 + Math.cos(w),
      cs = Math.cos(s),
      ss = Math.sin(s),
      centre = [k * reach * cs, k * reach * ss, k * Math.sin(w)],
      // Exact derivative of the centre line, then a frame from it and the position: B is perpendicular to the plane
      // through the axis origin, the point and its tangent (never degenerate, the in-plane radius is at least k).
      tangent = unit([
        k * (-ratio * Math.sin(w) * cs - reach * ss),
        k * (-ratio * Math.sin(w) * ss + reach * cs),
        k * ratio * Math.cos(w),
      ]),
      b = unit([
        tangent[1] * centre[2] - tangent[2] * centre[1],
        tangent[2] * centre[0] - tangent[0] * centre[2],
        tangent[0] * centre[1] - tangent[1] * centre[0],
      ]),
      n = [
        b[1] * tangent[2] - b[2] * tangent[1],
        b[2] * tangent[0] - b[0] * tangent[2],
        b[0] * tangent[1] - b[1] * tangent[0],
      ];
    for (let j = 0; j <= around; j++) {
      const v = (j / around) * TAU,
        cv = -Math.cos(v),
        sv = Math.sin(v),
        d = [cv * n[0] + sv * b[0], cv * n[1] + sv * b[1], cv * n[2] + sv * b[2]];
      mesh.add(
        centre[0] + tube * d[0],
        centre[1] + tube * d[1],
        centre[2] + tube * d[2],
        d[0],
        d[1],
        d[2],
        i / along,
        j / around,
      );
    }
  }
  // Rows advance along the knot and columns around it: around x along points out, so index with the axes swapped.
  for (let i = 0; i < along; i++)
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j,
        b = a + around + 1;
      mesh.i.push(a, b, b + 1, a, b + 1, a + 1);
    }
  return mesh.done();
}

/**
 * Surface of revolution around +y. Each profile point is [distance from the axis, height]; the profile is swept from
 * `phiStart` over `phiLength` (clamped to [0, 2 pi]) with angle 0 on +z turning toward +x, in `segmentCount` steps
 * (the seam meridian is duplicated, not welded). UV is (step around, profile index / (points - 1)). Normals are the
 * profile's own 2D normals turned with the sweep, unit length; a profile running upward at positive distance faces
 * outward. No groups.
 */
export function latheGeometry(
  points: readonly MutableVec2[] = [
    [0, -0.5],
    [0.5, 0],
    [0, 0.5],
  ],
  segmentCount = 12,
  phiStart = 0,
  phiLength = TAU,
): GeometryData {
  const cols = count(segmentCount, 1);
  if (points.length < 2)
    throw new RangeError(`latheGeometry got ${points.length} profile point(s); pass at least two [x, y] points`);
  const sweep = Math.min(Math.max(phiLength, 0), TAU),
    last = points.length - 1,
    mesh = new Mesh(),
    angular = angles(cols, sweep, phiStart);
  // Profile normals: a segment going (dx, dy) has normal (dy, -dx), weighted by its length; ends take their segment's.
  const normals = points.map((_, j) => {
    let x = 0,
      y = 0;
    if (j > 0) (x += points[j][1] - points[j - 1][1]), (y -= points[j][0] - points[j - 1][0]);
    if (j < last) (x += points[j + 1][1] - points[j][1]), (y -= points[j + 1][0] - points[j][0]);
    const l = Math.hypot(x, y);
    return l ? [x / l, y / l] : [0, 0];
  });
  for (let j = 0; j <= last; j++)
    for (let c = 0; c <= cols; c++) {
      const s = angular[c * 2],
        k = angular[c * 2 + 1],
        [x, y] = points[j],
        [nx, ny] = normals[j];
      mesh.add(x * s, y, x * k, nx * s, ny, nx * k, c / cols, j / last);
    }
  lattice(mesh, 0, cols, last);
  return mesh.done();
}

/**
 * Tube of `radius` swept along `path` (2D points get z = 0): `tubularSegments + 1` rings at even arc-length steps,
 * each of `radialSegments + 1` vertices, oriented by the path's Frenet frames. With `closed` the last ring repeats the
 * first. Normals point out from the path, UV is (along the path, around the tube). No groups.
 */
export function tubeGeometry(
  path: Curve<Vec>,
  tubularSegments = 64,
  radius = 1,
  radialSegments = 8,
  closed = false,
): GeometryData {
  const along = count(tubularSegments, 1),
    around = count(radialSegments, 1),
    frames = path.computeFrenetFrames(along, closed),
    mesh = new Mesh(),
    angular = angles(around, TAU);
  let first: number[][] = [];
  for (let i = 0; i <= along; i++) {
    const ring: number[][] = [];
    if (closed && i === along) ring.push(...first);
    else {
      const centre = to3(path.getPointAt(i / along)),
        N = frames.normals[i],
        B = frames.binormals[i];
      for (let j = 0; j <= around; j++) {
        const cv = -angular[j * 2 + 1],
          sv = angular[j * 2],
          d = [cv * N[0] + sv * B[0], cv * N[1] + sv * B[1], cv * N[2] + sv * B[2]],
          l = Math.hypot(d[0], d[1], d[2]) || 1;
        ring.push([d[0] / l, d[1] / l, d[2] / l, centre[0], centre[1], centre[2]]);
      }
    }
    if (i === 0) first = ring;
    ring.forEach(([nx, ny, nz, x, y, z], j) =>
      mesh.add(x + radius * nx, y + radius * ny, z + radius * nz, nx, ny, nz, i / along, j / around),
    );
  }
  // Rows run along the path and columns around it, as for the torus knot.
  for (let i = 0; i < along; i++)
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j,
        b = a + around + 1;
      mesh.i.push(a, b, b + 1, a, b + 1, a + 1);
    }
  return mesh.done();
}

// `@margoengine/geometry/primitives` serves this module, so it carries the polyhedra too.
export {
  dodecahedronGeometry,
  icosahedronGeometry,
  octahedronGeometry,
  polyhedronGeometry,
  tetrahedronGeometry,
} from './polyhedra.js';
