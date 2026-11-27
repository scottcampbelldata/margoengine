// One call to float a rigid body (SEA-12): `floating(physics, body)` reads the body's own colliders and gives the
// `LoadSolver` bodies that float it, so the buoyancy comes from the same shapes its contacts and mass do.
// - A sphere, box or capsule (any axis) is its analytic shape, set at the collider's offset and turn.
// - A convex hull, a closed triangle mesh, a cylinder and a cone are closed meshes, integrated exactly below the water
//   (buoyancy.ts). A hull reads its own faces; a cylinder or cone is a 64-sided prism or pyramid whose radius keeps the
//   circle's area (r sqrt(2 pi / (n sin(2 pi / n)))), so its displaced volume is exact and its waterplane's second moment
//   within 1e-6 of the circle's.
// - A compound (a convex decomposition too) gives one entry a part, each at its pose: the body's buoyancy is the sum of
//   its parts', as its mass is (parts that overlap count twice in both).
// Sensors and disabled colliders displace nothing. Half spaces, height fields and voxel grids, and rounded colliders
// (border radius above 0), are refused with a coded error naming the fix.
import { invalidLoad } from './errors.js';
import type { LoadBody } from './solver.js';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type Columns = Record<string, ArrayLike<number>>;

/** What {@link floating} reads of a body: a `PhysicsBody`. */
export interface FloatingBody {
  readonly valid: boolean;
  readonly row: number;
  readonly colliders: readonly { readonly handle: number; readonly shape: string }[];
}

/** What {@link floating} reads of the world the bodies are in: a `Physics`. */
export interface FloatingWorld {
  readonly kernel: { readonly columns: Columns };
  getBodies(): readonly FloatingBody[];
}

/** Settings every body {@link floating} makes takes; each is a {@link LoadBody} field of the same name. */
export interface FloatingOptions {
  /** Drag coefficients (default the shape's own, by Reynolds number). */
  readonly drag?: LoadBody['drag'];
  /** Scale on the rotational viscous torque (default 1). */
  readonly spinDrag?: number;
  /** Wind drag coefficient on the emerged area (default the shape's own). */
  readonly windage?: number;
  /** Rotational added inertia, `'ellipsoid'` for Lamb's (default none). */
  readonly addedInertia?: LoadBody['addedInertia'];
  /**
   * `'surface'` integrates the water's incident pressure over every box, hull, mesh, cylinder and cone entry (spheres and
   * capsules stay `'compact'`, which has no surface tier); default `'compact'`, the local water plane.
   */
  readonly pressureModel?: LoadBody['pressureModel'];
}

/** Sides of the prism or pyramid a cylinder or cone floats as. */
export const FLOATING_SIDES = 64;
const NONE = 0xffffffff,
  SENSOR = 1,
  OFF = 2;

/**
 * The {@link LoadSolver} bodies that float these rigid bodies, from their own colliders:
 * `world.add(new LoadSolver(), {sea, bodies: floating(physics, [boat, crate])})`. Read at the call: a collider changed later
 * floats as it was until `floating` is called again for a new solver.
 * @throws MargoError `unsupported` (errors#hydrodynamic-loads) for a body of another world or removed, one with no solid
 *   collider, a half space, height field, voxel grid or open mesh, or a rounded collider.
 */
