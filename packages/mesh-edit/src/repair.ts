import type { MutableVec2, MutableVec3, Vec2, Vec3 } from '@margoengine/math';
import { assertSolid } from './boolean.js';
import { assertOptions } from './edit-support.js';
import { fillMeshHoles } from './holes.js';
import { assertPolygonMesh, collectPolygonEdges, polygonAreaVector } from './polygon.js';
import { loopFaces } from './polygon-split.js';
import { faceIdFactory } from './result.js';
import type { MeshEditOptions, PolygonFace, PolygonMesh } from './types.js';

/** Polygon soup accepted before geometric/topological repair. UVs may be missing or malformed. */
export interface MeshRepairInput {
  vertices: readonly Vec3[];
  faces: readonly { id: string; vertices: readonly number[]; uv?: readonly Vec2[] }[];
}

/** Conservative repair policy; removed components and unclosed borders are always reported. */
export interface MeshRepairOptions extends MeshEditOptions {
  /** Non-chaining weld distance in local units. Default 0 (exact duplicate positions). */
  distance?: number;
  /** Fill remaining boundary loops with the existing hole filler. Default true. */
  fillHoles?: boolean;
  /** Maximum hole edge count to fill. Default 256. */
  maxHoleEdges?: number;
  /** Cooperative cancellation during faces, topology traversal and hole filling. */
  signal?: AbortSignal;
}

/** Owned repaired mesh plus explicit loss, orientation and source provenance. */
export interface MeshRepairResult {
  mesh: PolygonMesh;
  vertexMap: number[][];
  faceMap: Record<string, string[]>;
  removedFaces: string[];
  removedVertices: number[];
  flippedFaces: string[];
  filledFaces: string[];
  weldedVertices: number;
  splitVertices: number;
  /** Closed, consistently wound and positive volume; does not certify geometric self-intersection freedom. */
  readyForBoolean: boolean;
  diagnostics: string[];
}

const key = (a: number, b: number): string => `${Math.min(a, b)}:${Math.max(a, b)}`;
const reverse = (face: PolygonFace): void => {
  face.vertices.reverse();
  face.uv.reverse();
};
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const determinant = (a: number[], b: number[], c: number[]): number =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);

/** Six times signed volume in a component-relative unit frame, avoiding translation/scale overflow. */
function volume(mesh: PolygonMesh, faces: PolygonFace[]): number {
  if (!faces.length) return 0;
  const o = mesh.vertices[faces[0].vertices[0]];
  let extent = 0,
    sum = 0;
  for (const f of faces)
    for (const i of f.vertices)
      for (let k = 0; k < 3; k++) extent = Math.max(extent, Math.abs(mesh.vertices[i][k] - o[k]));
  if (!(extent > 0) || !Number.isFinite(extent)) return 0;
  const p = (i: number): number[] => mesh.vertices[i].map((x, k) => (x - o[k]) / extent);
  for (const f of faces)
    for (let i = 1; i + 1 < f.vertices.length; i++)
      sum += determinant(p(f.vertices[0]), p(f.vertices[i]), p(f.vertices[i + 1]));
  return sum;
}

/** Winding-number containment from normalized triangle solid angles (van Oosterom and Strackee, 1983). */
function encloses(mesh: PolygonMesh, faces: PolygonFace[], point: Vec3): boolean {
  let angle = 0;
  const unit = (i: number): number[] => {
    const d = mesh.vertices[i].map((x, k) => x - point[k]),
      length = Math.hypot(...d);
    return d.map((x) => x / length);
  };
  for (const f of faces)
    for (let i = 1; i + 1 < f.vertices.length; i++) {
      const a = unit(f.vertices[0]),
        b = unit(f.vertices[i]),
        c = unit(f.vertices[i + 1]);
      angle += 2 * Math.atan2(determinant(a, b, c), 1 + dot(a, b) + dot(b, c) + dot(c, a));
    }
  return Math.abs(angle) > 2 * Math.PI;
}

/** Repair winding, weld, remove invalid/degenerate/duplicate/non-manifold pieces and optionally close holes.
 * Faces are retained in descending area order when more than two compete for an edge; ties keep input order.
 * Nonorientable conflicts lose the later conflicting face. Disconnected vertex fans become separate vertices.
 * @throws TypeError for bad structure/options/IDs, RangeError for limits, or the abort signal's reason.
 */
