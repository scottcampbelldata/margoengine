import type { Geometry } from '@margoengine/core';
import { fault } from '../../shared/errors.js';

/** One constant-width road centre line in the horizontal XZ plane, in metres. */
export interface JunctionRoad {
  /** 2..4096 finite [x, z] points, each coordinate within 1,000,000 m. No repeated neighbours. */
  points: readonly (readonly [number, number])[];
  /** Full surface width in metres, above 0 and at most 1000. Default 6. */
  width?: number;
}

/** Settings for an at-grade stitched road surface. */
export interface JunctionOptions {
  /** Shared Y elevation in metres, within +/-1,000,000. Default 0. */
  elevation?: number;
  /** Metres per world-space UV repeat, above 0 and at most 1,000,000. Default 1. */
  uvMeters?: number;
  /** Cancels before and after lazy module loading. Synchronous polygon work runs to completion. */
  signal?: AbortSignal;
}

/** A single nonoverlapping surface containing every road and its crossings. */
export interface JunctionMesh {
  /** Y-up triangles, suitable for a core mesh on WebGPU or WebGL2. Caller owns the CPU data. */
  geometry: Geometry;
  /** World-space [x, -z] texture coordinates, divided by uvMeters. */
  uvs: Float32Array;
  /** Filled area in square metres after overlapping surfaces have been united. */
  area: number;
}

/**
 * Stroke and unite 1..64 road centre lines, then triangulate once, including holes.
 * Crossings, T junctions and overlapping bends share a surface instead of drawing overlapping sweeps.
 * This is an at-grade surface: no curbs, grades, turn-radius design or bridge separation.
 * Geometry's existing snap-rounded polygon and triangulation implementations do the geometric work.
 */
export async function junctions(
  roads: readonly JunctionRoad[],
  { elevation = 0, uvMeters = 1, signal }: JunctionOptions = {},
): Promise<JunctionMesh> {
  signal?.throwIfAborted();
  const invalid = () =>
    fault(
      'failed',
      'Use 1..64 roads, at most 4096 total XZ points within +/-1000000, widths in (0,1000], a finite elevation within +/-1000000 and uvMeters in (0,1000000]',
      'geometry',
    );
  if (
    !Array.isArray(roads) ||
    !roads.length ||
    roads.length > 64 ||
    !Number.isFinite(elevation) ||
    Math.abs(elevation) > 1_000_000 ||
    !Number.isFinite(uvMeters) ||
    uvMeters <= 0 ||
    uvMeters > 1_000_000
  )
    throw invalid();
  let total = 0;
  // Copy before the lazy load so a caller cannot change the operation while it waits.
  const checked = roads.map((road) => {
    const width = road?.width ?? 6;
    if (
      !Number.isFinite(width) ||
      width <= 0 ||
      width > 1000 ||
      !Array.isArray(road?.points) ||
      road.points.length < 2 ||
      (total += road.points.length) > 4096
    )
      throw invalid();
    const points = road.points.map((p: readonly [number, number], i: number) => {
      if (
        !Array.isArray(p) ||
        p.length !== 2 ||
        !p.every((v) => Number.isFinite(v) && Math.abs(v) <= 1_000_000) ||
        (i && p[0] === road.points[i - 1][0] && p[1] === road.points[i - 1][1])
      )
        throw invalid();
      return [p[0], -p[1]] as [number, number];
    });
    return { points, width };
  });
  const [{ polygonStroke, polygonUnion, polygonArea, polygonShapes }, { shapeGeometry }, { applyMatrix4, toGeometry }] =
    await Promise.all([
      import('@margoengine/geometry/polygon'),
      import('@margoengine/geometry/extrude'),
      import('@margoengine/geometry/utils'),
    ]);
  signal?.throwIfAborted();
  const regions = polygonUnion(
    checked.map(({ points, width }) => polygonStroke(points, width, { join: 'bevel', cap: 'butt' })),
  );
  if (!regions.length)
    throw fault(
      'failed',
      'Road footprint vanished at the polygon grid resolution; increase its width or reduce its coordinate span',
      'geometry',
    );
  const data = applyMatrix4(shapeGeometry(polygonShapes(regions)), [
    1,
    0,
    0,
    0,
    0,
    0,
    -1,
    0,
    0,
    1,
    0,
    0,
    0,
    elevation,
    0,
    1,
  ]);
  // Float32 is the renderer's storage contract. Reject a footprint that lost area
  // on conversion rather than handing the renderer collapsed or reversed faces.
  const p = data.positions;
  for (let i = 0; i < data.indices.length; i += 3) {
    const a = data.indices[i] * 3,
      b = data.indices[i + 1] * 3,
      c = data.indices[i + 2] * 3;
    const area = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
    if (!(area > 0))
      throw fault(
        'failed',
        'Road triangles collapsed at float32 precision; move the roads closer to their local origin or increase their width',
        'geometry',
      );
  }
  if (uvMeters !== 1)
    for (let i = 0; i < data.uvs.length; i++) {
      data.uvs[i] /= uvMeters;
      if (!Number.isFinite(data.uvs[i]))
        throw fault(
          'failed',
          'Road UV coordinates overflowed float32; increase uvMeters or move the roads closer to their local origin',
          'geometry',
        );
    }
  return { geometry: toGeometry(data), uvs: data.uvs, area: polygonArea(regions) };
}
