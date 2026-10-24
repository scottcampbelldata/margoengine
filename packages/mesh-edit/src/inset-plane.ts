import { MargoError, type Mat4, type MutableVec2, type MutableVec3 } from '@margoengine/math';
import { cross, dot, normalize, sub } from '@margoengine/math/vec3';
import { assertInsetEdges, insetInteriorDisplacements } from './inset-graph.js';
import { transformPoint } from './matrix.js';
import { edgeId, meshPolygonNormal, polygon2DError } from './polygon.js';
import type { CapRegion } from './region-topology.js';
import type { PolygonMesh } from './types.js';

const metricPoint = (matrix: Mat4 | undefined, point: MutableVec3): MutableVec3 =>
  matrix ? transformPoint(matrix, point, 'Inset metric') : [...point];
const area = (points: MutableVec2[]) =>
  points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p[0] * q[1] - p[1] * q[0];
  }, 0);

/** Prepare one planar region for inset; the returned function places and checks it for a given width. */
export function prepareInsetRegionPlacement(
  mesh: PolygonMesh,
  { faces, boundary, vertices }: CapRegion,
  world: Mat4 | undefined,
  inverse: Mat4 | undefined,
): (width: number) => { positions: MutableVec3[]; loops: string[][] } {
  const member = new Set(faces),
    byFace = new Map(mesh.faces.map((f) => [f.id, f])),
    points = new Map(vertices.map((i) => [i, metricPoint(world, mesh.vertices[i])])),
    first = byFace.get(faces[0])!,
    origin = points.get(first.vertices[0])!;
  let extent = 0,
    coordinate = 0;
  for (const i of vertices) {
    const p = points.get(i)!;
    extent = Math.max(extent, Math.hypot(...sub(p, origin)));
    coordinate = Math.max(coordinate, ...p.map(Math.abs));
  }
  const epsilon = Math.max(1e-10, (coordinate * Number.EPSILON * 16) / extent);
  if (!(extent > 0) || !Number.isFinite(extent))
    throw new RangeError('Inset region extent must be finite and nonzero; repair or rescale its geometry.');
  const relative = (i: number) => sub(points.get(i)!, origin).map((value) => value / extent) as MutableVec3,
    normal = meshPolygonNormal(first.vertices.map(relative)),
    vectors = first.vertices.map((v, i) => sub(relative(first.vertices[(i + 1) % first.vertices.length]), relative(v))),
    u = normalize(vectors.reduce((a, b) => (Math.hypot(...a) > Math.hypot(...b) ? a : b))),
    v = cross(normal, u),
    projected = new Map<number, MutableVec2>();
  for (const i of vertices) {
    const p = sub(points.get(i)!, origin);
    if (Math.abs(dot(p, normal)) / extent > epsilon)
      throw new MargoError(
        'unsupported',
        'Inset needs a planar connected region; select coplanar faces or split the patch.',
      );
    projected.set(i, [dot(p, u) / extent, dot(p, v) / extent]);
  }
  for (const id of faces)
    if (area(byFace.get(id)!.vertices.map((i) => projected.get(i)!)) <= epsilon * epsilon)
      throw new MargoError(
        'unsupported',
        'Inset region faces must have coherent orientation and positive area; repair its winding or split the patch.',
      );
  const edges = new Map<string, readonly [number, number]>();
  for (const id of faces) {
    const face = byFace.get(id)!;
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length];
      edges.set(edgeId(a, b), [a, b]);
    });
  }
  const segments = (
    pairs: readonly (readonly [number, number])[],
    map: ReadonlyMap<number, MutableVec2>,
    prefix: string,
  ) => pairs.map(([a, b]) => ({ a: prefix + a, b: prefix + b, p: map.get(a)!, q: map.get(b)! }));
  assertInsetEdges(segments([...edges.values()], projected, 's'), epsilon, true);
  const outgoing = new Map<number, { to: number; edge: string }>(),
    incoming = new Map<number, number>();
  for (const edge of boundary) {
    const incidence = edge.incidences.find((i) => member.has(i.faceId))!;
    if (outgoing.has(incidence.from) || incoming.has(incidence.to))
      throw new MargoError('unsupported', 'Inset boundary branches at a vertex; select separate manifold patches.');
    outgoing.set(incidence.from, { to: incidence.to, edge: edge.id });
    incoming.set(incidence.to, incidence.from);
  }
  const loops: number[][] = [],
    loopEdges: string[][] = [],
    seen = new Set<number>();
  for (const start of outgoing.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [],
      ids: string[] = [];
    let current = start;
    do {
      if (seen.has(current) || !outgoing.has(current) || !incoming.has(current))
        throw new MargoError(
          'unsupported',
          'Inset boundary is not a closed loop; repair its topology before insetting.',
        );
      seen.add(current);
      loop.push(current);
      const next = outgoing.get(current)!;
      ids.push(next.edge);
      current = next.to;
    } while (current !== start);
    if (loop.length < 3)
      throw new MargoError('unsupported', 'Inset boundary needs at least three distinct corners; repair its topology.');
    loops.push(loop);
    loopEdges.push(ids);
  }
  const caps = new Map<number, MutableVec2>();
  for (const loop of loops) {
    const corners: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      const a = projected.get(loop[(i + loop.length - 1) % loop.length])!,
        b = projected.get(loop[i])!,
        c = projected.get(loop[(i + 1) % loop.length])!,
        d = [b[0] - a[0], b[1] - a[1]],
        e = [c[0] - b[0], c[1] - b[1]],
        dl = Math.hypot(...d),
        el = Math.hypot(...e),
        t = d[0] * e[1] - d[1] * e[0];
      if (Math.abs(t) <= epsilon * (dl + el) && d[0] * e[0] + d[1] * e[1] > 0) continue;
      const left: MutableVec2 = [-d[1] / dl, d[0] / dl],
        right: MutableVec2 = [-e[1] / el, e[0] / el],
        denominator = 1 + left[0] * right[0] + left[1] * right[1];
      if (denominator <= epsilon)
        throw new RangeError(
          'Inset boundary has an unresolved sharp reversal; split the corner or choose a simpler patch.',
        );
      caps.set(loop[i], [(left[0] + right[0]) / denominator, (left[1] + right[1]) / denominator]);
      corners.push(i);
    }
    if (corners.length < 3)
      throw new RangeError('Inset region has degenerate boundary corners; repair the planar patch.');
    for (let i = 0; i < corners.length; i++) {
      const start = corners[i],
        end = corners[(i + 1) % corners.length],
        a = projected.get(loop[start])!,
        b = projected.get(loop[end])!,
        p = caps.get(loop[start])!,
        q = caps.get(loop[end])!,
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let j = (start + 1) % loop.length; j !== end; j = (j + 1) % loop.length) {
        const at = projected.get(loop[j])!,
          fraction = Math.hypot(at[0] - a[0], at[1] - a[1]) / length;
        caps.set(loop[j], [p[0] + (q[0] - p[0]) * fraction, p[1] + (q[1] - p[1]) * fraction]);
      }
    }
  }
  const displacements = insetInteriorDisplacements(vertices, [...edges.values()], caps);
  return (width) => {
    const distance = width / extent;
    if (!Number.isFinite(distance) || distance <= epsilon * 4)
      throw new RangeError(
        'Inset width is too small for these coordinates; move the mesh nearer its origin or choose a larger width.',
      );
    const caps = new Map<number, MutableVec2>();
    for (const i of vertices) {
      const old = projected.get(i)!,
        d = displacements.get(i)!;
      caps.set(i, [old[0] + d[0] * distance, old[1] + d[1] * distance]);
    }
    for (const id of faces)
      checkPolygon(
        byFace.get(id)!.vertices.map((i) => caps.get(i)!),
        epsilon,
      );
    const finalSegments = segments([...edges.values()], caps, 'c');
    for (const edge of boundary) {
      const incidence = edge.incidences.find((i) => member.has(i.faceId))!,
        a = incidence.from,
        b = incidence.to;
      checkPolygon([projected.get(a)!, projected.get(b)!, caps.get(b)!, caps.get(a)!], epsilon);
      finalSegments.push({ a: 's' + a, b: 's' + b, p: projected.get(a)!, q: projected.get(b)! });
    }
    for (const i of outgoing.keys())
      finalSegments.push({ a: 's' + i, b: 'c' + i, p: projected.get(i)!, q: caps.get(i)! });
    assertInsetEdges(finalSegments, epsilon);
    const positions = vertices.map((i) => {
      const p = caps.get(i)!,
        worldPoint = origin.map((value, a) => value + extent * (p[0] * u[a] + p[1] * v[a])) as MutableVec3;
      return metricPoint(inverse, worldPoint);
    });
    return { positions, loops: loopEdges.map((loop) => [...loop]) };
  };
}

function checkPolygon(points: MutableVec2[], epsilon: number): void {
  if (area(points) <= epsilon * epsilon || polygon2DError(points))
    throw new RangeError(
      'Inset width folds or collapses a face; reduce the width or split the region before insetting.',
    );
}
