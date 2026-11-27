// @margoengine/loaders/threemf-beams: the surface of a 3MF beam lattice (beam lattice extension,
// https://github.com/3MFConsortium/spec_beamlattice, chapter 2) as triangles and as a signed distance. A beam is a
// conical frustum whose two radii change linearly along its axis, joined at each end with that end's cap: a flat
// `butt`, a `sphere` of the end radius, or the `hemisphere` of it outside the end. A ball is a sphere. Each is a solid
// of revolution, so it is described once by its profile (radius against height along the axis), the upper envelope of
// the frustum's side and the caps' circles: turned about the axis it gives the closed triangle shell, and the distance
// to it in the plane through a point and the axis is the point's distance to the solid. The union of overlapping
// closed shells is the solid under the 3MF positive fill rule. The tree of boxes the distance walks is the median
// split of Wald, Boulos and Shirley, "Ray tracing deformable scenes using dynamic bounding volume hierarchies", ACM
// Transactions on Graphics 26(1), 2007 (https://www.sci.utah.edu/~wald/Publications/2007/BVH/download/togbvh.pdf).
import type { ThreeMFBall, ThreeMFBeam } from './threemf-lattice.js';
import { LoaderError } from './types.js';

const F = '3MF';

/** The parts of a `ThreeMFBeamLattice` that make its surface, as `parse3MFLattice` gives them. */
export interface ThreeMFBeamGeometry {
  beams: readonly ThreeMFBeam[];
  /** Indices of the beams to make: those no shorter than `minlength`. Every beam when absent. */
  activeBeams?: ArrayLike<number>;
  /** The balls to make, after the ball mode. */
  effectiveBalls?: readonly ThreeMFBall[];
}

/** Options of {@link mesh3MFBeamLattice}. */
export interface ThreeMFBeamMeshOptions {
  /** Triangles' sides around an axis and around a full circle of a cap: 3 to 256, default 16. */
  segments?: number;
  /** The most triangles to make. Default 4,000,000. */
  maxTriangles?: number;
}

/** The triangles one beam or ball made. */
export interface ThreeMFBeamPart {
  kind: 'beam' | 'ball';
  /** The index in `beams`, or in `effectiveBalls`. */
  index: number;
  triangleStart: number;
  triangleCount: number;
}

/** A lattice's surface: one closed, outward shell for each beam and ball, which may overlap. */
export interface ThreeMFBeamMesh {
  /** In the vertices' own coordinates. */
  positions: Float32Array;
  indices: Uint32Array;
  /** For each vertex, where its nearest point of the axis lies from the beam's `v1` (0) to its `v2` (1). */
  along: Float32Array;
  parts: ThreeMFBeamPart[];
}

type Point = [number, number, number];

/** A piece of a profile: a straight segment, or the arc of a circle about the axis at height `c`. */
interface Piece {
  z0: number;
  r0: number;
  z1: number;
  r1: number;
  c?: number;
  radius?: number;
}

/** One frustum or cap, as the radius it reaches at each height of its span. */
interface Source {
  from: number;
  to: number;
  at(z: number): number;
  c?: number;
  radius?: number;
}

/** A solid of revolution about the axis from `origin` along the unit vector `axis`. */
interface Solid {
  origin: Point;
  axis: Point;
  /** The beam's length, 0 for a ball. */
  length: number;
  /** From its lowest height to its highest, flat ends and steps included, as segments and arcs. */
  profile: Piece[];
  low: Point;
  high: Point;
}

const arc = (c: number, radius: number, from: number, to: number): Source => ({
  from,
  to,
  c,
  radius,
  at: (z) => Math.sqrt(Math.max(0, radius * radius - (z - c) * (z - c))),
});

