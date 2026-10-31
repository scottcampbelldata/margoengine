import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { mergeFlatFaces } from './flat.js';
import { assertPolygonMesh, faceGeometryError } from './polygon.js';
import { loopFaces } from './polygon-split.js';
import type { PolygonFace, PolygonMesh } from './types.js';
import { type UnwrapOptions, unwrapMesh } from './unwrap.js';
import { weldMeshVertices } from './weld.js';

/**
 * Indexed triangles to import, as loaders and glTF give them: `positions` (x, y, z per vertex), optional triangle
 * `indices`, `uvs` (u, v per vertex, top-left origin as in glTF) and, for files with polygons such as OBJ,
 * `faceSizes` (corners per polygon, each fanned (c0, ck, ck+1) in order) and `positionIndices` (the shared position
 * of each vertex).
 */
export interface ImportTriangles {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  faceSizes?: ArrayLike<number>;
  positionIndices?: ArrayLike<number>;
}

/** Options for {@link polygonMeshFromTriangles}. */
export interface ImportMeshOptions {
  /** Weld positions at most this far apart (local units) when `positionIndices` is not given. Default 0: identical
   * positions only, which rejoins the vertices glTF splits at UV seams. */
  weld?: number;
  /** Merge coplanar neighbors back into polygons with {@link mergeFlatFaces} (default true). */
  mergeFlat?: boolean;
  /** `'auto'` (default) keeps the source UVs when there are some and all are within 0 to 1, and unwraps otherwise;
   * `'keep'` requires them; `'unwrap'` always makes new ones with {@link unwrapMesh}. */
  uv?: 'auto' | 'keep' | 'unwrap';
  /** Options for the unwrap, when there is one. */
  unwrap?: Omit<UnwrapOptions, 'signal'>;
  /** Checked between stages; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Result of {@link polygonMeshFromTriangles}. */
export interface ImportMeshResult {
  mesh: PolygonMesh;
  /** For each output face ID, the source polygons (or triangles) it covers, by index. */
  sourceFaces: Record<string, number[]>;
  /** Whether the UVs were made by {@link unwrapMesh}. */
  unwrapped: boolean;
  /** Dropped degenerate polygons, split concave ones, welds, merges and unwraps. */
  diagnostics: string[];
}

const integerArray = (values: ArrayLike<number>, limit: number, label: string) => {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isInteger(value) || value < 0 || value >= limit)
      throw new TypeError(`Import ${label} must be whole numbers from 0 to ${limit - 1}; repair the source data.`);
  }
};

/**
 * Turn imported triangles (a glTF primitive, an OBJ from `parseOBJ`, an STL) into an editable polygon mesh: OBJ
 * polygons are rebuilt from their fans, positions are rejoined (by `positionIndices`, or welded), degenerate
 * polygons are dropped, concave or nonplanar ones split into convex faces, coplanar neighbors with one UV map merged
 * back into polygons, and UVs kept or unwrapped. Face IDs are `f<index>` of the source polygon (later pieces count on
 * from the number of polygons), so they are stable across imports of the same file.
 * @throws TypeError for malformed arrays or options; RangeError for a bad weld distance, more than 200000 vertices
 * or faces, or UVs outside 0 to 1 with `uv: 'keep'`; the signal's reason when aborted.
 */
