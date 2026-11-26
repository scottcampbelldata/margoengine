// Subdivide the cap of each tetrahedron intersected by a finite triangle. Shared-face
// intersections use a common registry, and a cut only releases the covered cap triangles.
import type { Vec3 } from './math.js';
import { incisionPieces } from './soft-incision-connect.js';
import {
  childCell,
  cross,
  cutDistances,
  faceIntersection,
  faceKey,
  pullCells,
  FACES,
  sectionPolygon,
  type SliceCell,
  type SlicePlan,
  type SlicePoint,
  subtract,
  type Tet,
} from './soft-plane-cut.js';

type Plane = { readonly origin: Vec3; readonly normal: Vec3 };
type Triangle = [number, number, number];
type Section = { ring: number[]; negative: boolean; positive: boolean; refined: boolean; triangles: Triangle[] };
type Parent = {
  readonly tet: Tet;
  readonly parts: { readonly faces: number[][]; readonly section: Section | null }[];
};
type Weights = NonNullable<SlicePoint['vertices']>;
const AXES = [0, 1, 2] as const;
const SIGNS = [-1, 1] as const;

const reference = (p: number): SlicePoint => ({ first: p, second: p, weight: 0 });
const vertexOrder = (a: number, b: number): number => a - b;
const edgeKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
const vector = (f: (i: 0 | 1 | 2) => number): Vec3 => [f(0), f(1), f(2)];

class IncisionGeometry {
  readonly points: SlicePoint[];
  readonly edgePlanes: readonly number[];
  private readonly positions: Vec3[];
  private readonly zeros: Set<number>[];
  private readonly intersections = new Map<string, number>();
  private readonly subdivisions = new Map<string, number[]>();
  private readonly centres = new Map<string, number>();

  constructor(
    current: Float32Array,
    private readonly planes: readonly Plane[],
  ) {
    this.edgePlanes = planes.slice(1).map((_, i) => i + 1);
    this.zeros = planes.map(() => new Set<number>());
    this.positions = Array.from({ length: current.length / 3 }, (_, p) => vector((i) => current[p * 3 + i]!));
    this.points = this.positions.map((_, p) => reference(p));
  }

  distance(plane: number, id: number): number {
    if (this.zeros[plane]!.has(id)) return 0;
    const { origin, normal } = this.planes[plane]!;
    const offset = subtract(this.positions[id]!, origin);
    const terms = vector((axis) => offset[axis] * normal[axis]);
    const distance = terms[0] + terms[1] + terms[2];
    const roundoff =
      (plane === 0 ? 8 : 16) * Number.EPSILON * (Math.abs(terms[0]) + Math.abs(terms[1]) + Math.abs(terms[2]));
    return Math.abs(distance) <= roundoff ? 0 : distance;
  }

  private blend(nodes: readonly number[], fractions: readonly number[]): number {
    const ancestry = new Map<number, number>();
    nodes.forEach((node, i) => {
      const point = this.points[node]!;
      const sources: Weights = point.vertices ?? [[point.first, 1]];
      for (const [particle, weight] of sources)
        ancestry.set(particle, (ancestry.get(particle) ?? 0) + weight * fractions[i]!);
    });
    const vertices = [...ancestry.entries()].sort(([a], [b]) => vertexOrder(a, b));
    const id = this.points.length;
    this.points.push({ ...reference(vertices[0]![0]), vertices });
    this.positions.push(
      vector((axis) => nodes.reduce((sum, p, i) => sum + fractions[i]! * this.positions[p]![axis], 0)),
    );
    return id;
  }

  intersection(plane: number, a: number, b: number): number {
    const id = `${plane}:${edgeKey(a, b)}`;
    const old = this.intersections.get(id);
    if (old !== undefined) return old;
    const first = Math.min(a, b);
    const last = Math.max(a, b);
    const u = Math.abs(this.distance(plane, first));
    const v = Math.abs(this.distance(plane, last));
    const fraction = u / (u + v);
    const point = this.blend([first, last], [1 - fraction, fraction]);
    this.intersections.set(id, point);
    this.zeros[plane]!.add(point);
    for (let other = 0; other < this.planes.length; other++)
      if (this.distance(other, first) === 0 && this.distance(other, last) === 0) this.zeros[other]!.add(point);
    return point;
  }

  sectionEdge(a: number, b: number): number {
    const point = this.intersection(0, a, b);
    this.subdivisions.set(edgeKey(a, b), [point]);
    return point;
  }

