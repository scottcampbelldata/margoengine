import type { MutableVec2 } from '@margoengine/math';
import { assertPolygonMesh, collectPolygonEdges } from './polygon.js';
import { clonePolygonMesh } from './result.js';
import type { PolygonMesh } from './types.js';

/** One corner of one face. Corners sharing a vertex still have separate UVs. */
export interface UVCorner {
  faceId: string;
  corner: number;
}
/** Faces joined across shared edges whose UVs match exactly at both ends. */
export interface UVIsland {
  id: string;
  faces: string[];
  corners: UVCorner[];
}
/** UV islands and, for each edge, whether it is a seam and why. Matching UVs on unconnected geometry never join. */
export interface UVTopology {
  islands: UVIsland[];
  edges: {
    edgeId: string;
    seam: boolean;
    reason: 'boundary' | 'nonmanifold' | 'winding' | 'uv' | null;
    corners: UVCorner[];
  }[];
}
/** Which UV corners to edit: all, listed corners, listed faces, or the islands containing listed faces. */
export type UVSelection =
  | { mode: 'all' }
  | { mode: 'corner'; corners: readonly UVCorner[] }
  | { mode: 'face' | 'island'; faces: readonly string[] };
/** A UV edit: scale, then rotate about the pivot, then translate. */
export interface UVTransform {
  translation?: readonly [number, number];
  scale?: readonly [number, number];
  /** Radians: (x, y) maps to (cos·x − sin·y, sin·x + cos·y). Exact quarter turns stay pixel aligned. */
  rotation?: number;
  /** Pivot point, or `'selection'` for the centre of the selected corners' bounds. */
  pivot?: readonly [number, number] | 'selection';
  /** Atlas width and height; when given, translation, pivot and snaps are in texels. */
  atlasDimensions?: readonly [number, number];
  /** Grid to snap the moved corners to. */
  snap?: readonly [number, number];
  /** Grid to snap the translation to, keeping the corners' spacing. */
  translationSnap?: readonly [number, number];
}
/** Result of a UV edit: the new mesh (only UVs differ), the edited corners and the faces that changed. */
export interface UVEditResult {
  mesh: PolygonMesh;
  corners: UVCorner[];
  affectedFaces: string[];
  changed: boolean;
}

/** Faces under a UV point, in mesh order, and corners near it, nearest first. */
export interface UVHitResult {
  faces: string[];
  corners: UVCorner[];
}

/** Faces and corners at a UV point. `radius` widens the test to an ellipse; [0, 0] means exact. */
export function meshUVHits(
  mesh: PolygonMesh,
  point: readonly [number, number],
  radius: readonly [number, number] = [0, 0],
): UVHitResult {
  assertPolygonMesh(mesh);
  const p = pair(point, [NaN, NaN], 'UV query'),
    r = pair(radius, [0, 0], 'UV hit radius');
  if (r.some((value) => value < 0) || (r[0] === 0) !== (r[1] === 0))
    throw new RangeError('UV hit radius needs two positive axes or two zeros; choose a pixel radius or exact picking.');
  if (p.some((value) => value < 0 || value > 1)) return { faces: [], corners: [] };
  const faces: string[] = [],
    corners: { ref: UVCorner; score: number; order: number }[] = [];
  let order = 0;
  for (const face of mesh.faces) {
    let inside = false,
      boundary = false;
    for (let i = 0; i < face.uv.length; i++) {
      const a = face.uv[i],
        b = face.uv[(i + 1) % face.uv.length],
        dx = p[0] - a[0],
        dy = p[1] - a[1];
      const score = r[0] > 0 ? (dx / r[0]) ** 2 + (dy / r[1]) ** 2 : dx === 0 && dy === 0 ? 0 : Infinity;
      if (score <= 1) corners.push({ ref: { faceId: face.id, corner: i }, score, order });
      order++;
      const ex = b[0] - a[0],
        ey = b[1] - a[1];
      if (
        dx * ey - dy * ex === 0 &&
        p[0] >= Math.min(a[0], b[0]) &&
        p[0] <= Math.max(a[0], b[0]) &&
        p[1] >= Math.min(a[1], b[1]) &&
        p[1] <= Math.max(a[1], b[1])
      )
        boundary = true;
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < a[0] + ((p[1] - a[1]) * ex) / ey) inside = !inside;
      if (r[0] > 0) {
        const x = dx / r[0],
          y = dy / r[1],
          u = ex / r[0],
          v = ey / r[1],
          length = u * u + v * v;
        const t = length === 0 ? 0 : Math.max(0, Math.min(1, (x * u + y * v) / length));
        if ((x - t * u) ** 2 + (y - t * v) ** 2 <= 1) boundary = true;
      }
    }
    if (inside || boundary) faces.push(face.id);
  }
  corners.sort((a, b) => a.score - b.score || a.order - b.order);
  return { faces, corners: corners.map((hit) => hit.ref) };
}

