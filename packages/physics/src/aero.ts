// Aerodynamic loads on bodies from their shape (AERO-01 of docs/physics-solvers.md): every collider's surface as small
// panels, each loaded by the air moving past it, so drag, lift and the turning moment come from the body's geometry and
// its motion through the wind, not from one box area and one coefficient.
//
// A panel of area A with outward normal n meets air whose velocity relative to it is w (the wind at the panel minus the
// panel's own velocity, v + omega x r). On the windward side (n . w < 0) it takes the normal force of a flat plate at the
// angle the air meets it, F_n = -1/2 rho |w|^2 A C_N90 sin(a) n with sin(a) = -n . w / |w| (the flat-plate normal-force law
// of S. F. Hoerner, "Fluid-Dynamic Drag", 1965, chapter 3, and "Fluid-Dynamic Lift", 1975, chapter 21, after Flachsbart; C_N90
// = 1.17 for a square plate square to the flow, which already holds the suction behind it). Every panel also takes skin
// friction along the air's tangential motion, F_t = 1/2 rho C_f |w_t| w_t A (Hoerner 1965, chapter 2; C_f 0.004, a
// turbulent plate). Summed about the centre of mass they give the force and the torque. Hoerner was not read here; the
// laws are the textbook ones he tabulates, known through Katz and Plotkin, "Low-Speed Aerodynamics", 2001.
//
// Accepted differences: no sheltering of one body by another and no flow separation from curved surfaces (a sphere takes a
// drag coefficient of 0.78 here against about 0.47 measured below the drag crisis), no added mass, and lift only from
// panels inclined to the flow (a flat plate's sin-law lift), not the circulation lift of a wing (AERO-03) or a sail
// (AERO-02).
import { cos, hypot, sin } from '@margoengine/math/pinned';
import type { PhysicsCollider } from './collider.js';
import { buildHull } from './hull.js';

/** A surface as panels in its collider's frame: centres, unit outward normals (xyz each) and areas. */
export interface Surface {
  readonly centres: Float64Array;
  readonly normals: Float64Array;
  readonly areas: Float64Array;
}

/** Panels a side of a box face, and the subdivision of a ball's icosahedron, at the default detail. */
const BOX_PANELS = 4;
const SPHERE_LEVEL = 2;
const RING = 16;
const TWO_PI = 6.283185307179586;

/**
 * The surface of `collider` as panels in its frame. Boxes, balls, capsules, cylinders, cones, convex hulls and triangle
 * meshes take their own shape; any other shape takes the box of its bounds, in the body's frame.
 */
