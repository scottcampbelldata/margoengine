import { sampleRoadFrame } from './frame.js';
import { Geometry } from '@margoengine/core';
import type { Spline } from '@margoengine/splines';
import { fault } from '../../shared/errors.js';
/** Options for `road`. Lengths are world units; invalid values throw a RangeError. */
export interface RoadOptions {
  /** Driving surface width, positive. Default 6. */
  width?: number;
  /** Width of each curb, positive. Default 0.2. */
  curbWidth?: number;
  /** Curb height above the surface, positive. Default 0.15. */
  curbHeight?: number;
  /** Samples along the spline, an integer 1..4096. Default 128. */
  segments?: number;
  /** World units per UV repeat, across and along the road. Default 5. */
  uvMeters?: number;
  /** Lateral offset and height pairs (2..32, no consecutive duplicates) replacing the default curbed profile built from the widths above. */
  crossSection?: readonly (readonly [number, number])[];
}
/** Result of `road`. */
export interface RoadMesh {
  /** Swept surface with per-strip normals. */
  geometry: Geometry;
  /** u, v per vertex: distance across the section and along the spline, divided by `uvMeters`. */
  uvs: Float32Array;
  /** Copy of the cross-section used. */
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
    throw new RangeError(
      'Road width, curbWidth, curbHeight, uvMeters and the curve length must be finite and above 0, and segments an integer from 1 to 4096; fix the road options.',
    );
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
    throw new RangeError(
      'Road crossSection needs 2 to 32 [x, y] points with finite numbers; pass fewer, finite points.',
    );
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
    if (!length)
      throw new RangeError('Road crossSection has two equal neighbouring points; remove the duplicate point.');
    offsets[i] = offsets[i - 1] + length;
  }
  const center = new Float64Array(3),
    before = new Float64Array(3),
    after = new Float64Array(3),
    epsilon = (curve.length / segments) * 0.01,
    frames = new Float64Array((segments + 1) * 8),
    scales = new Float64Array((segments + 1) * 2).fill(1);
  const negative = Math.max(0, ...section.map((p) => -p[0])),
    positive = Math.max(0, ...section.map((p) => p[0]));
  // Sample once, then bound the offset before its focal fold. For a pair of rows,
  // det(r0, chord + r1*l1) and det(r1, chord - r0*l0) must stay positive.
  // These affine bounds prove both triangles of every horizontal strip stay outward.
  for (let sample = 0; sample <= segments; sample++) {
    const distance = (curve.length * sample) / segments;
    sampleRoadFrame(curve, distance, epsilon, center, before, after);
    let tx = after[0] - before[0],
      ty = after[1] - before[1],
      tz = after[2] - before[2];
    const horizontal = Math.hypot(tx, tz),
      length = Math.hypot(tx, ty, tz);
    if (horizontal < 1e-10 || !length)
      throw fault('unsupported', 'Road spline needs a nonvertical tangent; use a nonvertical Y-up road', 'geometry');
    const rx = tz / horizontal,
      rz = -tx / horizontal;
    tx /= length;
    ty /= length;
    tz /= length;
    frames.set([center[0], center[1], center[2], rx, rz, tx, ty, tz], sample * 8);
  }
  // Chord bisectors keep each row forward on both adjacent tessellated spans,
  // including a turn whose analytic tangent rotates past a coarse sample chord.
  for (let sample = 0; sample <= segments; sample++) {
    const current = sample === segments && curve.closed ? 0 : sample,
      previous = current === 0 ? (curve.closed ? segments - 1 : 0) : current - 1,
      next = current === segments ? segments : current + 1,
      f = current * 8,
      p = previous * 8,
      n = next * 8;
    const incoming = [frames[f] - frames[p], frames[f + 1] - frames[p + 1], frames[f + 2] - frames[p + 2]],
      outgoing = [frames[n] - frames[f], frames[n + 1] - frames[f + 1], frames[n + 2] - frames[f + 2]],
      inLength = Math.hypot(...incoming),
      outLength = Math.hypot(...outgoing);
    const t = incoming.map((v, k) => (inLength ? v / inLength : 0) + (outLength ? outgoing[k] / outLength : 0)),
      horizontal = Math.hypot(t[0], t[2]),
      length = Math.hypot(...t);
    if (!horizontal || !length)
      throw fault(
        'unsupported',
        'Road spline needs a nonvertical, nonreversing tangent; remove the spline cusp',
        'geometry',
      );
    frames.set([t[2] / horizontal, -t[0] / horizontal, t[0] / length, t[1] / length, t[2] / length], sample * 8 + 3);
  }
  for (let sample = 0; sample < segments; sample++) {
    const a = sample * 8,
      b = a + 8,
      dx = frames[b] - frames[a],
      dz = frames[b + 2] - frames[a + 2],
      first = frames[a + 3] * dz - frames[a + 4] * dx,
      last = frames[b + 3] * dz - frames[b + 4] * dx,
      turn = frames[a + 3] * frames[b + 4] - frames[a + 4] * frames[b + 3];
    if (!(first > 0 && last > 0))
      throw fault(
        'failed',
        'Road sample rows reverse or coincide; increase segments or remove a spline cusp',
        'geometry',
      );
    if (turn === 0) continue;
    const side = turn > 0 ? 0 : 1,
      extent = side === 0 ? negative : positive;
    if (!extent) continue;
    const scale = 0.95 / (Math.abs(turn) * extent);
    scales[sample * 2 + side] = Math.min(scales[sample * 2 + side], last * scale);
    scales[(sample + 1) * 2 + side] = Math.min(scales[(sample + 1) * 2 + side], first * scale);
  }
  if (curve.closed)
    for (let side = 0; side < 2; side++) {
      const scale = Math.min(scales[side], scales[segments * 2 + side]);
      scales[side] = scales[segments * 2 + side] = scale;
    }
  for (let sample = 0; sample <= segments; sample++) {
    const f = sample * 8,
      distance = (curve.length * sample) / segments,
      rx = frames[f + 3],
      rz = frames[f + 4],
      tx = frames[f + 5],
      ty = frames[f + 6],
      tz = frames[f + 7];
    const offset = (x: number) => x * scales[sample * 2 + (x < 0 ? 0 : 1)];
    for (let strip = 0; strip < strips; strip++) {
      const lateral = offset(section[strip + 1][0]) - offset(section[strip][0]),
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
        positions[v] = frames[f] + rx * offset(p[0]);
        positions[v + 1] = frames[f + 1] + p[1];
        positions[v + 2] = frames[f + 2] + rz * offset(p[0]);
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
