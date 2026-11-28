export const plate = { width: .318, depth: .214, radius: .039, thickness: .007 };
export const farStress = 10;
export const startAngle = 18;
export const toRadians = value => value * Math.PI / 180;

// Kirsch plane stress in the polar frame of the free rim, then in fixed sheet coordinates.
export function stressAt(x, y, angle, load = farStress) {
  const r = Math.hypot(x, y);
  if (r < plate.radius * (1 - 1e-12)) return null;
  const theta = Math.atan2(y, x);
  const relative = theta - angle;
  const u = (plate.radius / r) ** 2;
  const c2 = Math.cos(2 * relative), s2 = Math.sin(2 * relative);
  const rr = load * .5 * ((1 - u) + (1 - 4 * u + 3 * u * u) * c2);
  const tt = load * .5 * ((1 + u) - (1 + 3 * u * u) * c2);
  const rt = -load * .5 * (1 + 2 * u - 3 * u * u) * s2;
  const c = Math.cos(theta), s = Math.sin(theta);
  const xx = rr * c * c + tt * s * s - 2 * rt * c * s;
  const yy = rr * s * s + tt * c * c + 2 * rt * c * s;
  const xy = (rr - tt) * c * s + rt * (c * c - s * s);
  return { rr, tt, rt, tensor: [xx, yy, 0, xy, 0, 0] };
}

export const samples = [];
for (let row = -3; row <= 3; row++) for (let col = -5; col <= 5; col++) {
  const x = col * .027, y = row * .027;
  if (Math.hypot(x, y) >= plate.radius + .029) samples.push([x, y]);
}
for (let i = 0; i < 16; i++) {
  const angle = i * Math.PI / 8, r = plate.radius + .012;
  samples.push([r * Math.cos(angle), r * Math.sin(angle)]);
}

function principalInPlane(eigen) {
  return Array.from(eigen.values).flatMap((value, i) => {
    const [x, y, z] = eigen.vectors.subarray(3 * i, 3 * i + 3);
    return Math.abs(z) < .5 ? [{ value, x, y }] : [];
  });
}

export function glyphField(angle, mode, solve) {
  const marks = { tension: [], compression: [], shear: [] };
  let residual = 0;
  for (const [x, y] of samples) {
    const frame = solve(stressAt(x, y, angle).tensor);
    residual = Math.max(residual, frame.residual);
    const axes = principalInPlane(frame);
    const append = (name, orientationX, orientationY, magnitude) => {
      if (magnitude < .06) return;
      marks[name].push({ position: [x, .010, -y], vector: [orientationX * magnitude, 0, -orientationY * magnitude] });
    };
    if (mode === 'principal') {
      for (const axis of axes)
        append(axis.value >= 0 ? 'tension' : 'compression', axis.x, axis.y, Math.abs(axis.value));
    } else {
      const [major, minor] = axes;
      const shear = (major.value - minor.value) / 2;
      const a = Math.atan2(major.y, major.x) + Math.PI / 4;
      append('shear', Math.cos(a), Math.sin(a), shear);
      append('shear', -Math.sin(a), Math.cos(a), shear);
    }
  }
  return { marks, residual };
}
