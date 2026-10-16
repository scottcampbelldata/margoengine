// Core Camera.update's view matrix, including its `up` hook (default +Y), for passes that need view space.
export function viewMatrix(out, camera) {
  const p = camera.position,
    u = camera.up ?? [0, 1, 0];
  let x = p[0] - camera.target[0],
    y = p[1] - camera.target[1],
    z = p[2] - camera.target[2];
  // Match Math.hypot's normalized, compensated three-component sum without boxing scalar call arguments.
  // https://github.com/v8/v8/blob/main/src/builtins/math.tq
  const lengthX = Math.abs(x),
    lengthY = Math.abs(y),
    lengthZ = Math.abs(z),
    lengthMax = Math.max(Math.max(lengthX, lengthY), lengthZ);
  let length;
  if (lengthX === Infinity || lengthY === Infinity || lengthZ === Infinity) length = Infinity;
  else if (lengthMax !== lengthMax) length = lengthMax;
  else if (lengthMax === 0) length = 0;
  else {
    const first = (lengthX / lengthMax) * (lengthX / lengthMax),
      second = (lengthY / lengthMax) * (lengthY / lengthMax),
      correction = first + second - first - second,
      third = (lengthZ / lengthMax) * (lengthZ / lengthMax) - correction;
    length = Math.sqrt(first + second + third) * lengthMax;
  }
  x /= length;
  y /= length;
  z /= length;
  let xx = u[1] * z - u[2] * y,
    xy = u[2] * x - u[0] * z,
    xz = u[0] * y - u[1] * x;
  const sideX = Math.abs(xx),
    sideY = Math.abs(xy),
    sideZ = Math.abs(xz),
    sideMax = Math.max(Math.max(sideX, sideY), sideZ);
  let side;
  if (sideX === Infinity || sideY === Infinity || sideZ === Infinity) side = Infinity;
  else if (sideMax !== sideMax) side = sideMax;
  else if (sideMax === 0) side = 0;
  else {
    const first = (sideX / sideMax) * (sideX / sideMax),
      second = (sideY / sideMax) * (sideY / sideMax),
      correction = first + second - first - second,
      third = (sideZ / sideMax) * (sideZ / sideMax) - correction;
    side = Math.sqrt(first + second + third) * sideMax;
  }
  if (!length || !side) throw new RangeError('Invalid camera view');
  xx /= side;
  xy /= side;
  xz /= side;
  const yx = y * xz - z * xy,
    yy = z * xx - x * xz,
    yz = x * xy - y * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = x;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = y;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = z;
  out[11] = 0;
  out[12] = -xx * p[0] - xy * p[1] - xz * p[2];
  out[13] = -yx * p[0] - yy * p[1] - yz * p[2];
  out[14] = -x * p[0] - y * p[1] - z * p[2];
  out[15] = 1;
  return out;
}
