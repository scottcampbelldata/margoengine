// Builds the gym in code from wall.ts: plywood panels, T-nuts, volumes, holds cut from fractured shapes, mat, room and the
// skylight. No textures and no downloads. Everything of one colour merges into one mesh, so the gym is a few draws.
import { Geometry, sphere, box as boxGeometry } from 'margoengine';
import { convexGeometry } from '@margoengine/geometry/extras';
import { fractureMesh } from '@margoengine/procedural/voronoi';
import {
  COLOURS,
  MAT_TOP,
  surface,
  VOLUMES,
  WALL_HALF_WIDTH,
  WALL_LENGTH,
  wallSlabs,
  type Hold,
  type Point,
} from './wall.ts';

/** The room: x from -ROOM.x to ROOM.x, z from ROOM.back to ROOM.front, y from 0 to ROOM.y. */
export const ROOM = { x: 4.4, y: 5, front: 7, back: -0.3 };
/** The skylight's opening in the ceiling. */
export const SKYLIGHT = { x: 1.7, zMin: 1.6, zMax: 4.2 };
/** The direction toward the sun, through the skylight onto the overhang. */
export const SUN: Point = [0.3, 0.82, 0.55];
export const EGG = 'Margo engine ❤️ made for Margie';
/** Where the plaque with the dedication sits: low on the wall, right of the routes. */
export const PLAQUE = { x: 2.28, y: 0.36, width: 0.62, height: 0.14 };

class Builder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  private vertex(p: readonly number[], n: readonly number[]): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    return this.positions.length / 3 - 1;
  }
  /** A flat quad, corners in order around the normal it should have. */
  quad(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): this {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = d[0] - a[0],
      vy = d[1] - a[1],
      vz = d[2] - a[2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      l = Math.hypot(nx, ny, nz) || 1,
      n = [nx / l, ny / l, nz / l],
      i = this.vertex(a, n);
    this.vertex(b, n);
    this.vertex(c, n);
    this.vertex(d, n);
    this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    return this;
  }
  /** A box from its eight corners listed by x, then the two ends, then the two depths, as wallSlabs writes them. */
  corners(c: readonly number[]): this {
    const p = (i: number) => [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
    // Indices: bit 2 is x, bit 1 the far end, bit 0 behind the face.
    this.quad(p(0), p(4), p(6), p(2));
    this.quad(p(1), p(3), p(7), p(5));
    this.quad(p(0), p(2), p(3), p(1));
    this.quad(p(4), p(5), p(7), p(6));
    this.quad(p(2), p(6), p(7), p(3));
    this.quad(p(0), p(1), p(5), p(4));
    return this;
  }
  /** An axis-aligned box. */
  box(min: readonly number[], max: readonly number[]): this {
    const c: number[] = [];
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]]) for (const z of [max[2], min[2]]) c.push(x, y, z);
    return this.corners(c);
  }
  /** Copies triangles with a transform: position = origin + x * px + y * py + z * pz; normals by the same basis. */
  add(
    vertices: ArrayLike<number>,
    indices: ArrayLike<number>,
    origin: readonly number[],
    x: readonly number[],
    y: readonly number[],
    z: readonly number[],
  ): this {
    const base = this.positions.length / 3;
    for (let i = 0; i < vertices.length; i += 6) {
      const px = vertices[i],
        py = vertices[i + 1],
        pz = vertices[i + 2],
        nx = vertices[i + 3],
        ny = vertices[i + 4],
        nz = vertices[i + 5];
      this.positions.push(
        origin[0] + x[0] * px + y[0] * py + z[0] * pz,
        origin[1] + x[1] * px + y[1] * py + z[1] * pz,
        origin[2] + x[2] * px + y[2] * py + z[2] * pz,
      );
      const wx = x[0] * nx + y[0] * ny + z[0] * nz,
        wy = x[1] * nx + y[1] * ny + z[1] * nz,
        wz = x[2] * nx + y[2] * ny + z[2] * nz,
        l = Math.hypot(wx, wy, wz) || 1;
      this.normals.push(wx / l, wy / l, wz / l);
    }
    for (let i = 0; i < indices.length; i++) this.indices.push(base + indices[i]);
    return this;
  }
  build(): Geometry {
    return new Geometry(this.positions, this.normals, this.indices);
  }
}