export function repairMesh(input: MeshRepairInput, options: MeshRepairOptions = {}): MeshRepairResult {
  assertOptions(options, 'Mesh repair');
  const distance = options.distance ?? 0,
    maxHoleEdges = options.maxHoleEdges ?? 256;
  if (!Number.isFinite(distance) || distance < 0)
    throw new RangeError('Repair distance must be finite and nonnegative; choose a local weld distance.');
  if (!Number.isInteger(maxHoleEdges) || maxHoleEdges < 3)
    throw new RangeError('Repair maxHoleEdges must be an integer at least three; choose a hole limit.');
  if (options.fillHoles !== undefined && typeof options.fillHoles !== 'boolean')
    throw new TypeError('Repair fillHoles must be boolean; pass true or false.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError('Repair signal must be an AbortSignal; pass controller.signal.');
  const tick = () => options.signal?.throwIfAborted();
  tick();
  if (!input || !Array.isArray(input.vertices as unknown) || !Array.isArray(input.faces as unknown))
    throw new TypeError('Repair input needs vertex and face arrays; pass a polygon soup.');
  if (input.vertices.length > 200000 || input.faces.length > 200000)
    throw new RangeError('Repair input exceeds 200000 vertices or faces; partition the soup.');
  const vertices: MutableVec3[] = input.vertices.map((p) => {
      if (!Array.isArray(p) || p.length !== 3)
        throw new TypeError('Repair positions need three components; supply xyz points.');
      return [...p] as MutableVec3;
    }),
    finite = vertices.map((p) => p.every(Number.isFinite)),
    names = new Set<string>();
  for (const f of input.faces) {
    if (!f || typeof f.id !== 'string' || !f.id.length || names.has(f.id) || !Array.isArray(f.vertices))
      throw new TypeError('Repair faces need unique nonempty IDs and index arrays; fix the soup structure.');
    if (f.vertices.length > 4096) throw new RangeError('Repair face exceeds 4096 corners; partition the polygon.');
    names.add(f.id);
  }
  const createId = faceIdFactory(
      { vertices: [], faces: input.faces.map((f) => ({ id: f.id, vertices: [], uv: [] })) },
      options,
    ),
    representative = vertices.map((_, i) => i),
    buckets = new Map<string, number[]>(),
    kept: number[] = [];
  let weldedVertices = 0;
  for (let i = 0; i < vertices.length; i++) {
    tick();
    if (!finite[i]) continue;
    const p = vertices[i],
      cell = distance ? p.map((x) => Math.floor(x / distance)) : p,
      safe = !distance || cell.every(Number.isSafeInteger),
      candidates: number[] = safe ? [] : kept;
    if (safe) {
      const reach = distance ? 1 : 0;
      for (let x = -reach; x <= reach; x++)
        for (let y = -reach; y <= reach; y++)
          for (let z = -reach; z <= reach; z++)
            candidates.push(...(buckets.get([cell[0] + x, cell[1] + y, cell[2] + z].join(',')) ?? []));
    }
    let target = -1;
    for (const j of candidates)
      if (Math.hypot(...p.map((x, k) => x - vertices[j][k])) <= distance && (target < 0 || j < target)) target = j;
    if (target >= 0) {
      representative[i] = target;
      weldedVertices++;
    } else {
      kept.push(i);
      const k = cell.join(','),
        list = buckets.get(k) ?? [];
      list.push(i);
      buckets.set(k, list);
    }
  }
  const sourceOf = new Map<string, string>(),
    diagnostics: string[] = [],
    seen = new Set<string>();
  let faces: PolygonFace[] = [];
  const discard = (id: string, reason: string) => diagnostics.push(`${id}: ${reason}.`);
  for (const f of input.faces) {
    tick();
    if (f.vertices.some((i) => !Number.isInteger(i) || i < 0 || i >= vertices.length || !finite[i])) {
      discard(f.id, 'removed invalid vertex reference or nonfinite position');
      continue;
    }
    let resetUV = false;
    const loop: number[] = [],
      uv: MutableVec2[] = [];
    for (let c = 0; c < f.vertices.length; c++) {
      const i = representative[f.vertices[c]];
      if (loop.at(-1) === i) continue;
      const t = f.uv?.[c];
      loop.push(i);
      if (!Array.isArray(t) || t.length !== 2 || !t.every((x) => Number.isFinite(x) && x >= 0 && x <= 1))
        resetUV = true;
      uv.push(
        Array.isArray(t) && t.length === 2 && t.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)
          ? [t[0], t[1]]
          : [0, 0],
      );
    }
    if (loop.length > 1 && loop[0] === loop.at(-1)) {
      loop.pop();
      uv.pop();
    }
    if (resetUV) diagnostics.push(`${f.id}: missing or invalid corner UVs reset to [0, 0].`);
    if (loop.length < 3 || new Set(loop).size !== loop.length) {
      discard(f.id, 'removed collapsed or pinched face');
      continue;
    }
    const min = loop.indexOf(Math.min(...loop)),
      forward = loop.map((_, i) => loop[(min + i) % loop.length]).join(','),
      backward = loop.map((_, i) => loop[(min - i + loop.length) % loop.length]).join(','),
      canonical = forward < backward ? forward : backward;
    if (seen.has(canonical)) {
      discard(f.id, 'removed duplicate face');
      continue;
    }
    const pieces = loopFaces(vertices, loop, uv, f.id, createId);
    if (!pieces) {
      discard(f.id, 'removed degenerate or unresolved face');
      continue;
    }
    seen.add(canonical);
    for (const piece of pieces) {
      faces.push(piece);
      sourceOf.set(piece.id, f.id);
    }
  }
  // Select an edge-manifold subset before propagating orientation constraints.
  const edgeUses = new Map<string, number>();
  faces = faces
    .map((f, order) => ({ f, order, area: Math.hypot(...polygonAreaVector(f.vertices.map((i) => vertices[i]))) }))
    .sort((a, b) => b.area - a.area || a.order - b.order)
    .filter(({ f }) => {
      const edges = f.vertices.map((v, i) => key(v, f.vertices[(i + 1) % f.vertices.length]));
      if (edges.some((e) => edgeUses.get(e) === 2)) {
        discard(sourceOf.get(f.id)!, 'removed excess non-manifold face');
        return false;
      }
      for (const e of edges) edgeUses.set(e, (edgeUses.get(e) ?? 0) + 1);
      return true;
    })
    .sort((a, b) => a.order - b.order)
    .map(({ f }) => f);
  const mesh: PolygonMesh = { vertices, faces },
    flipped = new Set<string>();
  const flip = (f: PolygonFace) => {
    reverse(f);
    if (flipped.has(f.id)) flipped.delete(f.id);
    else flipped.add(f.id);
  };
  let components: PolygonFace[][] = [];
  for (;;) {
    tick();
    const byId = new Map(mesh.faces.map((f) => [f.id, f])),
      adjacency = new Map(mesh.faces.map((f) => [f.id, [] as { other: string; same: boolean }[]]));
    for (const edge of collectPolygonEdges(mesh))
      if (edge.incidences.length === 2) {
        const [a, b] = edge.incidences,
          same = a.from === b.from;
        adjacency.get(a.faceId)!.push({ other: b.faceId, same });
        adjacency.get(b.faceId)!.push({ other: a.faceId, same });
      }
    const parity = new Map<string, boolean>();
    let conflict: string | undefined;
    components = [];
    for (const f of mesh.faces)
      if (!parity.has(f.id)) {
        const group: PolygonFace[] = [],
          queue = [f.id];
        parity.set(f.id, false);
        for (let at = 0; at < queue.length && !conflict; at++) {
          tick();
          const id = queue[at];
          group.push(byId.get(id)!);
          for (const { other, same } of adjacency.get(id)!) {
            const wanted = parity.get(id)! !== same;
            if (!parity.has(other)) {
              parity.set(other, wanted);
              queue.push(other);
            } else if (parity.get(other) !== wanted) {
              conflict = other;
              break;
            }
          }
        }
        components.push(group);
        if (conflict) break;
      }
    if (conflict) {
      discard(sourceOf.get(conflict)!, 'removed nonorientable conflict face');
      mesh.faces = mesh.faces.filter((f) => f.id !== conflict);
      continue;
    }
    for (const f of mesh.faces) if (parity.get(f.id)) flip(f);
    break;
  }
  // Duplicate a vertex for each disconnected incident face fan, preserving all valid surface pieces.
  const original = vertices.map((_, i) => i),
    edges = collectPolygonEdges(mesh),
    incident = vertices.map(() => [] as PolygonFace[]),
    byFace = new Map(mesh.faces.map((f) => [f.id, f]));
  for (const f of mesh.faces) for (const v of f.vertices) incident[v].push(f);
  const fanLinks = vertices.map(() => new Map<string, string[]>());
  for (const e of edges)
    if (e.incidences.length === 2)
      for (const v of e.vertices) {
        const [a, b] = e.incidences;
        for (const [p, q] of [
          [a.faceId, b.faceId],
          [b.faceId, a.faceId],
        ]) {
          const list = fanLinks[v].get(p) ?? [];
          list.push(q);
          fanLinks[v].set(p, list);
        }
      }
  let splitVertices = 0;
  for (let v = 0; v < incident.length; v++) {
    tick();
    const left = new Map(incident[v].map((f) => [f.id, f]));
    let fan = 0;
    while (left.size) {
      const start = left.keys().next().value!,
        queue = [start],
        group: PolygonFace[] = [];
      left.delete(start);
      for (let at = 0; at < queue.length; at++) {
        const id = queue[at];
        group.push(byFace.get(id)!);
        for (const other of fanLinks[v].get(id) ?? []) if (left.delete(other)) queue.push(other);
      }
      if (fan++) {
        const index = vertices.length;
        vertices.push([...vertices[v]]);
        original.push(v);
        splitVertices++;
        for (const f of group) f.vertices = f.vertices.map((i) => (i === v ? index : i));
      }
    }
  }
  let filledFaces: string[] = [];
  // Remove discarded/nonfinite vertices before passing the sanitized mesh to the strict hole API.
  // Keep input identities separately so compaction and later fan duplication cannot corrupt provenance.
  const cleanVertices: MutableVec3[] = [],
    cleanOrigins: number[] = [],
    cleanIndex = new Map<number, number>();
  for (const f of mesh.faces)
    f.vertices = f.vertices.map((v) => {
      let at = cleanIndex.get(v);
      if (at === undefined) {
        at = cleanVertices.length;
        cleanIndex.set(v, at);
        cleanVertices.push([...mesh.vertices[v]]);
        cleanOrigins.push(original[v]);
      }
      return at;
    });
  mesh.vertices = cleanVertices;
  original.length = 0;
  for (const source of cleanOrigins) original.push(source);
  if (options.fillHoles !== false && mesh.faces.length) {
    const filled = fillMeshHoles(mesh, {
      maxEdges: maxHoleEdges,
      refine: false,
      fair: false,
      createId,
      signal: options.signal,
    });
    mesh.vertices = filled.mesh.vertices;
    mesh.faces = filled.mesh.faces;
    filledFaces = filled.createdFaces;
    diagnostics.push(...filled.diagnostics);
    // Filled faces connect within existing components; attach them by their boundary vertices.
    const membership = new Map<number, number>();
    components.forEach((group, i) => group.forEach((f) => f.vertices.forEach((v) => membership.set(v, i))));
    const groups = components.map(() => [] as PolygonFace[]);
    for (const f of mesh.faces) {
      const at = f.vertices.map((v) => membership.get(v)).find((i) => i !== undefined);
      if (at !== undefined) groups[at].push(f);
    }
    components = groups;
  }
  const closed = new Set(
    components.filter((group) => {
      const part = { vertices: mesh.vertices, faces: group };
      return group.length && collectPolygonEdges(part).every((e) => e.incidences.length === 2);
    }),
  );
  for (const group of closed) {
    tick();
    const p = mesh.vertices[group[0].vertices[0]];
    let depth = 0;
    for (const other of closed) if (other !== group && encloses(mesh, other, p)) depth++;
    if (volume(mesh, group) < 0 !== (depth % 2 === 1)) for (const f of group) flip(f);
  }
  const readyForBoolean =
    mesh.faces.length > 0 &&
    collectPolygonEdges(mesh).every((e) => e.incidences.length === 2 && e.incidences[0].from === e.incidences[1].to) &&
    volume(mesh, mesh.faces) > 0;
  if (!readyForBoolean)
    diagnostics.push(
      'Remaining open borders or zero volume prevent solid booleans; inspect removed pieces and hole limits.',
    );
  const faceMap = Object.fromEntries(input.faces.map((f) => [f.id, [] as string[]]));
  for (const f of mesh.faces) {
    const source = sourceOf.get(f.id);
    if (source) faceMap[source].push(f.id);
  }
  const out: PolygonMesh = { vertices: [], faces: [] },
    remap = new Map<number, number>();
  for (const f of mesh.faces)
    out.faces.push({
      ...f,
      uv: f.uv.map((p) => [...p]),
      vertices: f.vertices.map((v) => {
        let at = remap.get(v);
        if (at === undefined) {
          at = out.vertices.length;
          remap.set(v, at);
          out.vertices.push([...mesh.vertices[v]]);
        }
        return at;
      }),
    });
  const descendants = new Map<number, number[]>();
  for (const [v, at] of remap) {
    const root = original[v];
    if (root === undefined) continue;
    const list = descendants.get(root) ?? [];
    list.push(at);
    descendants.set(root, list);
  }
  const vertexMap = input.vertices.map((_, i) => [...(descendants.get(representative[i]) ?? [])]);
  assertPolygonMesh(out);
  if (readyForBoolean) assertSolid(out, 'repaired');
  tick();
  const outputIds = new Set(out.faces.map((f) => f.id));
  return {
    mesh: out,
    vertexMap,
    faceMap,
    removedFaces: input.faces.filter((f) => !faceMap[f.id].length).map((f) => f.id),
    removedVertices: vertexMap.flatMap((map, i) => (map.length && representative[i] === i ? [] : [i])),
    flippedFaces: [...flipped].filter((id) => outputIds.has(id)),
    filledFaces,
    weldedVertices,
    splitVertices,
    readyForBoolean,
    diagnostics,
  };
}
