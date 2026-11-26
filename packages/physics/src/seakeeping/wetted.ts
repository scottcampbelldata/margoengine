// The water's load on a hull (SEA-08): the pressure of the water integrated over the wetted part of the hull's surface, the
// hull a closed triangle mesh wound outward. Each triangle is cut where the sea's surface crosses it: a vertex is wet when it
// lies under the surface above it, an edge from a wet vertex to a dry one is cut where the surface meets it (the linear guess
// s = h_A / (h_A - h_B) from the two heights over the surface, then two secant steps that ask the surface again, a fixed
// count so the cut is the same everywhere), and a triangle with one wet corner leaves a triangle, with two a quadrilateral,
// split in two (Kerner, "Water interaction model for boats in video games", 2015). The force is -integral of p n dA and the
// moment about a point c -integral of p (r - c) x n dA, summed in f64 in the mesh's order.
//
// The pressure is the sea's: hydrostatic below the mean level plus the waves' dynamic pressure, stretched so it is 0 at the
// surface itself (Wheeler stretching; Giorgi, Sirigu, Bonfanti, Bracco and Mattiazzo, "Fast nonlinear Froude-Krylov force
// calculation for prismatic floating platforms", J. Ocean Eng. Mar. Energy 2021, compare it with the other cheap choices and
// keep it), which is the nonlinear Froude-Krylov load over the instantaneous wetted surface. A sea that gives no pressure is
// taken as still water to its local surface, rho g (eta - y). Each piece is integrated by Dunavant's six-point rule of degree
// four (Dunavant, "High degree efficient symmetrical Gaussian quadrature rules for the triangle", IJNME 21(6), 1985): the
// hydrostatic force (degree one) and moment (degree two) are exact, and the waves' pressure, smooth over a piece much
// smaller than a wavelength, is close.

/** A point or a direction, x, y (up), z. */
export type Vec3 = readonly [number, number, number];
/** A rotation as a unit quaternion x, y, z, w. */
export type Quat = readonly [number, number, number, number];

/** The water a hull floats in: its surface and, optionally, its pressure. Distances in metres, y up, times in seconds. */
export interface SeaQuery {
  /** The height of the water's surface over (x, z) at time t. */
  elevation(x: number, z: number, t: number): number;
  /**
   * The gauge pressure of the water (Pa) at (x, y, z) under the surface at time t: hydrostatic plus the waves' dynamic
   * pressure, 0 at the surface. Left out, the water is still to its local surface: rho g (eta - y).
   */
  pressure?(x: number, y: number, z: number, t: number): number;
  /** The water's density, kg/m^3 (default sea water, 1025). */
  readonly density?: number;
}

/** A closed hull: vertices (x, y, z each, in the body's frame) and triangles of three vertex indices, wound outward. */
export interface HullMesh {
  readonly vertices: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}

/** Where a hull is: the body's position and rotation (its frame's origin, as the mesh's vertices are given). */
export interface HullPose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

/** The water's load on a hull at an instant. */
export interface WettedLoads {
  /** Force, N, world axes. */
  force: [number, number, number];
  /** Moment about the point asked for, N m, world axes. */
  torque: [number, number, number];
  /** Wetted area, m^2. */
  area: number;
}

/** Gravity's pull, m/s^2. */
export const GRAVITY = 9.81;
/** Sea water's density, kg/m^3. */
export const SEA_WATER = 1025;

// Dunavant's degree-four rule on the triangle: barycentric coordinates and weights (the weights add to 1).
const A1 = 0.445948490915965,
  B1 = 0.10810301816807,
  W1 = 0.223381589678011,
  A2 = 0.091576213509771,
  B2 = 0.816847572980459,
  W2 = 0.109951743655322;
const RULE: readonly (readonly [number, number, number, number])[] = [
  [B1, A1, A1, W1],
  [A1, B1, A1, W1],
  [A1, A1, B1, W1],
  [B2, A2, A2, W2],
  [A2, B2, A2, W2],
  [A2, A2, B2, W2],
];
/** Secant steps after the linear guess, where an edge is cut by the surface. */
const SECANT_STEPS = 2;

