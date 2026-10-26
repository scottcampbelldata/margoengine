/**
 * A spot whose outer cone reaches a hemisphere (cosine below 1e-6: within 1e-6 rad of pi / 2) needs a 180-degree
 * frustum, which one perspective map cannot hold: its shadow is the six cube faces of a point light.
 */
export const hemisphere = (cosine: number): boolean => cosine < 1e-6;
/** A right-handed perspective view with WebGPU's zero-to-one clip depth. */
export function localShadowMatrix(
  out: Float32Array,
  offset: number,
  position: ArrayLike<number>,
  direction: ArrayLike<number>,
  up: ArrayLike<number>,
  near: number,
  far: number,
  angle: number,
): void {
  const dl = Math.hypot(direction[0], direction[1], direction[2]),
    zx = -direction[0] / dl,
    zy = -direction[1] / dl,
    zz = -direction[2] / dl;
  let xx = up[1] * zz - up[2] * zy,
    xy = up[2] * zx - up[0] * zz,
    xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz);
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx,
    f = 1 / Math.tan(angle / 2),
    a = far / (near - far),
    b = near * a;
  const tx = -(xx * position[0] + xy * position[1] + xz * position[2]),
    ty = -(yx * position[0] + yy * position[1] + yz * position[2]),
    tz = -(zx * position[0] + zy * position[1] + zz * position[2]);
  out[offset] = f * xx;
  out[offset + 1] = f * yx;
  out[offset + 2] = a * zx;
  out[offset + 3] = -zx;
  out[offset + 4] = f * xy;
  out[offset + 5] = f * yy;
  out[offset + 6] = a * zy;
  out[offset + 7] = -zy;
  out[offset + 8] = f * xz;
  out[offset + 9] = f * yz;
  out[offset + 10] = a * zz;
  out[offset + 11] = -zz;
  out[offset + 12] = f * tx;
  out[offset + 13] = f * ty;
  out[offset + 14] = a * tz + b;
  out[offset + 15] = -tz;
  for (let i = offset; i < offset + 16; i++)
    if (!Number.isFinite(out[i]))
      throw new RangeError(
        'Local shadow matrix overflow; use a finite light position and range, and a far plane that is not extreme',
      );
}
/**
 * `LocalShadows`' settings from a castShadow light's `shadow` object: map width, height, near and far, 0 where unset
 * (the plugin's resolution, far / 1000 and the light's range). Throws on a bad value; the plugin checks the size limit.
 */
export function shadowCamera(
  shadow: { resolution?: number | readonly [number, number]; near?: number; far?: number },
  range: number,
): [number, number, number, number] {
  const size = shadow.resolution,
    pair = Array.isArray(size) && size.length === 2,
    width = typeof size === 'number' ? size : pair ? size[0] : NaN,
    height = typeof size === 'number' ? size : pair ? size[1] : NaN;
  if (size !== undefined && !(Number.isInteger(width) && Number.isInteger(height) && Math.min(width, height) >= 16))
    throw new RangeError('Invalid light shadow resolution: give an integer or [width, height] of 16 or more');
  if (
    (shadow.near !== undefined && typeof shadow.near !== 'number') ||
    (shadow.far !== undefined && typeof shadow.far !== 'number')
  )
    throw new TypeError('Light shadow near and far must be numbers');
  const far = Math.fround(shadow.far ?? range),
    near = Math.fround(shadow.near ?? far * 1e-3);
  if (!(Number.isFinite(far) && near > 0 && near < far))
    throw new RangeError('Invalid light shadow near/far: give 0 < near < far, finite (far defaults to the range)');
  return [
    size === undefined ? 0 : width,
    size === undefined ? 0 : height,
    shadow.near === undefined ? 0 : near,
    shadow.far === undefined ? 0 : far,
  ];
}
/**
 * A light whose map (`width` x `height`) is smaller than its `size` x `size` layers renders into each layer's top-left
 * corner (a viewport). Narrows the render matrix `camera` (at `c`) so its frustum lands inside that corner less two
 * texels per side, which keeps the receiver's 3x3 filter taps inside it, and writes into `sample` (at `s`) the same
 * matrix with the corner's UVs mapped into the whole layer's: uv * (width, height) / size.
 */
export function viewportMatrix(
  camera: Float32Array,
  c: number,
  sample: Float32Array,
  s: number,
  width: number,
  height: number,
  size: number,
): void {
  const gx = (width - 4) / width,
    gy = (height - 4) / height,
    sx = width / size,
    sy = height / size;
  for (let k = 0; k < 16; k += 4) {
    const x = Math.fround(camera[c + k] * gx),
      y = Math.fround(camera[c + k + 1] * gy),
      w = camera[c + k + 3];
    camera[c + k] = x;
    camera[c + k + 1] = y;
    // uv = ndc * (0.5, -0.5) + 0.5, so scaling uv by (sx, sy) is ndc.x * sx + sx - 1 and ndc.y * sy + 1 - sy.
    sample[s + k] = sx * x + (sx - 1) * w;
    sample[s + k + 1] = sy * y + (1 - sy) * w;
    sample[s + k + 2] = camera[c + k + 2];
    sample[s + k + 3] = w;
  }
}