function selectionPivot(mesh: PolygonMesh, corners: UVCorner[], dimensions: MutableVec2): MutableVec2 {
  if (!corners.length) return [0, 0];
  const faces = new Map(mesh.faces.map((face) => [face.id, face])),
    low = [Infinity, Infinity],
    high = [-Infinity, -Infinity];
  for (const ref of corners)
    for (let axis = 0; axis < 2; axis++) {
      const value = faces.get(ref.faceId)!.uv[ref.corner][axis] * dimensions[axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  return [low[0] + (high[0] - low[0]) / 2, low[1] + (high[1] - low[1]) / 2];
}

/** UV islands and seams. Faces join only across a shared manifold edge whose UVs match exactly. */
export function meshUVTopology(mesh: PolygonMesh): UVTopology {
  assertPolygonMesh(mesh);
  return uvTopology(mesh);
}

function uvTopology(mesh: PolygonMesh): UVTopology {
  const faces = new Map(mesh.faces.map((face, index) => [face.id, { face, index }])),
    parent = mesh.faces.map((_, i) => i);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const edges: UVTopology['edges'] = collectPolygonEdges(mesh).map((edge) => {
    let reason: UVTopology['edges'][number]['reason'] =
      edge.incidences.length === 1 ? 'boundary' : edge.incidences.length !== 2 ? 'nonmanifold' : null;
    if (!reason) {
      const [a, b] = edge.incidences,
        fa = faces.get(a.faceId)!,
        fb = faces.get(b.faceId)!;
      if (a.from !== b.to || a.to !== b.from) reason = 'winding';
      else {
        const a0 = fa.face.uv[a.corner],
          a1 = fa.face.uv[(a.corner + 1) % fa.face.uv.length],
          b0 = fb.face.uv[b.corner],
          b1 = fb.face.uv[(b.corner + 1) % fb.face.uv.length];
        if (a0[0] !== b1[0] || a0[1] !== b1[1] || a1[0] !== b0[0] || a1[1] !== b0[1]) reason = 'uv';
        else {
          const x = root(fa.index),
            y = root(fb.index);
          parent[Math.max(x, y)] = Math.min(x, y);
        }
      }
    }
    return {
      edgeId: edge.id,
      seam: reason !== null,
      reason,
      corners: edge.incidences.map((i) => ({ faceId: i.faceId, corner: i.corner })),
    };
  });
  const groups = new Map<number, UVIsland>();
  mesh.faces.forEach((face, index) => {
    const key = root(index);
    let group = groups.get(key);
    if (!group) {
      group = { id: face.id, faces: [], corners: [] };
      groups.set(key, group);
    }
    group.faces.push(face.id);
    face.uv.forEach((_, corner) => group!.corners.push({ faceId: face.id, corner }));
  });
  return { islands: [...groups.values()], edges };
}

/** The selected UV corners, once each, in face and corner order. */
export function meshSelectionUVCorners(mesh: PolygonMesh, selection: UVSelection): UVCorner[] {
  assertPolygonMesh(mesh);
  if (!selection || typeof selection !== 'object')
    throw new TypeError('UV selection needs a supported mode; choose all, corner, face or island.');
  const selected = new Map<string, Set<number>>(),
    byId = new Map(mesh.faces.map((face) => [face.id, face]));
  const add = (id: string, corner: number) => {
    let corners = selected.get(id);
    if (!corners) {
      corners = new Set();
      selected.set(id, corners);
    }
    corners.add(corner);
  };
  if (selection.mode === 'all') mesh.faces.forEach((face) => face.uv.forEach((_, corner) => add(face.id, corner)));
  else if (selection.mode === 'corner') {
    if (!Array.isArray(selection.corners))
      throw new TypeError('UV corner selection needs an array; supply existing face/corner identities.');
    for (const ref of selection.corners) {
      const face = ref && typeof ref.faceId === 'string' ? byId.get(ref.faceId) : undefined;
      if (!face || !Number.isInteger(ref.corner) || ref.corner < 0 || ref.corner >= face.uv.length)
        throw new RangeError('UV corner identity does not exist; select existing face corners.');
      add(ref.faceId, ref.corner);
    }
  } else if (selection.mode === 'face' || selection.mode === 'island') {
    if (
      !Array.isArray(selection.faces) ||
      Array.from(selection.faces).some((id) => typeof id !== 'string' || !byId.has(id))
    )
      throw new TypeError('UV face selection contains a stale identity; select existing face IDs.');
    const ids = new Set(selection.faces);
    if (selection.mode === 'island')
      for (const island of uvTopology(mesh).islands)
        if (island.faces.some((id) => ids.has(id))) island.faces.forEach((id) => ids.add(id));
    for (const id of ids) byId.get(id)!.uv.forEach((_, corner) => add(id, corner));
  } else throw new TypeError('UV selection mode is unsupported; choose all, corner, face or island.');
  return mesh.faces.flatMap((face) =>
    face.uv.flatMap((_, corner) => (selected.get(face.id)?.has(corner) ? [{ faceId: face.id, corner }] : [])),
  );
}

const pair = (value: readonly [number, number] | undefined, fallback: MutableVec2, label: string): MutableVec2 => {
  const out = value === undefined ? fallback : value;
  if (!Array.isArray(out) || out.length !== 2 || !Array.from(out).every(Number.isFinite))
    throw new TypeError(`${label} needs two finite numbers; supply a supported UV transform.`);
  return [out[0], out[1]];
};

/** Transform the selected UV corners. All or nothing: an edit that leaves [0, 1] throws instead of clamping. */
export function transformMeshUVs(mesh: PolygonMesh, selection: UVSelection, transform: UVTransform = {}): UVEditResult {
  const corners = meshSelectionUVCorners(mesh, selection);
  if (!transform || typeof transform !== 'object' || Array.isArray(transform))
    throw new TypeError('UV transform needs an options object; supply translation, scale, rotation or snap.');
  const translation = pair(transform.translation, [0, 0], 'UV translation'),
    scale = pair(transform.scale, [1, 1], 'UV scale'),
    dimensions = pair(transform.atlasDimensions, [1, 1], 'Atlas dimensions'),
    rotation = transform.rotation === undefined ? 0 : transform.rotation,
    snap = transform.snap === undefined ? null : pair(transform.snap, [1, 1], 'UV snap'),
    translationSnap =
      transform.translationSnap === undefined ? null : pair(transform.translationSnap, [1, 1], 'UV translation snap');
  const pivot =
    transform.pivot === 'selection'
      ? selectionPivot(mesh, corners, dimensions)
      : pair(transform.pivot, [0, 0], 'UV pivot');
  if (scale.some((value) => value === 0)) throw new RangeError('UV scale must be nonzero; use finite nonzero scales.');
  if (
    dimensions.some((value) => value <= 0) ||
    (transform.atlasDimensions !== undefined && dimensions.some((value) => !Number.isInteger(value)))
  )
    throw new RangeError('Atlas dimensions need positive integers; supply the active texture width and height.');
  if (!Number.isFinite(rotation)) throw new TypeError('UV rotation must be finite; supply radians.');
  if (snap?.some((value) => value <= 0))
    throw new RangeError('UV snap steps must be positive; choose a positive grid or omit snap.');
  if (translationSnap?.some((value) => value <= 0))
    throw new RangeError('UV translation snap steps must be positive; choose a positive grid or omit translationSnap.');
  if (translationSnap) {
    for (let axis = 0; axis < 2; axis++)
      translation[axis] = Math.round(translation[axis] / translationSnap[axis]) * translationSnap[axis];
    if (translation.some((value) => !Number.isFinite(value)))
      throw new RangeError('Snapped UV translation must remain finite; reduce movement or choose a larger snap step.');
  }
  const output = clonePolygonMesh(mesh),
    byId = new Map(output.faces.map((face) => [face.id, face])),
    affected = new Set<string>();
  let c = Math.cos(rotation),
    s = Math.sin(rotation);
  if (Math.abs(rotation) <= Math.PI * 2 && Number.isInteger(rotation / (Math.PI / 2))) {
    const turn = (((rotation / (Math.PI / 2)) % 4) + 4) % 4;
    c = [1, 0, -1, 0][turn];
    s = [0, 1, 0, -1][turn];
  }
  const a = c * scale[0],
    b = -s * scale[1],
    d = s * scale[0],
    e = c * scale[1],
    unchanged = a === 1 && b === 0 && d === 0 && e === 1 && translation.every((value) => value === 0) && !snap,
    offsetU = (1 - a) * pivot[0] - b * pivot[1] + translation[0],
    offsetV = -d * pivot[0] + (1 - e) * pivot[1] + translation[1];
  if (!unchanged)
    for (const ref of corners) {
      const face = byId.get(ref.faceId)!,
        uv = face.uv[ref.corner],
        x = uv[0] * dimensions[0],
        y = uv[1] * dimensions[1];
      let u = a * x + b * y + offsetU,
        v = d * x + e * y + offsetV;
      if (snap) {
        u = Math.round(u / snap[0]) * snap[0];
        v = Math.round(v / snap[1]) * snap[1];
      }
      u = !snap && a === 1 && b === 0 && offsetU === 0 ? uv[0] : u / dimensions[0];
      v = !snap && d === 0 && e === 1 && offsetV === 0 ? uv[1] : v / dimensions[1];
      if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1)
        throw new RangeError('UV edit leaves the active atlas; reduce the transform or move its pivot.');
      if (u !== uv[0] || v !== uv[1]) {
        face.uv[ref.corner] = [u, v];
        affected.add(ref.faceId);
      }
    }
  return {
    mesh: output,
    corners,
    affectedFaces: mesh.faces.filter((face) => affected.has(face.id)).map((face) => face.id),
    changed: affected.size > 0,
  };
}
