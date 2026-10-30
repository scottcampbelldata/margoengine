import { hypotOf, hypotTerms as h } from '../../shared/hypot.js';
import type { Camera, Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';

/**
 * Far distance of each cascade, blending logarithmic (`lambda` 1) and uniform (`lambda` 0) splits of [near, far].
 * With `count` below 4 the first `count` entries split the range and the rest repeat `far`, so a shader that selects
 * a cascade by comparing view depth against the splits never picks an unused one.
 * Practical split scheme: Zhang, Sun, Xu & Lo 2006, "Parallel-Split Shadow Maps".
 */
export function cascadeSplits(
  near: number,
  far: number,
  lambda = 0.5,
  out = new Float32Array(4),
  count = 4,
): Float32Array {
  if (
    !Number.isFinite(near) ||
    !Number.isFinite(far) ||
    !Number.isFinite(lambda) ||
    near <= 0 ||
    far <= near ||
    lambda < 0 ||
    lambda > 1 ||
    out.length !== 4 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 4
  )
    throw new RangeError(
      'Cascade splits need near > 0, far > near, lambda from 0 to 1 and a count from 1 to 4; pass finite values in range.',
    );
  for (let i = 0; i < 4; i++) {
    // A compare, not Math.min (V8 13 Maglev boxes its numbers); t is positive and finite.
    const step = (i + 1) / count,
      t = step < 1 ? step : 1;
    out[i] = lambda * near * (far / near) ** t + (1 - lambda) * (near + (far - near) * t);
  }
  return out;
}
/**
 * Fits one light-space orthographic matrix per cascade (16 floats each in `matrices`) around a bounding sphere of
 * the camera slice between consecutive `splits`, snapped to whole texels. `ranges` receives each cascade's depth
 * extent. Only the first `count` cascades are fitted; the rest of `matrices` and `ranges` is zeroed.
 * Sphere fit and texel snapping: Valient 2008, "Stable Rendering of Cascaded Shadow Maps" (ShaderX6).
 */
export function fitCascades(
  camera: Camera,
  aspect: number,
  direction: Vec3,
  resolution: number,
  splits: Float32Array,
  matrices = new Float32Array(64),
  ranges = new Float32Array(4),
  margin = 100,
  result?: { matrices: Float32Array; ranges: Float32Array },
  count = 4,
): { matrices: Float32Array; ranges: Float32Array } {
  finiteVector(direction, 3, 'Shadow direction');
  if (
    !Number.isFinite(aspect) ||
    aspect <= 0 ||
    !Number.isInteger(resolution) ||
    resolution < 1 ||
    splits.length !== 4 ||
    matrices.length !== 64 ||
    ranges.length !== 4 ||
    !Number.isFinite(margin) ||
    margin < 0 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 4
  )
    throw new RangeError(
      'Cascade fit needs a positive aspect, an integer resolution of at least 1, a margin of 0 or more and a count from 1 to 4; pass valid values.',
    );
  // hypotOf, not Math.hypot: this runs every frame, Math.hypot allocates its arguments and a call with numbers boxes
  // them; the terms and result go through hypotTerms (h) instead (the same bits in V8).
  h[0] = direction[0];
  h[1] = direction[1];
  h[2] = direction[2];
  hypotOf(3);
  const length = h[4];
  if (!length) throw new RangeError('Shadow light direction has zero length; pass a nonzero direction vector.');
  const zx = -direction[0] / length,
    zy = -direction[1] / length,
    zz = -direction[2] / length,
    vertical = Math.abs(zy) > 0.99;
  let xx = vertical ? -zy : zz,
    xy = vertical ? zx : 0,
    xz = vertical ? 0 : -zx;
  h[0] = xx;
  h[1] = xy;
  h[2] = xz;
  hypotOf(3);
  const xl = h[4];
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx;
  const fx = camera.target[0] - camera.position[0],
    fy = camera.target[1] - camera.position[1],
    fz = camera.target[2] - camera.position[2];
  h[0] = fx;
  h[1] = fy;
  h[2] = fz;
  hypotOf(3);
  const fl = h[4];
  if (!fl)
    throw new RangeError(
      'Shadow camera position and target are the same point; move the target away from the position.',
    );
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  let start = camera.near;
  matrices.fill(0, count * 16);
  ranges.fill(0, count);
  for (let i = 0; i < count; i++) {
    const end = splits[i];
    // x - x is 0 exactly for a finite x. Per-frame checks avoid Number.isFinite: V8's optimizing tier before the top
    // one calls it, and boxes each fractional argument into a new heap number.
    if (end - end !== 0 || end <= start)
      throw new RangeError('Cascade split ends must be finite and increase; check near, far and lambda.');
    const mid = (start + end) / 2,
      px = camera.position[0] + (fx / fl) * mid,
      py = camera.position[1] + (fy / fl) * mid,
      pz = camera.position[2] + (fz / fl) * mid;
    // A sphere keeps extents stable under camera rotation; one texel covers snapping error.
    h[0] = end * tan * aspect;
    h[1] = end * tan;
    h[2] = end - mid;
    hypotOf(3);
    const radius = (Math.ceil(h[4] * 16) / 16) * (1 + 2 / resolution),
      texel = (2 * radius) / resolution;
    const cx = Math.round((px * xx + py * xy + pz * xz) / texel) * texel,
      cy = Math.round((px * yx + py * yy + pz * yz) / texel) * texel,
      cz = Math.round((px * zx + py * zy + pz * zz) / texel) * texel,
      depth = 2 * (radius + margin),
      offset = i * 16;
    matrices.fill(0, offset, offset + 16);
    matrices[offset] = xx / radius;
    matrices[offset + 4] = xy / radius;
    matrices[offset + 8] = xz / radius;
    matrices[offset + 1] = yx / radius;
    matrices[offset + 5] = yy / radius;
    matrices[offset + 9] = yz / radius;
    matrices[offset + 2] = zx / depth;
    matrices[offset + 6] = zy / depth;
    matrices[offset + 10] = zz / depth;
    matrices[offset + 12] = -cx / radius;
    matrices[offset + 13] = -cy / radius;
    matrices[offset + 14] = 0.5 - cz / depth;
    matrices[offset + 15] = 1;
    ranges[i] = depth;
    start = end;
  }
  for (let i = 0; i < matrices.length; i++)
    if (matrices[i] - matrices[i] !== 0)
      throw new RangeError(
        'Shadow cascade matrix is not finite; check the camera, light direction and bounds for extreme values.',
      );
  if (result) {
    result.matrices = matrices;
    result.ranges = ranges;
    return result;
  }
  return { matrices, ranges };
}