export function floating(
  physics: FloatingWorld,
  bodies: FloatingBody | readonly FloatingBody[],
  options: FloatingOptions = {},
): LoadBody[] {
  const list = Array.isArray(bodies) ? (bodies as readonly FloatingBody[]) : [bodies as FloatingBody],
    c = physics.kernel.columns,
    own = new Set(physics.getBodies()),
    out: LoadBody[] = [];
  const extra = {
    ...(options.drag !== undefined && { drag: options.drag }),
    ...(options.spinDrag !== undefined && { spinDrag: options.spinDrag }),
    ...(options.windage !== undefined && { windage: options.windage }),
    ...(options.addedInertia !== undefined && { addedInertia: options.addedInertia }),
  };
  if (options.pressureModel !== undefined && options.pressureModel !== 'compact' && options.pressureModel !== 'surface')
    throw invalidLoad("Invalid pressure model; choose 'compact' or 'surface'.");
  const surface = options.pressureModel === 'surface';
  for (const body of list) {
    if (!body?.valid || !own.has(body))
      throw invalidLoad('floating takes live bodies of this Physics; pass bodies physics.addBody returned.');
    const before = out.length;
    for (const collider of body.colliders) {
      const row = collider.handle;
      if (c.colliderFlags[row]! & (SENSOR | OFF)) continue;
      const name = collider.shape;
      if (['heightfield', 'halfSpace', 'voxels', 'polyline', 'triangle', 'segment'].includes(name))
        throw invalidLoad(
          `A ${name} collider has no closed volume to float; give the body a solid collider (box, hull, closed mesh).`,
        );
      if (c.colliderShape[row] === 5)
        for (let child = c.colliderHull[row]!; child !== NONE; child = c.colliderNext[child]!)
          part(c, child, body.row, extra, surface, out);
      else part(c, row, body.row, extra, surface, out);
    }
    if (out.length === before)
      throw invalidLoad('This body has no solid collider to float; add one, or leave the body out.');
  }
  return out;
}

/** One collider row (or compound child) as a load body, its pose in the body's frame. */
function part(c: Columns, row: number, bodyRow: number, extra: object, surface: boolean, out: LoadBody[]): void {
  const shape = c.colliderShape[row]!,
    a = c.colliderA[row]!,
    b = c.colliderB[row]!,
    d = c.colliderC[row]!,
    centre: Vec3 = [c.colliderX[row]!, c.colliderY[row]!, c.colliderZ[row]!],
    q = unit([
      c.colliderRotationX[row]!,
      c.colliderRotationY[row]!,
      c.colliderRotationZ[row]!,
      c.colliderRotationW[row]!,
    ]),
    border = shape === 6 || shape === 7 ? d : c.colliderBorder[row]!;
  if (border > 0)
    throw invalidLoad(
      'A rounded collider (border radius above 0) floats only as its core; set its border to 0 or pass its shape to LoadSolver.',
    );
  const turned = q[0] !== 0 || q[1] !== 0 || q[2] !== 0;
  const at = { row: bodyRow, centre, ...(turned && { rotation: q }), ...extra };
  switch (shape) {
    case 0:
      out.push({ ...at, shape: { sphere: a } });
      return;
    case 1:
      out.push({ ...at, shape: { box: [a, b, d] }, ...(surface && { pressureModel: 'surface' as const }) });
      return;
    case 2:
      // A capsule of radius 0 is a segment: no volume, nothing to float.
      if (a > 0) out.push({ ...at, shape: { capsule: { radius: a, halfHeight: b } } });
      return;
    case 3:
      out.push(meshBody(hullMesh(c, c.colliderHull[row]!), centre, q, bodyRow, extra, surface));
      return;
    case 4:
      out.push(meshBody(triangleMesh(c, c.colliderHull[row]!), centre, q, bodyRow, extra, surface));
      return;
    case 6:
    case 7:
      out.push(meshBody(roundMesh(a, b, shape === 7), centre, q, bodyRow, extra, surface));
      return;
  }
  throw invalidLoad(
    'This collider has no closed volume to float; give the body a solid collider (box, hull, closed mesh).',
  );
}

/** A mesh in the collider's frame, placed in the body's frame (a mesh shape carries its pose in its vertices). */
function meshBody(
  mesh: { vertices: Float64Array; indices: Uint32Array },
  centre: Vec3,
  q: Quat,
  row: number,
  extra: object,
  surface: boolean,
): LoadBody {
  const v = mesh.vertices;
  for (let i = 0; i < v.length; i += 3) {
    const p = rotate(q, v[i]!, v[i + 1]!, v[i + 2]!);
    v[i] = p[0] + centre[0];
    v[i + 1] = p[1] + centre[1];
    v[i + 2] = p[2] + centre[2];
  }
  return { row, shape: { mesh }, ...extra, ...(surface && { pressureModel: 'surface' as const }) };
}

