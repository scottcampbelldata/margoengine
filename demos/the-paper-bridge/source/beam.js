export const specimen = Object.freeze({
  span: 0.180,
  length: 0.204,
  developedWidth: 0.096,
  thickness: 0.00050,
  modulus: 2.6e9,
  folds: 4,
});
const gravity = 9.80665;
const stations = 64;

function centerline(depth, width) {
  return Array.from({ length: stations + 1 }, (_, index) => {
    const u = index / stations;
    return [
      (u - 0.5) * width,
      depth * (1 - Math.cos(2 * Math.PI * specimen.folds * u)) / 2,
    ];
  });
}

function length(points) {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  }
  return total;
}

function sectionMoments(contour) {
  let doubledArea = 0;
  let centroidNumerator = 0;
  let inertiaNumerator = 0;
  for (let index = 0; index < contour.length; index++) {
    const [z1, y1] = contour[index];
    const [z2, y2] = contour[(index + 1) % contour.length];
    const cross = z1 * y2 - z2 * y1;
    doubledArea += cross;
    centroidNumerator += (y1 + y2) * cross;
    inertiaNumerator += (y1 * y1 + y1 * y2 + y2 * y2) * cross;
  }
  const area = doubledArea / 2;
  const neutral = centroidNumerator / (6 * area);
  return { neutral, inertia: Math.abs(inertiaNumerator / 12 - area * neutral * neutral) };
}

export function section(depth) {
  depth = Math.min(0.009, Math.max(0, depth));
  let lo = 0;
  let hi = specimen.developedWidth;
  for (let step = 0; step < 26; step++) {
    const width = (lo + hi) / 2;
    if (length(centerline(depth, width)) > specimen.developedWidth) hi = width;
    else lo = width;
  }
  const line = centerline(depth, depth === 0 ? specimen.developedWidth : (lo + hi) / 2);
  const normals = line.slice(1).map(([z, y], index) => {
    const dz = z - line[index][0];
    const dy = y - line[index][1];
    const size = Math.hypot(dz, dy);
    return [-dy / size, dz / size];
  });
  const top = [];
  const bottom = [];
  for (let index = 0; index < line.length; index++) {
    const [z, y] = line[index];
    const left = normals[Math.max(0, index - 1)];
    const right = normals[Math.min(normals.length - 1, index)];
    const scale = specimen.thickness / (2 * (1 + left[0] * right[0] + left[1] * right[1]));
    const dz = (left[0] + right[0]) * scale;
    const dy = (left[1] + right[1]) * scale;
    top.push([z + dz, y + dy]);
    bottom.push([z - dz, y - dy]);
  }
  const { neutral, inertia } = sectionMoments([...top, ...Array.from(bottom).reverse()]);
  return { line, top, bottom, neutral, inertia, depth };
}

export function response(shape, loadGrams) {
  const force = loadGrams * gravity / 1000;
  const { span, modulus } = specimen;
  const stiffness = modulus * shape.inertia;
  const half = span / 2;
  const transverse = force / (48 * stiffness);
  const farthest = Math.max(
    ...shape.top.map(([, y]) => Math.abs(y - shape.neutral)),
    ...shape.bottom.map(([, y]) => Math.abs(y - shape.neutral)),
  );
  return {
    stiffness,
    deflection: force * span ** 3 / (48 * stiffness),
    peakStress: force * span * farthest / (4 * shape.inertia),
    at(x, y = shape.neutral) {
      const fromSupport = half - Math.abs(x);
      const u = Math.max(0, fromSupport);
      const slopeMagnitude = transverse * (3 * span * span - 12 * u * u);
      const down = transverse * u * (3 * span * span - 4 * u * u) + Math.min(0, fromSupport) * slopeMagnitude;
      const slope = Math.sign(x) * slopeMagnitude;
      const stress = -force * u * (y - shape.neutral) / (2 * shape.inertia);
      return { down, slope, stress };
    },
  };
}
