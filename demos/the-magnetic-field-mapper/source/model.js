const mu0Over4Pi = 1e-7;
export const sphereRadius = .022;
export const sphereY = .082;
export const sensorY = .054;
export const moment = 11.5;

export function dipoleAt(x, y, z, sourceX, orientation) {
  const dx = x - sourceX, dy = y - sphereY;
  const squareDistance = dx * dx + dy * dy + z * z;
  if (squareDistance < sphereRadius ** 2) throw new RangeError('A sensor must be outside the magnet.');
  const unitPower = mu0Over4Pi * moment * orientation / squareDistance ** 1.5;
  const radial = 3 * dx / squareDistance;
  return [unitPower * (radial * dx - 1), unitPower * radial * dy, unitPower * radial * z];
}

export function measure(x, z, separation, rightOrientation) {
  const a = dipoleAt(x, sensorY, z, -separation / 2, 1);
  const b = dipoleAt(x, sensorY, z, separation / 2, rightOrientation);
  const xField = a[0] + b[0], zField = a[2] + b[2];
  return {
    xField, zField, vertical: a[1] + b[1],
    horizontal: Math.hypot(xField, zField),
    bearing: Math.atan2(-zField, xField),
  };
}