/** A convex hull's faces, fanned into triangles wound outward (its half-edges run counter-clockwise from outside). */
function hullMesh(c: Columns, hull: number): { vertices: Float64Array; indices: Uint32Array } {
  const v0 = c.hullFirstVertex[hull]!,
    count = c.hullVertices[hull]!,
    e0 = c.hullFirstEdge[hull]!,
    f0 = c.hullFirstFace[hull]!,
    faces = c.hullFaces[hull]!,
    edges = c.hullEdges[hull]!,
    vertices = new Float64Array(3 * count),
    indices: number[] = [];
  for (let i = 0; i < count; i++) {
    vertices[3 * i] = c.vertexX[v0 + i]!;
    vertices[3 * i + 1] = c.vertexY[v0 + i]!;
    vertices[3 * i + 2] = c.vertexZ[v0 + i]!;
  }
  for (let f = 0; f < faces; f++) {
    const first = c.faceEdge[f0 + f]!,
      corners: number[] = [];
    // Bounded by the hull's edge count: a face's loop never passes every edge.
    for (let e = first, n = 0; n < edges; n++) {
      corners.push(c.edgeOrigin[e0 + e]!);
      e = c.edgeNext[e0 + e]!;
      if (e === first) break;
    }
    for (let k = 1; k + 1 < corners.length; k++) indices.push(corners[0]!, corners[k]!, corners[k + 1]!);
  }
  return { vertices, indices: Uint32Array.from(indices) };
}

/** A triangle mesh collider's own vertices and triangles. */
function triangleMesh(c: Columns, mesh: number): { vertices: Float64Array; indices: Uint32Array } {
  const v0 = c.meshFirstVertex[mesh]!,
    count = c.meshVertices[mesh]!,
    t0 = c.meshFirstTriangle[mesh]!,
    triangles = c.meshTriangles[mesh]!,
    vertices = new Float64Array(3 * count),
    indices = new Uint32Array(3 * triangles);
  for (let i = 0; i < count; i++) {
    vertices[3 * i] = c.meshVertexX[v0 + i]!;
    vertices[3 * i + 1] = c.meshVertexY[v0 + i]!;
    vertices[3 * i + 2] = c.meshVertexZ[v0 + i]!;
  }
  for (let t = 0; t < triangles; t++) {
    indices[3 * t] = c.triangleA[t0 + t]!;
    indices[3 * t + 1] = c.triangleB[t0 + t]!;
    indices[3 * t + 2] = c.triangleC[t0 + t]!;
  }
  return { vertices, indices };
}

/**
 * A cylinder (or a cone, apex at +halfHeight) along local Y as a regular prism (pyramid) of {@link FLOATING_SIDES}
 * sides whose radius keeps the circle's area, wound outward.
 */
export function roundMesh(
  radius: number,
  halfHeight: number,
  cone: boolean,
): { vertices: Float64Array; indices: Uint32Array } {
  const n = FLOATING_SIDES,
    step = (2 * Math.PI) / n,
    r = radius * Math.sqrt(step / Math.sin(step)),
    vertices: number[] = [0, -halfHeight, 0, 0, halfHeight, 0],
    indices: number[] = [];
  for (let k = 0; k < n; k++) {
    const x = r * Math.cos(k * step),
      z = r * Math.sin(k * step);
    vertices.push(x, -halfHeight, z);
    if (!cone) vertices.push(x, halfHeight, z);
  }
  const low = (k: number) => (cone ? 2 + (k % n) : 2 + 2 * (k % n)),
    high = (k: number) => 3 + 2 * (k % n);
  for (let k = 0; k < n; k++) {
    // k turns from +x toward +z, so (centre, k, k + 1) faces down and each side quad faces out.
    indices.push(0, low(k), low(k + 1));
    if (cone) indices.push(1, low(k + 1), low(k));
    else {
      indices.push(1, high(k + 1), high(k));
      indices.push(low(k), high(k), high(k + 1), low(k), high(k + 1), low(k + 1));
    }
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

function unit(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function rotate(q: Quat, x: number, y: number, z: number): Vec3 {
  const tx = 2 * (q[1] * z - q[2] * y),
    ty = 2 * (q[2] * x - q[0] * z),
    tz = 2 * (q[0] * y - q[1] * x);
  return [
    x + q[3] * tx + (q[1] * tz - q[2] * ty),
    y + q[3] * ty + (q[2] * tx - q[0] * tz),
    z + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
}