  /** Once a crack advances past its old front, each lip needs its own point along that old edge. */
  splitCrackEdge(a: number, b: number): void {
    const point = this.blend([a, b], [0.5, 0.5]);
    this.zeros[0]!.add(point);
    this.subdivisions.set(edgeKey(a, b), [point]);
  }

  /** Both tetrahedra incident to an old facet insert the same blade-line intersections along it. */
  capEdge(a: number, b: number): void {
    const key = edgeKey(a, b);
    if (this.subdivisions.has(key)) return;
    const first = Math.min(a, b);
    const last = Math.max(a, b);
    const crossings: { plane: number; fraction: number }[] = [];
    for (const plane of this.edgePlanes) {
      const u = this.distance(plane, first);
      const v = this.distance(plane, last);
      if (Math.sign(u) * Math.sign(v) < 0) crossings.push({ plane, fraction: u / (u - v) });
    }
    crossings.sort((a, b) => a.fraction - b.fraction);
    const nodes: number[] = [];
    let previous = -1;
    for (const { plane, fraction } of crossings) {
      if (Math.abs(fraction - previous) <= 32 * Number.EPSILON) {
        const same = nodes[nodes.length - 1]!;
        this.zeros[plane]!.add(same);
        this.intersections.set(`${plane}:${key}`, same);
        continue;
      }
      previous = fraction;
      nodes.push(this.intersection(plane, first, last));
    }
    const boundary = [first, ...nodes, last];
    const front = (node: number): boolean => this.edgePlanes.some((plane) => this.distance(plane, node) === 0);
    const refined: number[] = [];
    for (let i = 0; i < boundary.length - 1; i++) {
      const a = boundary[i]!;
      const b = boundary[i + 1]!;
      if (i > 0) refined.push(a);
      // A seam inside the blade can join two points on its front. Insert an interior
      // degree of freedom so the two lips do not share that edge in the tetrahedron mesh.
      if (
        front(a) &&
        front(b) &&
        this.edgePlanes.every((plane) => this.distance(plane, a) + this.distance(plane, b) > 0)
      ) {
        const mid = this.blend([a, b], [0.5, 0.5]);
        this.zeros[0]!.add(mid);
        refined.push(mid);
      }
    }
    this.subdivisions.set(key, refined);
  }

  refineEdges(ring: number[]): number[] {
    return ring.flatMap((a, i) => {
      const b = ring[(i + 1) % ring.length]!;
      const extras = this.subdivisions.get(edgeKey(a, b));
      return extras?.length ? [a, ...(a < b ? extras : [...extras].reverse())] : [a];
    });
  }

  splitRing(ring: number[], plane: number): { ring: number[]; inside: boolean }[] {
    const distances = ring.map((id) => this.distance(plane, id));
    const negative = distances.some((d) => d < 0);
    const positive = distances.some((d) => d > 0);
    if (!(positive && negative)) return [{ ring, inside: !negative }];
    return SIGNS.map((side) => {
      const clipped: number[] = [];
      ring.forEach((a, i) => {
        const next = (i + 1) % ring.length;
        if (side * distances[i]! >= 0) clipped.push(a);
        if (Math.sign(distances[i]!) * Math.sign(distances[next]!) < 0)
          clipped.push(this.intersection(plane, a, ring[next]!));
      });
      return { ring: clipped, inside: side > 0 };
    });
  }

  hasArea(ring: number[]): boolean {
    if (ring.length < 3) return false;
    const origin = this.positions[ring[0]!]!;
    const edges = ring.slice(1).map((id) => subtract(this.positions[id]!, origin));
    const first = edges.find((edge) => edge.some((x) => x !== 0));
    return first !== undefined && edges.some((edge) => cross(first, edge).some((x) => x !== 0));
  }

  centre(nodes: readonly number[]): number {
    const ids = [...new Set(nodes)].sort(vertexOrder);
    return this.blend(
      ids,
      ids.map(() => 1 / ids.length),
    );
  }

  triangles(ring: number[], fanFromCentre: boolean): Triangle[] {
    if (!fanFromCentre) {
      const start = ring.indexOf(Math.min(...ring));
      const triangles: Triangle[] = [];
      for (let i = 1; i < ring.length - 1; i++)
        triangles.push([ring[start]!, ring[(start + i) % ring.length]!, ring[(start + i + 1) % ring.length]!]);
      return triangles;
    }
    const key = faceKey(ring);
    let centre = this.centres.get(key);
    if (centre === undefined) {
      centre = this.centre(ring);
      this.centres.set(key, centre);
    }
    return ring.map((id, i) => [centre!, id, ring[(i + 1) % ring.length]!]);
  }
}

