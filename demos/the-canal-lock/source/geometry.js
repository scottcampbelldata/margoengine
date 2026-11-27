import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { boxGeometry, cylinderGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';

export function place(geometry, [x, y, z], yaw = 0) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return applyMatrix4(geometry, [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1]);
}
export const box = (w, h, d, center, r = 0, yaw = 0) =>
  place(r ? roundedBoxGeometry(w, h, d, 1, r) : boxGeometry(w, h, d), center, yaw);
export const round = (r, h, center, sides = 12) => place(cylinderGeometry(r, r, h, sides, 1), center);
export const merge = pieces => mergeGeometries(pieces);
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

export function pigment(hex) {
  return Array.from({ length: 3 }, (_, i) => {
    const u = parseInt(hex.slice(i * 2 + 1, i * 2 + 3), 16) / 255;
    return u > .04045 ? ((u + .055) / 1.055) ** 2.4 : u / 12.92;
  });
}

export function rng(seed) {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
}

export class MeshData {
  data = { positions: [], normals: [], colors: [], indices: [] };
  vertex(p, n, c) {
    const result = this.data.positions.length / 3;
    this.data.positions.push(...p);
    this.data.normals.push(...n);
    this.data.colors.push(...c);
    return result;
  }
  shape(geometry, shade) {
    const start = this.data.positions.length / 3;
    for (let i = 0; i < geometry.positions.length; i += 3)
      this.vertex(geometry.positions.slice(i, i + 3), geometry.normals.slice(i, i + 3), shade);
    for (const index of geometry.indices) this.data.indices.push(start + index);
  }
  triangle(a, b, c, tint) {
    const [x, y, z] = b.map((v,i) => v - a[i]);
    const [u, v, w] = c.map((current,i) => current - a[i]);
    const face = [y * w - z * v, z * u - x * w, x * v - y * u];
    const length = Math.hypot(...face);
    if (length < 1e-10) return;
    const normal = face.map(value => value / length);
    this.data.indices.push(...[a,b,c].map(position => this.vertex(position, normal, tint)));
  }
  quad(a, b, c, d, color) {
    this.triangle(a,b,c,color);
    this.triangle(a,c,d,color);
  }
}

export function cyclorama() {
  const surface = new MeshData();
  const floor = pigment('#5b625c');
  const background = pigment('#303e40');
  const samples = [[-2.10, 130, 0, floor], [-2.10, 9, 0, floor], [-2.10, -12, 0, background]];
  for (let i = 1; i <= 18; i++) {
    const arc = i * Math.PI / 36;
    samples.push([-2.10 + 18 * (1 - Math.cos(arc)), -12 - 18 * Math.sin(arc), arc,
      mix(background, pigment('#4d5651'), Math.sin(arc) * .38)]);
  }
  samples.push([90, -30, Math.PI / 2, background]);
  for (const [i, [y,z,angle,color]] of samples.entries()) {
    for (const x of [-120,120]) surface.vertex([x,y,z], [0,Math.cos(angle),Math.sin(angle)], color);
    if (i) {
      const start = (i - 1) * 2;
      surface.data.indices.push(start,start+1,start+2,start+1,start+3,start+2);
    }
  }
  return surface.data;
}

export function waterSurface(from, to, halfWidth, seed) {
  const sky = pigment('#548e91');
  const deep = pigment('#3d6669');
  const out = new MeshData();
  const random = rng(seed);
  const rows = Math.ceil((to - from) * 2);
  const columns = 15;
  for (let i = 0; i <= rows; i++) {
    const x = from + (to - from) * i / rows;
    for (let j = 0; j <= columns; j++) {
      const z = -halfWidth + 2 * halfWidth * j / columns;
      const a = 1.52 * x + 2.45 * z;
      const b = 2.81 * x - 4.38 * z;
      const y = .010 * Math.sin(a) + .0043 * Math.sin(b);
      const nx = -.0152 * Math.cos(a) - .01208 * Math.cos(b);
      const nz = -.0245 * Math.cos(a) + .01883 * Math.cos(b);
      const n = 1 / Math.hypot(nx, 1, nz);
      const saturation = .38 + .36 * Math.sin(Math.PI * j / columns) + .12 * Math.sin(x * .68 - z) + .09 * random();
      const now = out.vertex([x,y,z], [nx*n,n,nz*n], mix(deep,sky,saturation));
      if (i && j) {
        const back = now - columns - 1;
        out.data.indices.push(back - 1, back, now, back - 1, now, now - 1);
      }
    }
  }
  return out.data;
}