export function colliderSurface(collider: PhysicsCollider): Surface {
  const out = new SurfaceBuilder();
  switch (collider.shape) {
    case 'box': {
      const e = collider.halfExtents()!;
      box(out, e.x, e.y, e.z);
      break;
    }
    case 'sphere':
      sphere(out, collider.radius(), 0);
      break;
    case 'capsule': {
      const r = collider.radius(),
        h = collider.halfHeight();
      tube(out, r, h);
      sphereCap(out, r, h, 1);
      sphereCap(out, r, -h, -1);
      break;
    }
    case 'cylinder': {
      const r = collider.radius(),
        h = collider.halfHeight();
      tube(out, r, h);
      disc(out, r, h, 1);
      disc(out, r, -h, -1);
      break;
    }
    case 'cone':
      cone(out, collider.radius(), collider.halfHeight());
      break;
    case 'convexHull': {
      const hull = buildHull(collider.vertices());
      for (const face of hull.faces)
        for (let k = 1; k + 1 < face.length; k++)
          out.triangle(hull.vertices[face[0]!]!, hull.vertices[face[k]!]!, hull.vertices[face[k + 1]!]!);
      break;
    }
    case 'trimesh': {
      const v = collider.vertices(),
        idx = collider.indices()!,
        p = (i: number): [number, number, number] => [v[3 * i]!, v[3 * i + 1]!, v[3 * i + 2]!];
      for (let t = 0; t + 2 < idx.length; t += 3) out.triangle(p(idx[t]!), p(idx[t + 1]!), p(idx[t + 2]!));
      break;
    }
    default: {
      // The box of the collider's bounds (world axes), about its centre.
      const b = collider.aabb();
      box(out, (b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2);
    }
  }
  return out.build();
}

class SurfaceBuilder {
  private readonly c: number[] = [];
  private readonly n: number[] = [];
  private readonly a: number[] = [];

  /** A triangle a, b, c (counter-clockwise seen from outside). */
  triangle(a: readonly number[], b: readonly number[], c: readonly number[]): void {
    const ux = b[0]! - a[0]!,
      uy = b[1]! - a[1]!,
      uz = b[2]! - a[2]!,
      vx = c[0]! - a[0]!,
      vy = c[1]! - a[1]!,
      vz = c[2]! - a[2]!,
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      twice = hypot(nx, ny, nz);
    if (!(twice > 0)) return;
    this.c.push((a[0]! + b[0]! + c[0]!) / 3, (a[1]! + b[1]! + c[1]!) / 3, (a[2]! + b[2]! + c[2]!) / 3);
    this.n.push(nx / twice, ny / twice, nz / twice);
    this.a.push(twice / 2);
  }

  build(): Surface {
    return { centres: Float64Array.from(this.c), normals: Float64Array.from(this.n), areas: Float64Array.from(this.a) };
  }
}

/** A box of half extents x, y, z, each face in BOX_PANELS by BOX_PANELS squares. */
function box(out: SurfaceBuilder, x: number, y: number, z: number): void {
  const half = [x, y, z];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [1, -1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3;
      for (let i = 0; i < BOX_PANELS; i++)
        for (let j = 0; j < BOX_PANELS; j++) {
          const corner = (a: number, b: number) => {
            const p = [0, 0, 0];
            p[axis] = side * half[axis]!;
            p[u] = half[u]! * (-1 + (2 * a) / BOX_PANELS);
            p[v] = half[v]! * (-1 + (2 * b) / BOX_PANELS);
            return p;
          };
          const p00 = corner(i, j),
            p10 = corner(i + 1, j),
            p11 = corner(i + 1, j + 1),
            p01 = corner(i, j + 1);
          // (u, v, axis) is right-handed, so u then v winds outward on the + side.
          if (side > 0) {
            out.triangle(p00, p10, p11);
            out.triangle(p00, p11, p01);
          } else {
            out.triangle(p00, p11, p10);
            out.triangle(p00, p01, p11);
          }
        }
    }
}

/** An icosahedron subdivided `SPHERE_LEVEL` times onto a sphere of `radius` about y = `y`. */
function sphere(out: SurfaceBuilder, radius: number, y: number, keep: (p: number[]) => boolean = () => true): void {
  const t = 1.618033988749895,
    base = [
      [-1, t, 0],
      [1, t, 0],
      [-1, -t, 0],
      [1, -t, 0],
      [0, -1, t],
      [0, 1, t],
      [0, -1, -t],
      [0, 1, -t],
      [t, 0, -1],
      [t, 0, 1],
      [-t, 0, -1],
      [-t, 0, 1],
    ],
    faces = [
      [0, 11, 5],
      [0, 5, 1],
      [0, 1, 7],
      [0, 7, 10],
      [0, 10, 11],
      [1, 5, 9],
      [5, 11, 4],
      [11, 10, 2],
      [10, 7, 6],
      [7, 1, 8],
      [3, 9, 4],
      [3, 4, 2],
      [3, 2, 6],
      [3, 6, 8],
      [3, 8, 9],
      [4, 9, 5],
      [2, 4, 11],
      [6, 2, 10],
      [8, 6, 7],
      [9, 8, 1],
    ],
    onSphere = (p: number[]) => {
      const l = hypot(p[0]!, p[1]!, p[2]!);
      return [p[0]! / l, p[1]! / l, p[2]! / l];
    };
  let tris = faces.map((f) => f.map((i) => onSphere(base[i]!)));
  for (let level = 0; level < SPHERE_LEVEL; level++)
    tris = tris.flatMap(([a, b, c]) => {
      const mid = (p: number[], q: number[]) =>
          onSphere([(p[0]! + q[0]!) / 2, (p[1]! + q[1]!) / 2, (p[2]! + q[2]!) / 2]),
        ab = mid(a!, b!),
        bc = mid(b!, c!),
        ca = mid(c!, a!);
      return [
        [a!, ab, ca],
        [ab, b!, bc],
        [ca, bc, c!],
        [ab, bc, ca],
      ];
    });
  for (const [a, b, c] of tris) {
    const centre = [(a![0]! + b![0]! + c![0]!) / 3, (a![1]! + b![1]! + c![1]!) / 3, (a![2]! + b![2]! + c![2]!) / 3];
    if (!keep(centre)) continue;
    const s = (p: number[]) => [p[0]! * radius, p[1]! * radius + y, p[2]! * radius];
    out.triangle(s(a!), s(b!), s(c!));
  }
}

/** The half of a sphere of `radius` centred at y = `y` on the side `side` (+1 up, -1 down). */
function sphereCap(out: SurfaceBuilder, radius: number, y: number, side: number): void {
  // Each triangle of the sphere goes to exactly one cap: its centre's height decides, the equator's to the upper.
  sphere(out, radius, y, (p) => (side > 0 ? p[1]! >= 0 : p[1]! < 0));
}

/** The side of a cylinder of `radius` from y = -h to h, in RING strips. */
function tube(out: SurfaceBuilder, radius: number, h: number): void {
  for (let k = 0; k < RING; k++) {
    const a0 = (TWO_PI * k) / RING,
      a1 = (TWO_PI * (k + 1)) / RING,
      p = (a: number, y: number) => [radius * cos(a), y, radius * sin(a)];
    out.triangle(p(a0, -h), p(a1, h), p(a1, -h));
    out.triangle(p(a0, -h), p(a0, h), p(a1, h));
  }
}

/** A flat disc of `radius` at y = `y` facing `side`. */
function disc(out: SurfaceBuilder, radius: number, y: number, side: number): void {
  for (let k = 0; k < RING; k++) {
    const a0 = (TWO_PI * k) / RING,
      a1 = (TWO_PI * (k + 1)) / RING,
      p = (a: number) => [radius * cos(a), y, radius * sin(a)];
    if (side > 0) out.triangle([0, y, 0], p(a1), p(a0));
    else out.triangle([0, y, 0], p(a0), p(a1));
  }
}

/** A cone of base `radius` at y = -h and apex at y = h, with its base. */
function cone(out: SurfaceBuilder, radius: number, h: number): void {
  for (let k = 0; k < RING; k++) {
    const a0 = (TWO_PI * k) / RING,
      a1 = (TWO_PI * (k + 1)) / RING,
      p = (a: number) => [radius * cos(a), -h, radius * sin(a)];
    out.triangle(p(a0), [0, h, 0], p(a1));
  }
  disc(out, radius, -h, -1);
}