/** The upper envelope of the sources over their spans, which touch or overlap, closed to the axis at both ends. */
function envelope(sources: readonly Source[], frustum: { slope: number; r0: number } | undefined): Piece[] {
  const low = Math.min(...sources.map((s) => s.from)),
    high = Math.max(...sources.map((s) => s.to)),
    size = Math.max(high - low, ...sources.map((s) => Math.max(s.at(s.from), s.at(s.to), s.radius ?? 0))),
    tiny = size * 1e-9,
    heights = sources.flatMap((s) => [s.from, s.to]),
    arcs = sources.filter((s) => s.radius !== undefined);
  // Where two curves cross, the envelope changes from one to the other.
  for (const [i, a] of arcs.entries()) {
    if (frustum) {
      const { slope: k, r0 } = frustum,
        c = a.c!,
        qa = 1 + k * k,
        qb = 2 * (r0 * k - c),
        qc = r0 * r0 + c * c - a.radius! * a.radius!,
        d = qb * qb - 4 * qa * qc;
      if (d >= 0) heights.push((-qb - Math.sqrt(d)) / (2 * qa), (-qb + Math.sqrt(d)) / (2 * qa));
    }
    for (const b of arcs.slice(i + 1))
      if (a.c !== b.c)
        heights.push((a.c! * a.c! - b.c! * b.c! - a.radius! ** 2 + b.radius! ** 2) / (2 * (a.c! - b.c!)));
  }
  const cuts = heights
    .filter((z) => z >= low && z <= high)
    .sort((a, b) => a - b)
    .filter((z, i, all) => !i || z - all[i - 1] > tiny);
  if (high - cuts[cuts.length - 1] > 0) cuts[cuts.length - 1] = high;
  const pieces: Piece[] = [];
  let previous: Source | undefined,
    end = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const z0 = cuts[i],
      z1 = cuts[i + 1],
      middle = (z0 + z1) / 2;
    let top: Source | undefined;
    for (const s of sources) if (s.from <= middle && s.to >= middle && (!top || s.at(middle) > top.at(middle))) top = s;
    if (!top) continue;
    const r0 = top.at(z0),
      r1 = top.at(z1),
      last = pieces[pieces.length - 1];
    // A step of the radius at a height is a flat ring.
    if (Math.abs(r0 - end) > tiny) pieces.push({ z0, r0: end, z1: z0, r1: r0 });
    if (top === previous && last.z1 === z0 && Math.abs(r0 - end) <= tiny) {
      last.z1 = z1;
      last.r1 = r1;
    } else pieces.push({ z0, r0, z1, r1, ...(top.radius === undefined ? {} : { c: top.c, radius: top.radius }) });
    previous = top;
    end = r1;
  }
  if (end > tiny) pieces.push({ z0: high, r0: end, z1: high, r1: 0 });
  return pieces;
}

function solid(
  origin: Point,
  axis: Point,
  length: number,
  sources: Source[],
  frustum?: Parameters<typeof envelope>[1],
) {
  const profile = envelope(sources, frustum),
    low = [Infinity, Infinity, Infinity] as Point,
    high = [-Infinity, -Infinity, -Infinity] as Point;
  let from = Infinity,
    to = -Infinity,
    reach = 0;
  for (const s of sources) {
    from = Math.min(from, s.from);
    to = Math.max(to, s.to);
    reach = Math.max(reach, s.radius ?? Math.max(s.at(s.from), s.at(s.to)));
  }
  for (let k = 0; k < 3; k++)
    for (const z of [from, to]) {
      low[k] = Math.min(low[k], origin[k] + axis[k] * z - reach);
      high[k] = Math.max(high[k], origin[k] + axis[k] * z + reach);
    }
  return { origin, axis, length, profile, low, high } satisfies Solid;
}

const point = (vertices: ArrayLike<number>, v: number): Point => {
  if (!(Number.isInteger(v) && v >= 0 && v * 3 + 2 < vertices.length))
    throw new LoaderError(F, 'range', `lattice vertex ${v} is outside 0..${vertices.length / 3 - 1}`);
  return [vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]];
};

/** Every beam and ball of a lattice as a solid of revolution. */
function solidsOf(vertices: ArrayLike<number>, lattice: ThreeMFBeamGeometry) {
  const parts: { kind: 'beam' | 'ball'; index: number; solid: Solid }[] = [];
  const active = lattice.activeBeams ?? lattice.beams.map((_, i) => i);
  for (let n = 0; n < active.length; n++) {
    const at = active[n],
      beam = lattice.beams[at],
      a = point(vertices, beam.v1),
      b = point(vertices, beam.v2),
      d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      length = Math.hypot(d[0], d[1], d[2]),
      { r1, r2, cap1, cap2 } = beam;
    if (!(length > 0 && r1 > 0 && r2 > 0))
      throw new LoaderError(F, 'range', `beam ${at} needs two distinct ends and positive radii`);
    const slope = (r2 - r1) / length,
      sources: Source[] = [{ from: 0, to: length, at: (z) => r1 + slope * z }];
    if (cap1 !== 'butt') sources.push(arc(0, r1, -r1, cap1 === 'sphere' ? r1 : 0));
    if (cap2 !== 'butt') sources.push(arc(length, r2, cap2 === 'sphere' ? length - r2 : length, length + r2));
    parts.push({
      kind: 'beam',
      index: at,
      solid: solid(a, d.map((v) => v / length) as Point, length, sources, { slope, r0: r1 }),
    });
  }
  for (const [at, ball] of (lattice.effectiveBalls ?? []).entries()) {
    if (!(ball.radius > 0)) throw new LoaderError(F, 'range', `ball ${at} needs a positive radius`);
    parts.push({
      kind: 'ball',
      index: at,
      solid: solid(point(vertices, ball.vertex), [0, 0, 1], 0, [arc(0, ball.radius, -ball.radius, ball.radius)]),
    });
  }
  return parts;
}