/** Plan finite cut geometry, keeping all tetrahedron faces conforming across an incision. */
export function planTriangleCut(
  current: Float32Array,
  cells: Uint32Array,
  blade: readonly [Vec3, Vec3, Vec3],
): SlicePlan | null {
  const normal = cross(subtract(blade[1], blade[0]), subtract(blade[2], blade[0]));
  const scale = Math.max(...normal.map(Math.abs));
  if (!(scale > 0 && Number.isFinite(scale)))
    throw new RangeError(
      'The blade triangle has no representable area. Supply three noncollinear world-space corners.',
    );
  const n = vector((i) => normal[i] / scale);
  const planes = [
    { origin: blade[0], normal: n },
    ...AXES.map((i) => ({
      origin: blade[i],
      normal: cross(n, subtract(blade[(i + 1) % 3]!, blade[i])),
    })),
  ];
  return planIncision(current, cells, planes);
}

/** Release the entire section through the nominated material tetrahedron. */
export function planNucleatedCut(
  current: Float32Array,
  cells: Uint32Array,
  cell: number,
  normal: Vec3,
  front?: readonly [number, number],
): SlicePlan | null {
  const tetrahedron = (id: number): Tet => [cells[4 * id]!, cells[4 * id + 1]!, cells[4 * id + 2]!, cells[4 * id + 3]!];
  const seed = tetrahedron(cell);
  const through = front ?? [0, 1, 2, 3];
  const origin = vector((axis) => {
    let sum = 0;
    for (const k of through) sum += current[seed[k]! * 3 + axis]!;
    return sum / through.length;
  });
  const geometry = new IncisionGeometry(current, [{ origin, normal }]);
  const distances = cutDistances(current, origin, normal);
  const releasedFront = front && ([seed[front[0]]!, seed[front[1]]!] as const);
  if (releasedFront) {
    for (const particle of releasedFront) distances[particle] = 0;
    geometry.splitCrackEdge(...releasedFront);
  }
  const halves = SIGNS.map((side) =>
    FACES.map((face) => faceIntersection(seed, face, side, distances, (a, b) => geometry.sectionEdge(a, b))),
  );
  const onPlane = (p: number): boolean => p >= distances.length || distances[p] === 0;
  const ring = sectionPolygon(halves[0]!, onPlane);
  if (!geometry.hasArea(ring)) return null;
  const cap = geometry.triangles(geometry.refineEdges(ring), true);
  const severed = new Set(cap.map(faceKey));
  const halvesTriangles = halves.map((faces) =>
    faces.map((face) => {
      if (face.length < 3) return [];
      const refined = geometry.refineEdges(face);
      return geometry.triangles(refined, refined.length !== face.length);
    }),
  );
  // A neighboring tetrahedron only needs the face split or individual edge nodes created by the seed.
  // Its other faces keep their old topology, so this repair does not propagate down the cutting plane.
  const shared = new Map(
    FACES.map((face, i) => [
      faceKey(face.map((slot) => seed[slot])),
      { triangles: halvesTriangles.flatMap((side) => side[i]!), face: i, joined: false },
    ]),
  );
  const children: SliceCell[] = [];
  for (let parent = 0; parent < cells.length / 4; parent++) {
    const tet = tetrahedron(parent);
    if (parent === cell) {
      for (const half of halvesTriangles) addCones(children, geometry, parent, tet, [...half.flat(), ...cap]);
      continue;
    }
    const faces = FACES.map((face) => face.map((slot) => tet[slot]));
    const triangles = faces.flatMap((face) => {
      const existing = shared.get(faceKey(face));
      if (existing) {
        existing.joined = true;
        return existing.triangles;
      }
      const refined = geometry.refineEdges(face);
      return geometry.triangles(refined, refined.length !== 3);
    });
    if (triangles.length === 4) children.push({ parent, nodes: tet, inverse: null, fraction: 1 });
    else addCones(children, geometry, parent, tet, triangles);
  }
  const crackFront = new Map<SlicePoint, Set<SlicePoint>>();
  for (const { face, joined } of shared.values()) {
    if (!joined || halves.some((half) => !geometry.hasArea(half[face]!))) continue;
    const section = halves[0]![face]!.filter(onPlane);
    if (section.length !== 2) continue;
    const a = geometry.points[section[0]!]!;
    const b = geometry.points[section[1]!]!;
    const following = crackFront.get(a) ?? new Set<SlicePoint>();
    following.add(b);
    crackFront.set(a, following);
  }
  return {
    points: geometry.points,
    pieces: incisionPieces(children, geometry.points, severed),
    crackFront,
    releasedFront,
  };
}