// The dedication as raised dots: a 5 by 7 font holding only the letters it needs.
const FONT: Record<string, string> = {
  M: '10001 11011 10101 10101 10001 10001 10001',
  a: '00000 00000 01110 00001 01111 10001 01111',
  r: '00000 00000 10110 11001 10000 10000 10000',
  g: '00000 01111 10001 10001 01111 00001 01110',
  o: '00000 00000 01110 10001 10001 10001 01110',
  e: '00000 00000 01110 10001 11111 10000 01110',
  n: '00000 00000 10110 11001 10001 10001 10001',
  i: '00100 00000 01100 00100 00100 00100 01110',
  m: '00000 00000 11010 10101 10101 10001 10001',
  d: '00001 00001 01101 10011 10001 10001 01111',
  f: '00110 01001 01000 11100 01000 01000 01000',
};
const HEART = '00000 01010 11111 11111 01110 00100 00000';

/** Dots of the plaque's text at (x, y) on the wall's face, returned as text and heart geometry. */
function plaqueText(z: number): { text: Geometry; heart: Geometry } {
  const line = 'Margo engine # made for Margie',
    dot = 0.0031,
    pitch = dot * 1.25,
    advance = pitch * 6,
    left = PLAQUE.x - (line.length * advance) / 2,
    text = new Builder(),
    heart = new Builder(),
    top = PLAQUE.y + pitch * 3.5;
  [...line].forEach((ch, i) => {
    const rows = (ch === '#' ? HEART : (FONT[ch] ?? '')).split(' ');
    rows.forEach((row, ry) =>
      [...row].forEach((on, rx) => {
        if (on !== '1') return;
        const x = left + i * advance + rx * pitch,
          y = top - ry * pitch;
        (ch === '#' ? heart : text).quad([x, y, z], [x + dot, y, z], [x + dot, y + dot, z], [x, y + dot, z]);
      }),
    );
  });
  return { text: text.build(), heart: heart.build() };
}

/** The wall's holds, cut from fractured spheres and boxes, as one Builder per colour. */
function holdGeometry(holds: readonly Hold[]): Builder[] {
  const chunks = [
    ...fractureMesh(sphere(1, 20), 6, { seed: 11 }),
    ...fractureMesh(boxGeometry(1.7, 1.7, 1.7), 6, { seed: 5 }),
  ].map(({ geometry, center }) => {
    // Recentre each chunk and scale it to a unit radius.
    const v = Float32Array.from(geometry.vertices);
    let radius = 0;
    for (let i = 0; i < v.length; i += 6) {
      v[i] -= center[0];
      v[i + 1] -= center[1];
      v[i + 2] -= center[2];
      radius = Math.max(radius, Math.hypot(v[i], v[i + 1], v[i + 2]));
    }
    for (let i = 0; i < v.length; i += 6) {
      v[i] /= radius;
      v[i + 1] /= radius;
      v[i + 2] /= radius;
    }
    return { vertices: v, indices: geometry.indices };
  });
  const builders = COLOURS.map(() => new Builder());
  for (const hold of holds) {
    const chunk = chunks[hold.shape % chunks.length],
      n = hold.normal,
      r = hold.radius * 1.35,
      c = Math.cos(hold.turn),
      s = Math.sin(hold.turn),
      // Wall tangents: across and up the wall, turned about the normal. A chunk is a sliver of its shape, so it is drawn
      // a little larger than the pick radius.
      up = [0, n[2], -n[1]],
      x = [c * r, s * r * up[1], s * r * up[2]],
      y = [-s * r, c * r * up[1], c * r * up[2]],
      // Squashed against the wall.
      z = [n[0] * r * 0.62, n[1] * r * 0.62, n[2] * r * 0.62];
    builders[hold.colour].add(chunk.vertices, chunk.indices, hold.position, x, y, z);
  }
  return builders;
}

