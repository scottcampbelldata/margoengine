export function compose(out, offset, p, q, s) {
  const [x, y, z, w] = q, x2 = x * 2, y2 = y * 2, z2 = z * 2;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[offset] = (1 - yy - zz) * s[0]; out[offset + 1] = (xy + wz) * s[0]; out[offset + 2] = (xz - wy) * s[0]; out[offset + 3] = 0;
  out[offset + 4] = (xy - wz) * s[1]; out[offset + 5] = (1 - xx - zz) * s[1]; out[offset + 6] = (yz + wx) * s[1]; out[offset + 7] = 0;
  out[offset + 8] = (xz + wy) * s[2]; out[offset + 9] = (yz - wx) * s[2]; out[offset + 10] = (1 - xx - yy) * s[2]; out[offset + 11] = 0;
  out[offset + 12] = p[0]; out[offset + 13] = p[1]; out[offset + 14] = p[2]; out[offset + 15] = 1;
}