/**
 * The surface of a lattice in the vertices' coordinates: one closed, outward triangle shell for each active beam, in
 * their order, then one for each effective ball. The shells overlap where the lattice joins, which the 3MF positive
 * fill rule reads as their union; `batchBooleanMeshes` of `@margoengine/mesh-edit` unions them where one surface is
 * needed. A clipping mesh is not applied here (`parse3MFEvaluated` applies it).
 *
 * @throws LoaderError for a vertex index outside the vertices, a beam without length or radius, a bad option, or more
 * triangles than `maxTriangles`.
 */
export function mesh3MFBeamLattice(
  vertices: ArrayLike<number>,
  lattice: ThreeMFBeamGeometry,
  options: ThreeMFBeamMeshOptions = {},
): ThreeMFBeamMesh {
  const { segments = 16, maxTriangles = 4_000_000 } = options;
  if (!(Number.isInteger(segments) && segments >= 3 && segments <= 256))
    throw new LoaderError(F, 'range', 'segments must be an integer from 3 to 256');
  if (!(Number.isSafeInteger(maxTriangles) && maxTriangles > 0))
    throw new LoaderError(F, 'range', 'maxTriangles must be a positive integer');
  const turn = Array.from({ length: segments }, (_, j) => {
      const angle = (2 * Math.PI * j) / segments;
      return [Math.cos(angle), Math.sin(angle)];
    }),
    positions: number[] = [],
    along: number[] = [],
    indices: number[] = [],
    parts: ThreeMFBeamPart[] = [];
  for (const part of solidsOf(vertices, lattice)) {
    const { origin, axis, length, profile } = part.solid,
      // A unit vector across the axis, from the world axis it leans on least.
      least = [0, 1, 2].reduce((m, k) => (Math.abs(axis[k]) < Math.abs(axis[m]) ? k : m), 0),
      e = [0, 0, 0];
    e[least] = 1;
    const dot = axis[least],
      e1 = e.map((v, k) => v - dot * axis[k]),
      size = Math.hypot(e1[0], e1[1], e1[2]);
    for (let k = 0; k < 3; k++) e1[k] /= size;
    const e2 = [
      axis[1] * e1[2] - axis[2] * e1[1],
      axis[2] * e1[0] - axis[0] * e1[2],
      axis[0] * e1[1] - axis[1] * e1[0],
    ];
    // The profile as points of height and radius.
    const widest = Math.max(...profile.map((p) => p.radius ?? Math.max(p.r0, p.r1))),
      tiny = widest * 1e-6,
      line: [number, number][] = [];
    const add = (z: number, r: number): void => {
      const radius = r > tiny ? r : 0,
        last = line[line.length - 1];
      if (last && Math.abs(last[0] - z) <= tiny && Math.abs(last[1] - radius) <= tiny) return;
      line.push([z, radius]);
    };
    add(profile[0].z0, 0);
    for (const { z0, r0, z1, r1, c, radius } of profile) {
      add(z0, r0);
      if (radius !== undefined) {
        const angle = (z: number, r: number) => Math.atan2(r, z - c!),
          from = angle(z0, r0),
          to = angle(z1, r1),
          steps = Math.max(1, Math.ceil((Math.abs(from - to) / (2 * Math.PI)) * segments - 1e-6));
        for (let i = 1; i < steps; i++) {
          const t = from + ((to - from) * i) / steps;
          add(c! + radius * Math.cos(t), radius * Math.sin(t));
        }
      }
      add(z1, r1);
    }
    add(profile[profile.length - 1].z1, 0);
    const triangleStart = indices.length / 3,
      rings: number[][] = [];
    for (const [z, r] of line) {
      const ring: number[] = [];
      for (let j = 0; j < (r ? segments : 1); j++) {
        ring.push(positions.length / 3);
        for (let k = 0; k < 3; k++)
          positions.push(origin[k] + axis[k] * z + r * (turn[j][0] * e1[k] + turn[j][1] * e2[k]));
        along.push(length ? Math.min(1, Math.max(0, z / length)) : 0);
      }
      rings.push(ring);
    }
    for (let i = 0; i + 1 < rings.length; i++) {
      const a = rings[i],
        b = rings[i + 1];
      if (a.length === 1 && b.length === 1) continue;
      for (let j = 0; j < segments; j++) {
        const k = (j + 1) % segments;
        if (a.length > 1) indices.push(a[j], a[k], b[b.length > 1 ? k : 0]);
        if (b.length > 1) indices.push(a[a.length > 1 ? j : 0], b[k], b[j]);
      }
      if (indices.length / 3 > maxTriangles)
        throw new LoaderError(F, 'limit', `the beam lattice exceeds ${maxTriangles} triangles; lower segments`);
    }
    parts.push({
      kind: part.kind,
      index: part.index,
      triangleStart,
      triangleCount: indices.length / 3 - triangleStart,
    });
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    along: Float32Array.from(along),
    parts,
  };
}

