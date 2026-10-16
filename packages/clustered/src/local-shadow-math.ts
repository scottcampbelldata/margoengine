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
    if (!Number.isFinite(out[i])) throw new RangeError('Local shadow matrix overflow');
}
