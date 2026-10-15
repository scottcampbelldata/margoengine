import { Geometry } from '@margoengine/core';
import type { Spline } from '@margoengine/splines';
export interface RoadOptions {
  width?: number;
  curbWidth?: number;
  curbHeight?: number;
  segments?: number;
  uvMeters?: number;
  crossSection?: readonly (readonly [number, number])[];
}
export interface RoadMesh {
  geometry: Geometry;
  uvs: Float32Array;
  section: readonly (readonly [number, number])[];
}

/** Sweep lateral offset/height pairs along an arc-length sampled, Y-up spline. */
export function road(
  curve: Spline,
  { width = 6, curbWidth = 0.2, curbHeight = 0.15, segments = 128, uvMeters = 5, crossSection }: RoadOptions = {},
): RoadMesh {
  if (
    ![width, curbWidth, curbHeight, uvMeters, curve.length].every((v) => Number.isFinite(v) && v > 0) ||
    !Number.isInteger(segments) ||
    segments < 1 ||
    segments > 4096
  )
    throw new RangeError('Invalid road dimensions');
  const section = crossSection ?? [
    [-width / 2 - curbWidth, 0],
    [-width / 2 - curbWidth, curbHeight],
    [-width / 2, curbHeight],
    [-width / 2, 0],
    [width / 2, 0],
    [width / 2, curbHeight],
    [width / 2 + curbWidth, curbHeight],
    [width / 2 + curbWidth, 0],
  ];
  if (section.length < 2 || section.length > 32 || section.some((p) => p.length !== 2 || !p.every(Number.isFinite)))
    throw new RangeError('Invalid road cross-section');
  const strips = section.length - 1,
    row = strips * 2,
    count = (segments + 1) * row;
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    uvs = new Float32Array(count * 2),
    indices = new Uint32Array(segments * strips * 6),
    offsets = new Float64Array(section.length);
  for (let i = 1; i < section.length; i++) {
    const length = Math.hypot(section[i][0] - section[i - 1][0], section[i][1] - section[i - 1][1]);
    if (!length) throw new RangeError('Duplicate cross-section points');
    offsets[i] = offsets[i - 1] + length;
  }
  const center = new Float64Array(3),
    before = new Float64Array(3),
    after = new Float64Array(3),
    epsilon = (curve.length / segments) * 0.01;
  for (let sample = 0; sample <= segments; sample++) {
    const distance = (curve.length * sample) / segments;
    curve.atDistance(distance, center);
    curve.atDistance(Math.max(0, distance - epsilon), before);
    curve.atDistance(Math.min(curve.length, distance + epsilon), after);
    let tx = after[0] - before[0],
      ty = after[1] - before[1],
      tz = after[2] - before[2];
    const horizontal = Math.hypot(tx, tz),
      length = Math.hypot(tx, ty, tz);
    if (horizontal < 1e-10 || !length) throw new RangeError('Road spline needs a nonvertical tangent');
    const rx = tz / horizontal,
      rz = -tx / horizontal;
    tx /= length;
    ty /= length;
    tz /= length;
    for (let strip = 0; strip < strips; strip++) {
      const lateral = section[strip + 1][0] - section[strip][0],
        height = section[strip + 1][1] - section[strip][1];
      const nx = ty * rz * lateral - tz * height,
        ny = (tz * rx - tx * rz) * lateral,
        nz = tx * height - ty * rx * lateral,
        normalLength = Math.hypot(nx, ny, nz);
      for (let side = 0; side < 2; side++) {
        const index = sample * row + strip * 2 + side,
          p = section[strip + side],
          v = index * 3,
          t = index * 2;
        positions[v] = center[0] + rx * p[0];
        positions[v + 1] = center[1] + p[1];
        positions[v + 2] = center[2] + rz * p[0];
        normals[v] = nx / normalLength;
        normals[v + 1] = ny / normalLength;
        normals[v + 2] = nz / normalLength;
        uvs[t] = offsets[strip + side] / uvMeters;
        uvs[t + 1] = distance / uvMeters;
      }
      if (sample < segments) {
        const a = sample * row + strip * 2,
          b = a + row,
          i = (sample * strips + strip) * 6;
        indices[i] = a;
        indices[i + 1] = b;
        indices[i + 2] = a + 1;
        indices[i + 3] = a + 1;
        indices[i + 4] = b;
        indices[i + 5] = b + 1;
      }
    }
  }
  return {
    geometry: new Geometry(positions, normals, indices),
    uvs,
    section: section.map((p) => [...p] as [number, number]),
  };
}
