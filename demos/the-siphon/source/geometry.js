import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';

export function move(geometry, [x, y, z], roll = 0) {
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  return applyMatrix4(geometry, [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

export const box = (w, h, d, bevel, point, roll) => move(roundedBoxGeometry(w, h, d, 2, bevel), point, roll);
export const round = (r, h, point, sides = 32) => move(cylinderGeometry(r, r, h, sides, 1), point);
export const turned = (profile, point, sides = 48) => move(latheGeometry(profile, sides), point);
export const batch = (pieces) => pieces.length > 1 ? mergeGeometries(pieces) : pieces[0];

export function facePin(radius, length, [x, y, z], sides = 24) {
  return applyMatrix4(cylinderGeometry(radius, radius, length, sides, 1),
    [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, y, z, 1]);
}

export function pipe(path, radius, sides = 20) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const [i, position] of path.entries()) {
    const before = path[Math.max(0, i - 1)];
    const after = path[Math.min(path.length - 1, i + 1)];
    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const length = Math.hypot(dx, dy);
    for (let j = 0; j <= sides; j++) {
      const angle = j * Math.PI * 2 / sides;
      const cosine = Math.cos(angle);
      const norm = [-dy / length * cosine, dx / length * cosine, Math.sin(angle)];
      positions.push(...position.map((v, k) => v + norm[k] * radius));
      normals.push(...norm);
      uvs.push(j / sides, i / (path.length - 1));
      if (i && j) {
        const index = positions.length / 3 - 1;
        const prior = index - sides - 1;
        indices.push(prior - 1, prior, index - 1, index - 1, prior, index);
      }
    }
  }
  return { positions, normals, uvs, indices };
}

export function quadrant(inner, outer, maxAngle, depth) {
  const positions = [];
  const normals = [];
  const indices = [];
  const uvs = [];
  const sections = 36;
  for (let i = 0; i <= sections; i++) {
    const a = .045 - (maxAngle + .095) * i / sections;
    for (const [r, z, normal] of [
      [inner, depth, [0, 0, 1]], [outer, depth, [0, 0, 1]],
      [outer, depth, [Math.cos(a), Math.sin(a), 0]], [outer, depth - .005, [Math.cos(a), Math.sin(a), 0]],
      [inner, depth, [-Math.cos(a), -Math.sin(a), 0]], [inner, depth - .005, [-Math.cos(a), -Math.sin(a), 0]],
    ]) {
      positions.push(r * Math.cos(a), r * Math.sin(a), z);
      normals.push(...normal);
      uvs.push(i / sections, r === inner ? 0 : 1);
    }
    if (i) {
      const previous = (i - 1) * 6;
      const next = i * 6;
      indices.push(previous, next, previous + 1, previous + 1, next, next + 1,
        previous + 2, next + 2, previous + 3, previous + 3, next + 2, next + 3,
        previous + 4, previous + 5, next + 4, previous + 5, next + 5, next + 4);
    }
  }
  return { positions, normals, indices, uvs };
}

export function measurePath(points) {
  let total = 0;
  return points.map((point, i) => {
    if (i) total += Math.hypot(point[0] - points[i - 1][0], point[1] - points[i - 1][1]);
    return { point, total };
  });
}

export function pathPoint(path, distance) {
  const index = path.findIndex((sample) => sample.total > distance);
  if (index < 1) return path.at(-1).point;
  const { point: a, total: low } = path[index - 1];
  const { point: b, total: high } = path[index];
  const mix = (distance - low) / (high - low);
  return [a[0] * (1 - mix) + b[0] * mix, a[1] * (1 - mix) + b[1] * mix, 0];
}

export function cyclorama() {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const bright = [.074, .125, .150];
  const dark = [.015, .041, .060];
  const courses = [[-.013, 2.6, 0, bright], [-.013, .16, 0, bright], [-.013, -.24, 0, dark]];
  for (let i = 1; i <= 22; i++) {
    const angle = Math.PI / 2 * i / 22;
    const tint = .22 * Math.sin(angle);
    courses.push([-.013 + .55 * (1 - Math.cos(angle)), -.24 - .55 * Math.sin(angle), angle,
      dark.map((x, j) => x + tint * (bright[j] - x))]);
  }
  courses.push([2.4, -.79, Math.PI / 2, dark]);
  for (const [i, [y, z, angle, tint]] of courses.entries()) {
    for (const side of [-1, 1]) {
      positions.push(side * 2.8, y, z);
      normals.push(0, Math.cos(angle), Math.sin(angle));
      colors.push(...tint);
    }
    if (i) {
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  return { positions, normals, indices, colors };
}