import type { MutableVec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { FaceSink } from './face-sink.js';
import { assertPolygonMesh, collectPolygonEdges } from './polygon.js';
import type { MeshEditResult, PolygonMesh } from './types.js';

/** Options for {@link smoothMesh}. */
export interface SmoothOptions {
  /** `'taubin'` keeps the volume (Taubin, 1995); `'laplacian'` pulls each vertex to its neighbors and shrinks. Default `'taubin'`. */
  method?: 'taubin' | 'laplacian';
  /** Passes, 1 to 10000. A Taubin pass is one shrink step and one grow step. Default 10. */
  iterations?: number;
  /** How far a vertex moves toward its neighbors' average per step, above 0 and at most 1. Default 0.5. */
  factor?: number;
  /** Taubin pass band: frequencies under it survive, so a larger value keeps less detail. Above 0, under 1. Default 0.1. */
  passBand?: number;
  /** Only these vertices move; the rest hold still and steer them. Default every vertex. */
  vertices?: readonly number[];
  /** Hold vertices on open edges still, so a surface keeps its outline. Default true. */
  pinBoundary?: boolean;
  /** Checked between passes; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Each vertex's edge neighbors, and whether it lies on an open edge. */
function neighbors(mesh: PolygonMesh): { rings: number[][]; boundary: boolean[] } {
  const rings: number[][] = mesh.vertices.map(() => []),
    boundary = mesh.vertices.map(() => false);
  for (const edge of collectPolygonEdges(mesh)) {
    const [a, b] = edge.vertices;
    rings[a].push(b);
    rings[b].push(a);
    if (edge.incidences.length === 1) {
      boundary[a] = true;
      boundary[b] = true;
    }
  }
  return { rings, boundary };
}

/**
 * Smooth a mesh or a selection. Each step moves a vertex toward the average of its edge neighbors. Laplacian steps
 * shrink the shape; Taubin smoothing follows each with a negative step that undoes the shrinking, so scans lose their
 * noise and keep their size. Corner UVs stay. A face the move warps is split into valid convex pieces (`id~t1`, ...).
 * @throws TypeError for a bad mesh or options; RangeError for an option outside its limits or a vertex that does not
 * exist; the signal's reason when aborted.
 */
export function smoothMesh(mesh: PolygonMesh, options: SmoothOptions = {}): MeshEditResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Smooth');
  const { method = 'taubin', iterations = 10, factor = 0.5, passBand = 0.1, pinBoundary = true, signal } = options;
  if (method !== 'taubin' && method !== 'laplacian')
    throw new TypeError("Smooth method must be 'taubin' or 'laplacian'; choose one.");
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000)
    throw new RangeError('Smooth iterations must be an integer from 1 to 10000; choose a pass count.');
  if (!(factor > 0 && factor <= 1))
    throw new RangeError('Smooth factor must be above 0 and at most 1; 0.5 is typical.');
  if (!(passBand > 0 && passBand < 1)) throw new RangeError('Smooth passBand must be between 0 and 1; 0.1 is typical.');
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError('Smooth signal must be an AbortSignal; pass controller.signal or omit it.');
  const { rings, boundary } = neighbors(mesh),
    free = new Uint8Array(mesh.vertices.length);
  if (options.vertices === undefined) free.fill(1);
  else {
    if (!Array.isArray(options.vertices))
      throw new TypeError('Smooth vertices need an array of indices; select vertices or omit it.');
    for (const v of options.vertices) {
      if (!Number.isInteger(v) || v < 0 || v >= free.length)
        throw new RangeError('Smooth vertex indices must exist in the mesh; select existing vertices.');
      free[v] = 1;
    }
  }
  const moving: number[] = [];
  for (let v = 0; v < free.length; v++) if (free[v] && rings[v].length && !(pinBoundary && boundary[v])) moving.push(v);
  // Taubin's two steps: lambda = factor, and mu from 1 / lambda + 1 / mu = passBand.
  const steps = method === 'taubin' ? [factor, 1 / (passBand - 1 / factor)] : [factor],
    points: MutableVec3[] = mesh.vertices.map((p) => [p[0], p[1], p[2]]),
    delta = new Float64Array(moving.length * 3);
  for (let pass = 0; pass < iterations; pass++) {
    signal?.throwIfAborted();
    for (const step of steps) {
      moving.forEach((v, i) => {
        const ring = rings[v],
          p = points[v];
        let x = 0,
          y = 0,
          z = 0;
        for (const n of ring) {
          x += points[n][0];
          y += points[n][1];
          z += points[n][2];
        }
        delta[i * 3] = (x / ring.length - p[0]) * step;
        delta[i * 3 + 1] = (y / ring.length - p[1]) * step;
        delta[i * 3 + 2] = (z / ring.length - p[2]) * step;
      });
      moving.forEach((v, i) => {
        points[v][0] += delta[i * 3];
        points[v][1] += delta[i * 3 + 1];
        points[v][2] += delta[i * 3 + 2];
      });
    }
  }
  const sink = new FaceSink(mesh, points);
  for (const face of mesh.faces) sink.add(face.id, face.id, face.vertices, face.uv);
  return sink.result(
    mesh,
    mesh.vertices.map((_, v) => [v]),
  );
}
