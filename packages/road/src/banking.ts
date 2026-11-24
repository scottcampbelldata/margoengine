import { sampleRoadFrame } from './frame.js';
import { Geometry } from '@margoengine/core';
import type { Spline } from '@margoengine/splines';
import { road, type RoadMesh, type RoadOptions } from '@margoengine/road';
import { fault } from '../../shared/errors.js';

/** Banked sweep settings. The root road settings keep their defaults. */
export interface BankingOptions extends RoadOptions {
  /** Radians about the forward tangent, within +/-pi/4. A list of 2..4097 values interpolates at equal arc distances. Default 0. */
  bank?: number | readonly number[];
  /** Cancels before and after lazy normal-kernel loading. Default none. */
  signal?: AbortSignal;
}

/** Sweep a road, banking the entire section and rebuilding normals from the resulting triangles. */
export async function bankedRoad(curve: Spline, options: BankingOptions = {}): Promise<RoadMesh> {
  const { bank = 0, signal, segments = 128 } = options;
  signal?.throwIfAborted();
  const invalid = () =>
    fault(
      'failed',
      'Banked road needs finite bank radians within +/-pi/4, bounded finite geometry and noncollapsed triangles',
      'geometry',
    );
  const banks = typeof bank === 'number' ? [bank, bank] : Array.from(bank);
  if (banks.length < 2 || banks.length > 4097 || banks.some((v) => !Number.isFinite(v) || Math.abs(v) > Math.PI / 4))
    throw invalid();
  const closed = curve.closed;
  if (closed && banks[0] !== banks[banks.length - 1])
    throw fault('failed', 'Closed-road bank endpoints must match; repeat the first angle at the end of the bank list', 'geometry');
  const result = road(curve, options);
  const source = result.geometry.vertices,
    positions = new Float32Array(source.length / 2);
  if (
    Array.from(source).some((v) => !Number.isFinite(v) || Math.abs(v) > 1e6) ||
    Array.from(result.uvs).some((v) => !Number.isFinite(v))
  )
    throw invalid();
  const row = (result.section.length - 1) * 2;
  const center = new Float64Array(3),
    before = new Float64Array(3),
    after = new Float64Array(3);
  const epsilon = (curve.length / segments) * 0.01;
  for (let sample = 0; sample <= segments; sample++) {
    const distance = (curve.length * sample) / segments;
    sampleRoadFrame(curve, distance, epsilon, center, before, after);
    const length = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    const axis = Array.from(after, (v, a) => (v - before[a]) / length);
    const t = (sample / segments) * (banks.length - 1),
      i = Math.min(banks.length - 2, Math.floor(t));
    const angle = banks[i] + (banks[i + 1] - banks[i]) * (t - i),
      c = Math.cos(angle),
      s = Math.sin(angle);
    for (let vertex = sample * row; vertex < (sample + 1) * row; vertex++) {
      const x = source[vertex * 6] - center[0],
        y = source[vertex * 6 + 1] - center[1],
        z = source[vertex * 6 + 2] - center[2];
      const dot = (axis[0] * x + axis[1] * y + axis[2] * z) * (1 - c);
      positions[vertex * 3] = center[0] + x * c + (axis[1] * z - axis[2] * y) * s + axis[0] * dot;
      positions[vertex * 3 + 1] = center[1] + y * c + (axis[2] * x - axis[0] * z) * s + axis[1] * dot;
      positions[vertex * 3 + 2] = center[2] + z * c + (axis[0] * y - axis[1] * x) * s + axis[2] * dot;
    }
  }
  if (positions.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e6)) throw invalid();
  const indices = result.geometry.indices;
  // A float32 collapse cannot be repaired by normal averaging. Reject it before invoking the existing kernel.
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    const x = positions[b] - positions[a],
      y = positions[b + 1] - positions[a + 1],
      z = positions[b + 2] - positions[a + 2];
    const u = positions[c] - positions[a],
      v = positions[c + 1] - positions[a + 1],
      w = positions[c + 2] - positions[a + 2];
    if (!(Math.hypot(y * w - z * v, z * u - x * w, x * v - y * u) > 0)) throw invalid();
  }
  const { computeVertexNormals } = await import('@margoengine/geometry/utils');
  signal?.throwIfAborted();
  // Join only corresponding strip vertices. This preserves hard curb edges and the UV seam
  // while giving the normal kernel all incident corner angles at the periodic end row.
  const normalIndices = closed ? indices.map((v) => (v >= segments * row ? v - segments * row : v)) : indices;
  const data = computeVertexNormals({
    positions,
    indices: normalIndices,
    normals: new Float32Array(positions.length),
    uvs: result.uvs,
  });
  if (closed) data.normals.set(data.normals.subarray(0, row * 3), segments * row * 3);
  return { ...result, geometry: new Geometry(positions, data.normals, indices) };
}