/** One gym mesh's look and geometry; main.ts turns these into stage meshes, so this file needs no stage. */
export interface GymPart {
  name: string;
  geometry: Geometry;
  color: string;
  roughness: number;
  metalness?: number;
  /** False for a part that only receives shadows. */
  casts: boolean;
}

/** All of the gym's meshes. Pure apart from building geometry; the same on every load. */
export function buildGym(holds: readonly Hold[]): GymPart[] {
  const parts: GymPart[] = [];
  const part = (name: string, geometry: Geometry, color: string, roughness: number, casts = true, metalness = 0) =>
    parts.push({ name, geometry, color, roughness, casts, metalness });

  const slabs = wallSlabs(),
    lower = new Builder().corners(slabs[0]),
    upper = new Builder().corners(slabs[1]).corners(slabs[2]);
  part('wall', lower.build(), '#c7a678', 0.72);
  part('overhang', upper.build(), '#b9976b', 0.72);

  // Panel seams and T-nuts: dark marks a hair proud of the wall.
  const marks = new Builder(),
    p: Point = [0, 0, 0],
    n: Point = [0, 0, 0],
    size = 0.009;
  for (let s = 0.1; s < WALL_LENGTH; s += 0.2)
    for (let x = -WALL_HALF_WIDTH + 0.1; x < WALL_HALF_WIDTH; x += 0.2) {
      surface(x, s, p, n);
      const ox = p[0],
        oy = p[1] + n[1] * 0.002,
        oz = p[2] + n[2] * 0.002,
        uy = n[2],
        uz = -n[1];
      marks.quad(
        [ox - size, oy - uy * size, oz - uz * size],
        [ox + size, oy - uy * size, oz - uz * size],
        [ox + size, oy + uy * size, oz + uz * size],
        [ox - size, oy + uy * size, oz + uz * size],
      );
    }
  for (let x = -WALL_HALF_WIDTH + 1.35; x < WALL_HALF_WIDTH; x += 1.35)
    for (let s = 0; s < WALL_LENGTH - 0.05; s += 0.05) {
      surface(x, s, p, n);
      const near = [...p],
        far = surface(x, s + 0.05, [0, 0, 0]),
        w = 0.003;
      marks.quad(
        [near[0] - w, near[1] + n[1] * 0.002, near[2] + n[2] * 0.002],
        [near[0] + w, near[1] + n[1] * 0.002, near[2] + n[2] * 0.002],
        [far[0] + w, far[1] + n[1] * 0.002, far[2] + n[2] * 0.002],
        [far[0] - w, far[1] + n[1] * 0.002, far[2] + n[2] * 0.002],
      );
    }
  part('marks', marks.build(), '#3a3027', 0.8, false);

  const volumes = new Builder();
  for (const volume of VOLUMES) {
    const data = convexGeometry(volume.corners);
    const interleaved = new Float32Array((data.positions.length / 3) * 6);
    for (let i = 0; i < data.positions.length / 3; i++) {
      interleaved.set(data.positions.subarray(i * 3, i * 3 + 3), i * 6);
      interleaved.set(data.normals.subarray(i * 3, i * 3 + 3), i * 6 + 3);
    }
    volumes.add(interleaved, data.indices, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  }
  part('volumes', volumes.build(), '#3f5a63', 0.6);

  holdGeometry(holds).forEach((b, i) => part(`holds ${i}`, b.build(), COLOURS[i], 0.55));

  const w = ROOM.x,
    room = new Builder();
  // Floor, walls and the ceiling round the skylight. The wall side is closed by the climbing wall itself.
  room.box([-w, -0.2, ROOM.back], [w, 0, ROOM.front]);
  room.box([-w - 0.2, 0, ROOM.back], [-w, ROOM.y, ROOM.front]);
  room.box([w, 0, ROOM.back], [w + 0.2, ROOM.y, ROOM.front]);
  room.box([-w, 0, ROOM.front], [w, ROOM.y, ROOM.front + 0.2]);
  room.box([-w, 0, ROOM.back], [w, ROOM.y, -0.15]);
  const { x: sx, zMin, zMax } = SKYLIGHT,
    ceiling = new Builder();
  ceiling.box([-w, ROOM.y, ROOM.back], [-sx, ROOM.y + 0.2, ROOM.front]);
  ceiling.box([sx, ROOM.y, ROOM.back], [w, ROOM.y + 0.2, ROOM.front]);
  ceiling.box([-sx, ROOM.y, ROOM.back], [sx, ROOM.y + 0.2, zMin]);
  ceiling.box([-sx, ROOM.y, zMax], [sx, ROOM.y + 0.2, ROOM.front]);
  part('room', room.build(), '#8b867c', 0.9);
  part('ceiling', ceiling.build(), '#d5d0c4', 0.9);
  const frame = new Builder();
  for (const x of [-sx * 0.33, sx * 0.33]) frame.box([x - 0.03, ROOM.y, zMin], [x + 0.03, ROOM.y + 0.14, zMax]);
  frame.box([-sx, ROOM.y, (zMin + zMax) / 2 - 0.03], [sx, ROOM.y + 0.14, (zMin + zMax) / 2 + 0.03]);
  part('skylight frame', frame.build(), '#2f3236', 0.5);

  // The mat, and a polished strip of floor in front of it that shows the wall.
  part('mat', new Builder().box([-WALL_HALF_WIDTH, 0, 0.02], [WALL_HALF_WIDTH, MAT_TOP, 2.2]).build(), '#26364a', 0.85);
  part('floor strip', new Builder().box([-w, 0, 2.2], [w, 0.004, 3.1]).build(), '#4b4a47', 0.14, false);

  // A chalk bucket on the mat.
  const bucket = new Builder(),
    cx = -2.2,
    cz = 1.1,
    sides = 18;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2,
      b = ((i + 1) / sides) * Math.PI * 2,
      r = 0.11,
      y0 = MAT_TOP,
      y1 = MAT_TOP + 0.2;
    bucket.quad(
      [cx + Math.sin(a) * r * 0.86, y0, cz + Math.cos(a) * r * 0.86],
      [cx + Math.sin(b) * r * 0.86, y0, cz + Math.cos(b) * r * 0.86],
      [cx + Math.sin(b) * r, y1, cz + Math.cos(b) * r],
      [cx + Math.sin(a) * r, y1, cz + Math.cos(a) * r],
    );
    bucket.quad(
      [cx + Math.sin(a) * r, y1, cz + Math.cos(a) * r],
      [cx + Math.sin(b) * r, y1, cz + Math.cos(b) * r],
      [cx, y1 - 0.03, cz],
      [cx, y1 - 0.03, cz],
    );
  }
  part('chalk bucket', bucket.build(), '#d9d4c7', 0.95);

  // The plaque: a small brass plate low on the wall, its dedication in raised dots.
  const z = 0.012,
    plate = new Builder().box(
      [PLAQUE.x - PLAQUE.width / 2, PLAQUE.y - PLAQUE.height / 2, 0],
      [PLAQUE.x + PLAQUE.width / 2, PLAQUE.y + PLAQUE.height / 2, z - 0.001],
    ),
    words = plaqueText(z);
  part('plaque', plate.build(), '#a9894c', 0.38, false, 0.85);
  part('plaque text', words.text, '#20201c', 0.6, false);
  part('plaque heart', words.heart, '#b3262e', 0.5, false);
  return parts;
}