function addCones(
  result: SliceCell[],
  geometry: IncisionGeometry,
  parent: number,
  tet: Tet,
  triangles: Triangle[],
): void {
  const centre = geometry.centre(triangles.flat());
  for (const face of triangles) result.push(childCell(parent, tet, [centre, ...face], geometry.points));
}

function planIncision(current: Float32Array, cells: Uint32Array, planes: readonly Plane[]): SlicePlan | null {
  const g = new IncisionGeometry(current, planes);
  const { origin, normal } = planes[0]!;
  const d = cutDistances(current, origin, normal);
  const sections = new Map<string, Section>();
  const section = (ring: number[], negative: boolean, positive: boolean): Section => {
    const key = faceKey(ring);
    const had = sections.get(key);
    if (had) {
      had.negative ||= negative;
      had.positive ||= positive;
      return had;
    }
    const fresh = { ring, negative, positive, refined: false, triangles: [] };
    sections.set(key, fresh);
    return fresh;
  };
  const parents: Parent[] = [];
  for (let i = 0; i < cells.length; i += 4) {
    const tet: Tet = [cells[i]!, cells[i + 1]!, cells[i + 2]!, cells[i + 3]!];
    const negative = tet.some((id) => d[id]! < 0);
    const positive = tet.some((id) => d[id]! > 0);
    if (negative && positive) {
      const faces = SIGNS.map((side) =>
        FACES.map((face) => faceIntersection(tet, face, side, d, (a, b) => g.intersection(0, a, b))),
      );
      const cap = section(
        sectionPolygon(faces[0]!, (id) => id >= d.length || d[id] === 0),
        true,
        true,
      );
      parents.push({ tet, parts: faces.map((part) => ({ faces: part.filter((f) => f.length >= 3), section: cap })) });
      continue;
    }
    const faces = FACES.map((face) => face.map((j) => tet[j]));
    const cap = faces.find((face) => face.every((id) => d[id] === 0));
    parents.push({
      tet,
      parts: [
        {
          faces: cap ? faces.filter((face) => face !== cap) : faces,
          section: cap ? section(cap, negative, positive) : null,
        },
      ],
    });
  }

  const openSections = new Set<Section>();
  for (const cap of sections.values()) {
    if (!cap.negative || !cap.positive) continue;
    let inside = cap.ring;
    for (const plane of g.edgePlanes) {
      if (inside.length === 0) break;
      inside = g.splitRing(inside, plane).find((part) => part.inside)?.ring ?? [];
    }
    if (g.hasArea(inside)) openSections.add(cap);
  }
  if (openSections.size === 0) return null;
  for (const { ring } of openSections) ring.forEach((id, i) => g.capEdge(id, ring[(i + 1) % ring.length]!));
  const severed = new Set<string>();
  for (const cap of sections.values()) {
    const ring = g.refineEdges(cap.ring);
    if (!openSections.has(cap)) {
      cap.refined = ring.length !== cap.ring.length;
      if (cap.refined) cap.triangles = g.triangles(ring, true);
      continue;
    }
    cap.refined = true;
    let sectors = [{ ring, covered: true }];
    for (const plane of g.edgePlanes) {
      sectors = sectors.flatMap(({ ring, covered }) =>
        g.splitRing(ring, plane).map((part) => ({ ring: part.ring, covered: covered && part.inside })),
      );
    }
    for (const { ring, covered } of sectors) {
      const open = covered && cap.negative && cap.positive;
      const triangles = g.triangles(ring, true);
      cap.triangles.push(...triangles);
      if (open) for (const triangle of triangles) severed.add(faceKey(triangle));
    }
  }
  if (severed.size === 0) return null;
  const children: SliceCell[] = [];
  parents.forEach(({ tet, parts }, parent) => {
    for (const part of parts) {
      const faces = part.faces.map((face) => g.refineEdges(face));
      if (!part.section?.refined && faces.every((f, i) => f.length === part.faces[i]!.length)) {
        if (part.section) children.push(...pullCells(parent, tet, [...faces, part.section.ring], g.points));
        else children.push({ parent, nodes: tet, inverse: null, fraction: 1 });
        continue;
      }
      const triangles = faces.flatMap((face, i) => g.triangles(face, face.length !== part.faces[i]!.length));
      if (part.section)
        triangles.push(...(part.section.refined ? part.section.triangles : g.triangles(part.section.ring, false)));
      addCones(children, g, parent, tet, triangles);
    }
  });
  return { points: g.points, pieces: incisionPieces(children, g.points, severed) };
}
