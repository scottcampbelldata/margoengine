import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';

export const mix = (a, b, n) => a.map((value, i) => value + (b[i] - value) * n);
export const scale = (a, n) => a.map((value) => value * n);
const sub = (a, b) => a.map((value, i) => value - b[i]);
const cross = ([x, y, z], [a, b, c]) => [y * c - z * b, z * a - x * c, x * b - y * a];
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const unit = (a) => scale(a, 1 / Math.hypot(...a));

export function rgb(hex) {
  return Array.from({ length: 3 }, (_, i) => {
    const channel = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
}

export function randomFrom(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function placed(geometry, [x, y, z], rotation = 0) {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return applyMatrix4(geometry, [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

export function box(dimensions, center, bevel = .025, rotation = 0) {
  return placed(roundedBoxGeometry(...dimensions, 1, bevel), center, rotation);
}

export function pin(radius, height, center) {
  return placed(cylinderGeometry(radius, radius, height, 8, 1), center);
}

export class Surface {
  geometry = { positions: [], normals: [], colors: [], indices: [] };

  vertex(position, normal, color) {
    const index = this.geometry.positions.length / 3;
    this.geometry.positions.push(...position);
    this.geometry.normals.push(...normal);
    this.geometry.colors.push(...color);
    return index;
  }

  face(a, b, c, color, outward) {
    let normal = unit(cross(sub(b, a), sub(c, a)));
    if (outward && dot(normal, outward) < 0) {
      [b, c] = [c, b];
      normal = scale(normal, -1);
    }
    this.geometry.indices.push(...[a, b, c].map(point => this.vertex(point, normal, color)));
  }

  quad(a, b, c, d, color, outward) {
    this.face(a, b, c, color, outward);
    this.face(a, c, d, color, outward);
  }

  tube(points, radius, color, sides = 8) {
    const base = this.geometry.positions.length / 3;
    const vertical = Math.abs(points.at(-1)[1] - points[0][1]) > .95 * Math.hypot(...sub(points.at(-1), points[0]));
    const reference = vertical ? [1, 0, 0] : [0, 1, 0];
    for (const [i, point] of points.entries()) {
      const tangent = unit(sub(points[Math.min(i + 1, points.length - 1)], points[Math.max(i - 1, 0)]));
      const first = unit(cross(tangent, reference));
      const second = cross(tangent, first);
      for (let j = 0; j < sides; j++) {
        const angle = j * Math.PI * 2 / sides;
        const normal = first.map((value, k) => Math.cos(angle) * value + Math.sin(angle) * second[k]);
        this.vertex(point.map((value, k) => value + normal[k] * radius), normal, color);
        if (i) {
          const low = base + (i - 1) * sides + j;
          const next = base + (i - 1) * sides + (j + 1) % sides;
          this.geometry.indices.push(low, next, low + sides, next, next + sides, low + sides);
        }
      }
    }
    for (const i of [0, points.length - 1]) {
      const ring = base + i * sides;
      const pointsArray = this.geometry.positions;
      const normal = unit(sub(points[i], points[i === 0 ? 1 : i - 1]));
      for (let j = 0; j < sides; j++) {
        const a = (ring + j) * 3;
        const b = (ring + (j + 1) % sides) * 3;
        this.face(points[i], pointsArray.slice(a, a + 3), pointsArray.slice(b, b + 3), color, normal);
      }
    }
  }

  rigid(geometry, color) {
    const base = this.geometry.positions.length / 3;
    const { positions, normals, indices } = geometry;
    for (let index = 0; index < positions.length; index += 3) {
      this.vertex(positions.slice(index, index + 3), normals.slice(index, index + 3), color);
    }
    for (const index of indices) this.geometry.indices.push(base + index);
  }
}

export function batch(pieces) {
  return pieces.length === 1 ? pieces[0] : mergeGeometries(pieces);
}