/** The signed distance from a point to one solid of revolution, negative inside. */
function distanceTo({ origin, axis, profile }: Solid, x: number, y: number, z: number): number {
  const dx = x - origin[0],
    dy = y - origin[1],
    dz = z - origin[2],
    h = dx * axis[0] + dy * axis[1] + dz * axis[2],
    r = Math.hypot(dx - h * axis[0], dy - h * axis[1], dz - h * axis[2]);
  let best = Infinity,
    top = -1;
  for (const { z0, r0, z1, r1, c, radius } of profile) {
    if (radius === undefined) {
      const ez = z1 - z0,
        er = r1 - r0,
        t = Math.min(1, Math.max(0, ((h - z0) * ez + (r - r0) * er) / (ez * ez + er * er || 1)));
      best = Math.min(best, Math.hypot(h - z0 - t * ez, r - r0 - t * er));
      if (h >= z0 && h <= z1 && ez > 0) top = Math.max(top, r0 + (er * (h - z0)) / ez);
    } else {
      const away = Math.hypot(h - c!, r),
        // The nearest point of the circle, when it lies on this arc.
        on = away > 0 ? c! + ((h - c!) * radius) / away : c!;
      if (on >= z0 && on <= z1) best = Math.min(best, Math.abs(away - radius));
      else best = Math.min(best, Math.hypot(h - z0, r - r0), Math.hypot(h - z1, r - r1));
      if (h >= z0 && h <= z1) top = Math.max(top, Math.sqrt(Math.max(0, radius * radius - (h - c!) ** 2)));
    }
  }
  return r <= top ? -best : best;
}

interface Node {
  low: Point;
  high: Point;
  solid?: Solid;
  left?: Node;
  right?: Node;
}

function tree(solids: Solid[]): Node {
  const low = [0, 1, 2].map((k) => solids.reduce((m, s) => Math.min(m, s.low[k]), Infinity)) as Point,
    high = [0, 1, 2].map((k) => solids.reduce((m, s) => Math.max(m, s.high[k]), -Infinity)) as Point;
  if (solids.length === 1) return { low, high, solid: solids[0] };
  const k = [0, 1, 2].reduce((m, i) => (high[i] - low[i] > high[m] - low[m] ? i : m), 0),
    sorted = [...solids].sort((a, b) => a.low[k] + a.high[k] - b.low[k] - b.high[k]),
    half = sorted.length >> 1;
  return { low, high, left: tree(sorted.slice(0, half)), right: tree(sorted.slice(half)) };
}

/**
 * The signed distance to a lattice's beams and balls, negative inside. It is exact outside the lattice and its sign is
 * exact everywhere; inside, where beams overlap, it is the distance to the surface of the beam or ball the point lies
 * deepest in, which is never more than the distance to the lattice's surface. Infinite for a lattice with nothing in
 * it. A clipping mesh is not applied here.
 *
 * @throws LoaderError for a vertex index outside the vertices or a beam without length or radius.
 */
export function threeMFBeamDistance(
  vertices: ArrayLike<number>,
  lattice: ThreeMFBeamGeometry,
): (x: number, y: number, z: number) => number {
  const solids = solidsOf(vertices, lattice).map((p) => p.solid);
  if (!solids.length) return () => Infinity;
  const root = tree(solids);
  const away = ({ low, high }: Node, x: number, y: number, z: number): number =>
    Math.hypot(
      Math.max(low[0] - x, 0, x - high[0]),
      Math.max(low[1] - y, 0, y - high[1]),
      Math.max(low[2] - z, 0, z - high[2]),
    );
  return (x, y, z) => {
    let best = Infinity;
    const visit = (node: Node, near: number): void => {
      // A solid is no nearer than its box; one whose box holds the point may be deeper than the best so far.
      if (near > 0 && near >= best) return;
      if (node.solid) {
        best = Math.min(best, distanceTo(node.solid, x, y, z));
        return;
      }
      const a = away(node.left!, x, y, z),
        b = away(node.right!, x, y, z);
      if (a <= b) {
        visit(node.left!, a);
        visit(node.right!, b);
      } else {
        visit(node.right!, b);
        visit(node.left!, a);
      }
    };
    visit(root, away(root, x, y, z));
    return best;
  };
}