export function polygonMeshFromTriangles(source: ImportTriangles, options: ImportMeshOptions = {}): ImportMeshResult {
  assertOptions(options, 'Import');
  if (!source || typeof source !== 'object' || source.positions?.length === undefined)
    throw new TypeError('Import needs { positions } with x, y, z per vertex; pass the decoded vertex data.');
  const { positions, uvs, faceSizes, positionIndices } = source,
    count = positions.length / 3,
    signal = options.signal,
    uvMode = options.uv ?? 'auto',
    weld = options.weld ?? 0;
  if (!Number.isInteger(count))
    throw new TypeError('Import positions need three numbers per vertex; repair the source data.');
  for (let i = 0; i < positions.length; i++)
    if (!Number.isFinite(positions[i])) throw new TypeError('Import positions must be finite; repair the source data.');
  if (count > 200_000) throw new RangeError('Import has more than 200000 vertices; split the model into parts.');
  if (uvMode !== 'auto' && uvMode !== 'keep' && uvMode !== 'unwrap')
    throw new TypeError("Import uv must be 'auto', 'keep' or 'unwrap'; choose one or omit it.");
  if (typeof weld !== 'number' || !(weld >= 0) || !Number.isFinite(weld))
    throw new RangeError('Import weld must be a finite distance of zero or more; omit it to join identical positions.');
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError('Import signal must be an AbortSignal; pass controller.signal or omit it.');
  const indices = source.indices ?? Array.from({ length: count }, (_, i) => i);
  if (indices.length % 3)
    throw new TypeError('Import indices need three corners per triangle; repair the source data.');
  integerArray(indices, count, 'indices');
  if (uvs !== undefined) {
    if (uvs.length !== count * 2) throw new TypeError('Import uvs need two numbers per vertex; repair or omit them.');
    for (let i = 0; i < uvs.length; i++)
      if (!Number.isFinite(uvs[i])) throw new TypeError('Import uvs must be finite; repair or omit them.');
  }
  if (positionIndices !== undefined) {
    if (positionIndices.length !== count)
      throw new TypeError('Import positionIndices need one entry per vertex; repair or omit them.');
    integerArray(positionIndices, Number.MAX_SAFE_INTEGER, 'positionIndices');
  }
  const triangles = indices.length / 3,
    sizes: number[] = [];
  if (faceSizes !== undefined) {
    let total = 0;
    for (let i = 0; i < faceSizes.length; i++) {
      const n = faceSizes[i];
      if (!Number.isInteger(n) || n < 3)
        throw new TypeError('Import faceSizes must be whole numbers of 3 or more; repair them.');
      sizes.push(n);
      total += n - 2;
    }
    if (total !== triangles)
      throw new TypeError('Import faceSizes must fan into exactly the indexed triangles; repair them or omit them.');
  } else for (let t = 0; t < triangles; t++) sizes.push(3);
  if (sizes.length > 200_000) throw new RangeError('Import has more than 200000 faces; split the model into parts.');
  signal?.throwIfAborted();
  // UVs: kept when present and normalized, unless an unwrap is asked for.
  let inRange = uvs !== undefined;
  if (uvs) for (let i = 0; i < uvs.length && inRange; i++) inRange = uvs[i] >= 0 && uvs[i] <= 1;
  if (uvMode === 'keep' && !inRange)
    throw new RangeError(
      uvs
        ? "Import uvs outside 0 to 1 cannot be kept; pass uv: 'unwrap' for new ones."
        : "Import has no uvs to keep; pass uv: 'unwrap' or 'auto'.",
    );
  const unwrapping = uvMode === 'unwrap' || !inRange,
    diagnostics: string[] = [];
  // Vertices: one per shared position (OBJ), or one per source vertex to weld afterwards.
  const vertexOf = new Int32Array(count),
    vertices: MutableVec3[] = [];
  if (positionIndices) {
    const seen = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      let v = seen.get(positionIndices[i]);
      if (v === undefined) {
        v = vertices.length;
        seen.set(positionIndices[i], v);
        vertices.push([positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
      }
      vertexOf[i] = v;
    }
  } else
    for (let i = 0; i < count; i++) {
      vertexOf[i] = i;
      vertices.push([positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
    }
  let nextId = sizes.length;
  const used = new Set<string>(),
    createId = () => {
      while (used.has(`f${nextId}`)) nextId++;
      used.add(`f${nextId}`);
      return `f${nextId++}`;
    };
  for (let f = 0; f < sizes.length; f++) used.add(`f${f}`);
  const faces: PolygonFace[] = [],
    origin = new Map<string, number>();
  let dropped = 0,
    split = 0;
  for (let f = 0, t = 0; f < sizes.length; t += sizes[f] - 2, f++) {
    const corners = [indices[3 * t], indices[3 * t + 1]];
    for (let k = 0; k < sizes[f] - 2; k++) corners.push(indices[3 * (t + k) + 2]);
    // Repeated corners collapse; fewer than three distinct ones drop the polygon.
    const loop: number[] = [],
      loopUV: MutableVec2[] = [];
    for (const i of corners) {
      const v = vertexOf[i];
      if (loop.length && loop[loop.length - 1] === v) continue;
      loop.push(v);
      loopUV.push(unwrapping ? [0, 0] : [uvs![2 * i], uvs![2 * i + 1]]);
    }
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) {
      loop.pop();
      loopUV.pop();
    }
    if (loop.length < 3 || new Set(loop).size !== loop.length || loop.length > 64) {
      dropped++;
      continue;
    }
    if (!faceGeometryError(vertices, loop)) {
      faces.push({ id: `f${f}`, vertices: loop, uv: loopUV });
      origin.set(`f${f}`, f);
      continue;
    }
    const pieces = loopFaces(vertices, loop, loopUV, `f${f}`, createId);
    if (!pieces) {
      dropped++;
      continue;
    }
    split++;
    for (const piece of pieces) {
      faces.push(piece);
      origin.set(piece.id, f);
    }
  }
  if (dropped) diagnostics.push(`${dropped} degenerate polygons (no area, repeated or crossing corners) were dropped.`);
  if (split) diagnostics.push(`${split} concave or nonplanar polygons were split into convex faces.`);
  let mesh: PolygonMesh = { vertices, faces },
    sources = new Map([...origin].map(([id, f]) => [id, [f]]));
  assertPolygonMesh(mesh);
  const follow = (faceMap: Record<string, string[]>) => {
    const next = new Map<string, number[]>();
    for (const [id, list] of sources)
      for (const out of faceMap[id] ?? []) next.set(out, [...(next.get(out) ?? []), ...list]);
    sources = next;
  };
  signal?.throwIfAborted();
  if (!positionIndices) {
    const welded = weldMeshVertices(mesh, { distance: weld, createId });
    mesh = welded.mesh;
    follow(welded.faceMap);
    if (welded.welded) diagnostics.push(`${welded.welded} vertices were welded.`);
    diagnostics.push(...welded.diagnostics);
  } else {
    // Drop positions no polygon uses (degenerate ones only), keeping the rest in order.
    const keep = new Int32Array(vertices.length).fill(-1),
      compact: MutableVec3[] = [];
    for (const face of faces) for (const v of face.vertices) keep[v] = 0;
    keep.forEach((k, v) => {
      if (k === 0) {
        keep[v] = compact.length;
        compact.push(vertices[v]);
      }
    });
    mesh = {
      vertices: compact,
      faces: faces.map((face) => ({ ...face, vertices: face.vertices.map((v) => keep[v]) })),
    };
  }
  signal?.throwIfAborted();
  if (options.mergeFlat !== false) {
    const flat = mergeFlatFaces(mesh, { uv: unwrapping ? 'ignore' : 'match', signal });
    mesh = flat.mesh;
    follow(flat.faceMap);
    diagnostics.push(...flat.diagnostics);
  }
  if (unwrapping) {
    const unwrapped = unwrapMesh(mesh, { ...options.unwrap, signal });
    mesh = unwrapped.mesh;
    diagnostics.push(
      `UVs were unwrapped into ${unwrapped.charts.length} charts (${uvMode === 'unwrap' ? 'as asked' : uvs ? 'source UVs leave 0 to 1' : 'no source UVs'}).`,
      ...unwrapped.diagnostics,
    );
  }
  for (const list of sources.values()) list.sort((a, b) => a - b);
  return { mesh, sourceFaces: Object.fromEntries(sources), unwrapped: unwrapping, diagnostics };
}
