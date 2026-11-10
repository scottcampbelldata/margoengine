import { MeshSurfaceSampler, type MeshSurfaceSamplerOptions } from '@margoengine/geometry/sample';
import type { GeometryData } from '@margoengine/geometry';
import { createRandom } from '@margoengine/math/mathutils';
import { composeMatrix, invertMatrix } from '@margoengine/math/mat4';

/** Area/paint-weighted placement in world space; all defaults are deterministic. */
export interface SurfaceScatterOptions extends Omit<MeshSurfaceSamplerOptions, 'random'> {
  /** Column-major affine source-to-world matrix. Default identity; areas are measured after this transform. */
  matrix?: ArrayLike<number>;
  /** Positive uniform instance scale range. Default [1, 1]. */
  scale?: readonly [number, number];
  /** Local rotation about the sampled normal, radians. Default [0, 2 * Math.PI]. */
  yaw?: readonly [number, number];
  /** Fraction of the shortest rotation from world +Y to the normal. Default 1, range 0..1. */
  align?: number;
  /** World offset along the surface normal. Default 0. */
  offset?: number;
  /** Cancels before or during sampling, including construction of transformed source attributes. */
  signal?: AbortSignal;
}

/** Samples and matrices from one surface scatter operation, owned by the caller. */
export interface SurfaceScatterData {
  /** Column-major world matrices, directly accepted by ScatterBatch or TexturedScatter on an identity root. */
  transforms: Float32Array;
  /** World roots before offset, xyz per placement. */
  positions: Float32Array;
  /** World inverse-transpose surface normals, xyz per placement. */
  normals: Float32Array;
  /** Interpolated source UV, two floats per placement. */
  uvs: Float32Array;
  /** Interpolated painted colour, RGBA per placement, white without options.colors. */
  colors: Float32Array;
}

/**
 * Samples any triangular mesh by world area or interpolated painted vertex density and aligns instance +Y to its
 * normal, including cliffs, undersides and curved worlds. Reuses geometry's MeshSurfaceSampler without a renderer.
 * @throws RangeError for invalid counts, transforms, options, geometry or non-f32 output. The maximum count is 1000000.
 * @throws DOMException when signal is aborted.
 */
export function scatterSurface(
  data: GeometryData,
  count: number,
  options: SurfaceScatterOptions = {},
): SurfaceScatterData {
  const { seed = 1, scale = [1, 1], yaw = [0, Math.PI * 2], align = 1, offset = 0, signal } = options;
  signal?.throwIfAborted();
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    count > 1_000_000 ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff
  )
    throw new RangeError('Use a count from 0 to 1000000 and an integer seed from 0 to 4294967295.');
  if (
    scale.length !== 2 ||
    !scale.every((v) => Number.isFinite(Math.fround(v)) && Math.fround(v) > 0) ||
    scale[1] < scale[0] ||
    yaw.length !== 2 ||
    !yaw.every(Number.isFinite) ||
    yaw[1] < yaw[0] ||
    !Number.isFinite(yaw[1] - yaw[0]) ||
    !Number.isFinite(align) ||
    align < 0 ||
    align > 1 ||
    !Number.isFinite(Math.fround(offset))
  )
    throw new RangeError(
      'Use finite ordered scale/yaw ranges, positive f32 scales, align from 0 to 1 and a finite f32 offset.',
    );
  let source = data,
    // A mirroring matrix reverses the winding, so a face normal taken from world positions points inward; the
    // inverse transpose of the source face normal (what vertex normals get) is the negated cross product.
    flip = false;
  if (options.matrix) {
    const m = options.matrix;
    if (m.length !== 16 || Array.from(m).some((v) => !Number.isFinite(v)) || m[3] || m[7] || m[11] || m[15] !== 1)
      throw new RangeError('Use a finite affine source matrix with last row 0, 0, 0, 1.');
    const inverse = invertMatrix(m);
    if (!inverse) throw new RangeError('Use an invertible source matrix for surface scattering.');
    flip =
      !data.normals.length &&
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]) < 0;
    const positions = new Float32Array(data.positions.length),
      normals = new Float32Array(data.normals.length);
    for (let i = 0; i < positions.length; i += 3) {
      if (!(i % 3072)) signal?.throwIfAborted();
      const x = data.positions[i],
        y = data.positions[i + 1],
        z = data.positions[i + 2];
      for (let r = 0; r < 3; r++) positions[i + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
      if (normals.length) {
        const nx = data.normals[i],
          ny = data.normals[i + 1],
          nz = data.normals[i + 2];
        const v = [
          inverse[0] * nx + inverse[1] * ny + inverse[2] * nz,
          inverse[4] * nx + inverse[5] * ny + inverse[6] * nz,
          inverse[8] * nx + inverse[9] * ny + inverse[10] * nz,
        ];
        const length = Math.hypot(...v);
        for (let r = 0; r < 3; r++) normals[i + r] = length ? v[r] / length : 0;
      }
    }
    if (positions.some((v) => !Number.isFinite(v)))
      throw new RangeError('Reduce source coordinates or the source matrix so world positions fit finite f32 values.');
    source = { ...data, positions, normals };
  }
  const random = createRandom(seed),
    sampler = new MeshSurfaceSampler(source, { weights: options.weights, colors: options.colors, random });
  const out: SurfaceScatterData = {
    transforms: new Float32Array(count * 16),
    positions: new Float32Array(count * 3),
    normals: new Float32Array(count * 3),
    uvs: new Float32Array(count * 2),
    colors: new Float32Array(count * 4),
  };
  let sample;
  for (let i = 0; i < count; i++) {
    if (!(i % 1024)) signal?.throwIfAborted();
    sample = sampler.sample(sample);
    const n = flip ? sample.normal.map((v) => -v) : sample.normal,
      axisLength = Math.hypot(n[0], n[2]),
      half = Math.acos(Math.max(-1, Math.min(1, n[1]))) * align * 0.5;
    const turn = Math.sin(half),
      x = axisLength ? (n[2] / axisLength) * turn : turn,
      z = axisLength ? (-n[0] / axisLength) * turn : 0,
      w = Math.cos(half);
    const angle = (yaw[0] + (yaw[1] - yaw[0]) * random()) * 0.5,
      s = Math.sin(angle),
      c = Math.cos(angle),
      size = scale[0] + (scale[1] - scale[0]) * random();
    const p = sample.position.map((v, k) => v + n[k] * offset);
    composeMatrix(
      p,
      [x * c - z * s, w * s, z * c + x * s, w * c],
      [size, size, size],
      out.transforms.subarray(i * 16, i * 16 + 16),
    );
    out.positions.set(sample.position, i * 3);
    out.normals.set(n, i * 3);
    out.uvs.set(sample.uv, i * 2);
    out.colors.set(sample.color, i * 4);
  }
  if (
    [out.transforms, out.positions, out.normals, out.uvs, out.colors].some((values) =>
      values.some((v) => !Number.isFinite(v)),
    )
  )
    throw new RangeError(
      'Use finite surface attributes and reduce the offset or scale so all placements fit finite f32 values.',
    );
  return out;
}