function rotate(q: Quat, v: Vec3): [number, number, number] {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/**
 * The form drag of a hull moving through the water: on each wet piece facing the way it moves, the stagnation pressure
 * 1/2 rho C (v . n)^2 (Newton's impact model of drag; with C = 1.05, Hoerner's cube, a box face-on takes the cube's drag).
 * `velocity(x, y, z, out)` writes the surface's velocity relative to the water at a point (world, m/s).
 */
export interface WettedDrag {
  readonly coefficient: number;
  velocity(x: number, y: number, z: number, out: [number, number, number]): void;
}

/** Hoerner's drag coefficient of a cube face-on (*Fluid-Dynamic Drag*, 1965). */
export const FORM_DRAG = 1.05;

/**
 * The water's load on `hull` at `pose` in `sea` at time `t`: the force, the moment about `about` and the wetted area.
 * Writes into `out` when given. With `drag`, each wet piece also takes its form drag.
 */
export function wettedLoads(
  hull: HullMesh,
  pose: HullPose,
  sea: SeaQuery,
  t: number,
  about: Vec3,
  out?: WettedLoads,
  drag?: WettedDrag,
): WettedLoads {
  const loads = out ?? { force: [0, 0, 0], torque: [0, 0, 0], area: 0 };
  loads.force[0] = loads.force[1] = loads.force[2] = 0;
  loads.torque[0] = loads.torque[1] = loads.torque[2] = 0;
  loads.area = 0;
  const { vertices, indices } = hull,
    rho = sea.density ?? SEA_WATER,
    count = vertices.length / 3,
    world = new Float64Array(vertices.length),
    height = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const p = rotate(pose.rotation, [vertices[3 * i]!, vertices[3 * i + 1]!, vertices[3 * i + 2]!]);
    world[3 * i] = p[0] + pose.position[0];
    world[3 * i + 1] = p[1] + pose.position[1];
    world[3 * i + 2] = p[2] + pose.position[2];
    height[i] = world[3 * i + 1]! - sea.elevation(world[3 * i]!, world[3 * i + 2]!, t);
  }
  const pressure = sea.pressure
    ? (x: number, y: number, z: number) => sea.pressure!(x, y, z, t)
    : (x: number, y: number, z: number) => {
        const below = sea.elevation(x, z, t) - y;
        return below > 0 ? rho * GRAVITY * below : 0;
      };
  const at = (i: number): [number, number, number] => [world[3 * i]!, world[3 * i + 1]!, world[3 * i + 2]!],
    moving: [number, number, number] = [0, 0, 0];
  // Where the surface crosses the edge from wet `a` (height ha < 0) to dry `b` (hb >= 0).
  const cut = (a: Vec3, ha: number, b: Vec3, hb: number): [number, number, number] => {
    let lo = 0,
      flo = ha,
      hi = 1,
      fhi = hb,
      s = ha / (ha - hb);
    for (let step = 0; step < SECANT_STEPS; step++) {
      const x = a[0] + s * (b[0] - a[0]),
        y = a[1] + s * (b[1] - a[1]),
        z = a[2] + s * (b[2] - a[2]),
        f = y - sea.elevation(x, z, t);
      if (f < 0) {
        lo = s;
        flo = f;
      } else {
        hi = s;
        fhi = f;
      }
      if (!(fhi - flo > 0)) break;
      s = lo - (flo * (hi - lo)) / (fhi - flo);
    }
    return [a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), a[2] + s * (b[2] - a[2])];
  };
  const piece = (p0: Vec3, p1: Vec3, p2: Vec3): void => {
    // Twice the area times the outward normal.
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]],
      e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]],
      nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(length > 0)) return;
    loads.area += length / 2;
    for (const [u, v, w, weight] of RULE) {
      const x = u * p0[0] + v * p1[0] + w * p2[0],
        y = u * p0[1] + v * p1[1] + w * p2[1],
        z = u * p0[2] + v * p1[2] + w * p2[2];
      let p = pressure(x, y, z);
      if (drag) {
        drag.velocity(x, y, z, moving);
        const vn = (moving[0] * nx + moving[1] * ny + moving[2] * nz) / length;
        if (vn > 0) p += 0.5 * rho * drag.coefficient * vn * vn;
      }
      // -p n dA: the push of the water into the hull, half the cross product being n dA over the piece.
      const k = (-weight * p) / 2,
        fx = k * nx,
        fy = k * ny,
        fz = k * nz,
        rx = x - about[0],
        ry = y - about[1],
        rz = z - about[2];
      loads.force[0] += fx;
      loads.force[1] += fy;
      loads.force[2] += fz;
      loads.torque[0] += ry * fz - rz * fy;
      loads.torque[1] += rz * fx - rx * fz;
      loads.torque[2] += rx * fy - ry * fx;
    }
  };
  for (let k = 0; k + 2 < indices.length; k += 3) {
    const i = [indices[k]!, indices[k + 1]!, indices[k + 2]!],
      h = [height[i[0]!]!, height[i[1]!]!, height[i[2]!]!],
      wet = (h[0]! < 0 ? 1 : 0) + (h[1]! < 0 ? 1 : 0) + (h[2]! < 0 ? 1 : 0);
    if (wet === 0) continue;
    const p = [at(i[0]!), at(i[1]!), at(i[2]!)];
    if (wet === 3) {
      piece(p[0]!, p[1]!, p[2]!);
      continue;
    }
    // Turn the corners so the odd one out comes first, keeping their order round the triangle (and so the winding).
    let first = 0;
    for (let c = 0; c < 3; c++) if (h[c]! < 0 === (wet === 1)) first = c;
    const a = p[first]!,
      b = p[(first + 1) % 3]!,
      c = p[(first + 2) % 3]!,
      ha = h[first]!,
      hb = h[(first + 1) % 3]!,
      hc = h[(first + 2) % 3]!;
    if (wet === 1) {
      // Only `a` is wet: the triangle a, ab, ac.
      piece(a, cut(a, ha, b, hb), cut(a, ha, c, hc));
    } else {
      // Only `a` is dry: the quadrilateral ab, b, c, ca, in two triangles.
      const ab = cut(b, hb, a, ha),
        ca = cut(c, hc, a, ha);
      piece(ab, b, c);
      piece(ab, c, ca);
    }
  }
  return loads;
}
