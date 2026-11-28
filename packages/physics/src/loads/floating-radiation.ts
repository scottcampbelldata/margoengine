// Wave radiation for `floating` (SEA-12, P12 point 2): a floating body that moves makes waves, and the waves carry its
// energy away, so a dropped body's heave and roll die out as a model test's do. Each wet part of the body is panelled
// (sphere, box, capsule, cylinder, cone at their own shape; a hull or mesh refined from its own triangles), and the
// SEA-08 three-dimensional panel method (`bakeHullPanels`, linear potential flow with the free-surface Green function)
// gives its 6 x 6 added mass and damping at the body's still-water draft over a band of frequencies. The coupled
// passive fit (Cummins 1962; Perez and Fossen 2008) turns them into the causal radiation memory the LoadSolver steps.
// Parts are baked one by one at the whole body's waterline: their waves do not interact (a compound of separate floats
// is slightly off where its parts are close; one collider, the usual case, is exact to the panel method).
import { stillWaterline } from '../seakeeping/memory.js';
import { type HullMesh, wettedLoads } from '../seakeeping/wetted.js';
import { invalidLoad } from './errors.js';
import { coupledRadiationProfile, type LoadCoupledRadiationProfile } from './radiation-coupled-profile.js';

type Vec3 = [number, number, number];
type Quat = readonly [number, number, number, number];

/** How finely {@link floating} resolves a body's waves: `'fast'` (default), `'fine'` or `'none'`. */
export type FloatingRadiation = 'fast' | 'fine' | 'none';

/** Panel budget and frequency count of each radiation tier. */
export const FLOATING_RADIATION_TIERS = {
  /** About 80 wet panels and 12 frequencies: a second or so a body; heave damping within 3 % of the fine tier's. */
  fast: { panels: 80, frequencies: 12 },
  /** About 320 wet panels and 24 frequencies: tens of seconds a body; the reference. */
  fine: { panels: 320, frequencies: 24 },
} as const;

/** One part as a closed mesh in the body's frame, and the surface it should be panelled as. */
export interface RadiationPart {
  /** Closed outward mesh in the body's frame, panelled at edge `h` by `mesh(h)`. */
  readonly mesh: (edge: number) => {
    vertices: Float64Array;
    indices: Uint32Array;
  };
}

/**
 * The coupled radiation of every part of one body, in the body's frame about its centre of mass: `undefined` for a part
 * that is dry or wholly under the water at the body's still-water draft (a wholly sunk part keeps its added mass).
 */
export async function bodyRadiation(
  parts: readonly RadiationPart[],
  mass: number,
  com: readonly [number, number, number],
  rotation: Quat,
  density: number,
  tier: Exclude<FloatingRadiation, 'none'>,
  gravity: number,
  signal: AbortSignal | undefined,
): Promise<(LoadCoupledRadiationProfile | undefined)[]> {
  if (!(mass > 0 && Number.isFinite(mass)))
    throw invalidLoad(
      "A floating body with radiation needs a finite positive mass; give it one, or use radiation: 'none'.",
    );
  if (!(gravity > 0 && Number.isFinite(gravity)))
    throw invalidLoad('Use a finite positive gravity in m/s² for the radiation bake.');
  const { panels, frequencies: count } = FLOATING_RADIATION_TIERS[tier];
  // The body's attitude now is the one it floats at: its frame turned into the world's axes about its origin.
  const placed = (mesh: { vertices: Float64Array; indices: Uint32Array }) => {
    const v = mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const p = rotate(rotation, v[i]!, v[i + 1]!, v[i + 2]!);
      v[i] = p[0];
      v[i + 1] = p[1];
      v[i + 2] = p[2];
    }
    return mesh;
  };
  // A first, coarse panelling finds the draft and the wet area that sets the edge length for the panel budget.
  const coarse = parts.map((part) => placed(part.mesh(Infinity)));
  if (!(volume(join(coarse)) * density > mass))
    throw invalidLoad("This body is too heavy to float, so it makes no surface waves; use radiation: 'none'.");
  const waterline = stillWaterline(join(coarse), mass, density);
  let wetArea = 0;
  for (const mesh of coarse) wetArea += wet(mesh, waterline).area;
  if (!(wetArea > 0)) throw invalidLoad('This body has no wet surface at its draft; place it in the water.');
  const edge = Math.sqrt((4 * wetArea) / (Math.sqrt(3) * panels));
  const meshes = parts.map((part) => placed(part.mesh(edge)));
  const all = join(meshes);
  const level = stillWaterline(all, mass, density);
  let wetEdge = 0;
  for (const mesh of meshes) wetEdge = Math.max(wetEdge, longestWetEdge(mesh, level));
  // The panel method needs each edge within an eighth of the shortest wave; the band runs 40 times down from there.
  const top = Math.PI / 4 / wetEdge / (1 + 1e-9),
    frequencies = Array.from({ length: count }, (_, i) => Math.sqrt(gravity * top * 40 ** (i / (count - 1) - 1)));
  const centre = rotate(rotation, com[0], com[1], com[2]);
  const out: (LoadCoupledRadiationProfile | undefined)[] = [];
  for (const mesh of meshes) {
    signal?.throwIfAborted();
    const part = wet(mesh, level),
      total = volume(mesh);
    // A dry part makes no waves; a wholly sunk one keeps the deep-water added mass of its shape.
    if (!(part.volume > 1e-9 * total) || part.volume >= total * (1 - 1e-9)) {
      out.push(undefined);
      continue;
    }
    const profile = await coupledRadiationProfile(mesh, {
      mass: part.volume * density,
      centre,
      density,
      panels: { frequencies, gravity },
      signal,
    });
    out.push(toBody(profile, rotation, com));
  }
  return out;
}

/** The profile baked in the attitude frame, turned back into the body's frame (v_world = R v_body). */
function toBody(
  profile: LoadCoupledRadiationProfile,
  q: Quat,
  com: readonly [number, number, number],
): LoadCoupledRadiationProfile {
  const r = matrix(q),
    // Q = diag(R, R); the body-frame inertia is Q^T M Q and a body-frame direction Q^T d.
    big = (i: number, j: number) => (i < 3 === j < 3 ? r[i % 3]![j % 3]! : 0),
    m = profile.infiniteMass,
    infiniteMass = new Array<number>(36).fill(0);
  for (let a = 0; a < 6; a++)
    for (let b = 0; b < 6; b++) {
      let sum = 0;
      for (let i = 0; i < 6; i++) {
        const left = big(i, a);
        if (left === 0) continue;
        for (let j = 0; j < 6; j++) sum += left * m[6 * i + j]! * big(j, b);
      }
      infiniteMass[6 * a + b] = sum;
    }
  for (let a = 0; a < 6; a++)
    for (let b = a + 1; b < 6; b++)
      infiniteMass[6 * a + b] = infiniteMass[6 * b + a] = (infiniteMass[6 * a + b]! + infiniteMass[6 * b + a]!) / 2;
  const resonances = profile.resonances.map((mode) => {
    const d = mode.direction,
      direction = [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number];
    for (let a = 0; a < 6; a++) for (let i = 0; i < 6; i++) direction[a] += big(i, a) * d[i]!;
    return { ...mode, direction };
  });
  return {
    ...profile,
    centre: [com[0], com[1], com[2]],
    infiniteMass,
    resonances,
  };
}

/** Volume below the level and wet area of a closed mesh in world-aligned axes. */
function wet(mesh: HullMesh, level: number): { volume: number; area: number } {
  const loads = {
    force: [0, 0, 0] as Vec3,
    torque: [0, 0, 0] as Vec3,
    area: 0,
  };
  wettedLoads(
    mesh,
    { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    { elevation: () => level, pressure: (_x, y) => Math.max(0, level - y) },
    0,
    [0, 0, 0],
    loads,
  );
  return { volume: loads.force[1], area: loads.area };
}

function longestWetEdge(mesh: HullMesh, level: number): number {
  const v = mesh.vertices,
    ix = mesh.indices;
  let longest = 0;
  for (let t = 0; t < ix.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = 3 * ix[t + k]!,
        b = 3 * ix[t + ((k + 1) % 3)]!;
      if (Math.min(v[a + 1]!, v[b + 1]!) >= level) continue;
      longest = Math.max(longest, Math.hypot(v[a]! - v[b]!, v[a + 1]! - v[b + 1]!, v[a + 2]! - v[b + 2]!));
    }
  return longest;
}

function join(meshes: readonly { vertices: Float64Array; indices: Uint32Array }[]): HullMesh {
  let vertices = 0,
    indices = 0;
  for (const m of meshes) {
    vertices += m.vertices.length;
    indices += m.indices.length;
  }
  const v = new Float64Array(vertices),
    ix = new Uint32Array(indices);
  let at = 0,
    ti = 0;
  for (const m of meshes) {
    v.set(m.vertices, at);
    for (let i = 0; i < m.indices.length; i++) ix[ti + i] = m.indices[i]! + at / 3;
    at += m.vertices.length;
    ti += m.indices.length;
  }
  return { vertices: v, indices: ix };
}

// ---- Panel meshes of the collider shapes, closed and wound outward, edges near `edge` (Infinity: the coarsest). ----

/**
 * A surface of revolution about Y from a profile of [radius, height] points, bottom to top, `around` sides. A point of
 * radius 0 (a pole) is one vertex with a fan, so the mesh is closed and has no repeated corner.
 */
function revolve(
  profile: readonly (readonly [number, number])[],
  around: number,
): { vertices: Float64Array; indices: Uint32Array } {
  const vertices: number[] = [],
    indices: number[] = [],
    first: number[] = [],
    // sin(pi) is not 0 in floating point: a radius this small is a pole.
    widest = Math.max(...profile.map(([r]) => r));
  profile = profile.map(([r, y]) => [r <= 1e-12 * widest ? 0 : r, y] as const);
  for (const [r, y] of profile) {
    first.push(vertices.length / 3);
    if (r === 0) vertices.push(0, y, 0);
    else
      for (let j = 0; j < around; j++) {
        const phi = (2 * Math.PI * j) / around;
        vertices.push(r * Math.cos(phi), y, r * Math.sin(phi));
      }
  }
  const at = (i: number, j: number) => (profile[i]![0] === 0 ? first[i]! : first[i]! + (j % around));
  for (let i = 0; i + 1 < profile.length; i++)
    for (let j = 0; j < around; j++) {
      const a = at(i, j),
        b = at(i, j + 1),
        c = at(i + 1, j),
        d = at(i + 1, j + 1);
      // phi turns from +x toward +z, so (a, c, d) and (a, d, b) face out of the axis; a pole drops one of them.
      if (c !== d) indices.push(a, c, d);
      if (a !== b) indices.push(a, d, b);
    }
  return outward({
    vertices: Float64Array.from(vertices),
    indices: Uint32Array.from(indices),
  });
}

const steps = (length: number, edge: number, least: number) => Math.max(least, Math.ceil(length / edge));

/** A sphere of `radius` at the origin. */
export function sphereMesh(radius: number, edge: number) {
  const rings = steps(Math.PI * radius, edge, 6);
  return scaled(
    (4 / 3) * Math.PI * radius ** 3,
    1,
    revolve(
      Array.from(
        { length: rings + 1 },
        (_, i) => [radius * Math.sin((Math.PI * i) / rings), -radius * Math.cos((Math.PI * i) / rings)] as const,
      ),
      2 * rings,
    ),
  );
}

/** A capsule of `radius` whose straight part runs from -halfHeight to +halfHeight along Y. */
export function capsuleMesh(radius: number, halfHeight: number, edge: number) {
  const cap = steps((Math.PI / 2) * radius, edge, 3),
    side = steps(2 * halfHeight, edge, 1),
    profile: [number, number][] = [];
  for (let i = 0; i <= cap; i++) {
    const a = (Math.PI / 2) * (i / cap);
    profile.push([radius * Math.sin(a), -halfHeight - radius * Math.cos(a)]);
  }
  for (let i = 1; i < side; i++) profile.push([radius, -halfHeight + (2 * halfHeight * i) / side]);
  for (let i = 0; i <= cap; i++) {
    const a = (Math.PI / 2) * (i / cap);
    profile.push([radius * Math.cos(a), halfHeight + radius * Math.sin(a)]);
  }
  return scaled(
    Math.PI * radius * radius * ((4 / 3) * radius + 2 * halfHeight),
    1,
    revolve(profile, Math.max(12, 4 * cap)),
  );
}

/** A cylinder (or a cone, apex at +halfHeight) along Y. */
export function roundPanelMesh(radius: number, halfHeight: number, cone: boolean, edge: number) {
  const around = steps(2 * Math.PI * radius, edge, 12),
    radial = steps(radius, edge, 1),
    profile: [number, number][] = [];
  for (let i = 0; i <= radial; i++) profile.push([(radius * i) / radial, -halfHeight]);
  if (cone) {
    const slant = steps(Math.hypot(radius, 2 * halfHeight), edge, 2);
    for (let i = 1; i <= slant; i++)
      profile.push([radius * (1 - i / slant), -halfHeight + (2 * halfHeight * i) / slant]);
  } else {
    const side = steps(2 * halfHeight, edge, 1);
    for (let i = 1; i <= side; i++) profile.push([radius, -halfHeight + (2 * halfHeight * i) / side]);
    for (let i = radial - 1; i >= 0; i--) profile.push([(radius * i) / radial, halfHeight]);
  }
  // Its heights are exact: widen it so its sections keep the circle's area.
  return scaled(Math.PI * radius * radius * 2 * halfHeight * (cone ? 1 / 3 : 1), 0, revolve(profile, around));
}

/**
 * The inscribed polyhedron holds less water than the shape, so it would float high and radiate wrongly: scale it about its
 * axis's origin to the shape's own volume, uniformly (`vertical` 1) or across Y only (`vertical` 0).
 */
function scaled(exact: number, vertical: 0 | 1, mesh: { vertices: Float64Array; indices: Uint32Array }) {
  const across = (exact / volume(mesh)) ** (vertical ? 1 / 3 : 1 / 2),
    v = mesh.vertices;
  for (let i = 0; i < v.length; i += 3) {
    v[i]! *= across;
    if (vertical) v[i + 1]! *= across;
    v[i + 2]! *= across;
  }
  return mesh;
}

/** A box of half extents [x, y, z], each face a grid. */
export function boxMesh([x, y, z]: readonly [number, number, number], edge: number) {
  const n = [steps(2 * x, edge, 1), steps(2 * y, edge, 1), steps(2 * z, edge, 1)],
    half = [x, y, z],
    vertices: number[] = [],
    indices: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3,
        w = (axis + 2) % 3,
        base = vertices.length / 3;
      for (let i = 0; i <= n[u]!; i++)
        for (let j = 0; j <= n[w]!; j++) {
          const p = [0, 0, 0];
          p[axis] = sign * half[axis]!;
          p[u] = -half[u]! + (2 * half[u]! * i) / n[u]!;
          p[w] = -half[w]! + (2 * half[w]! * j) / n[w]!;
          vertices.push(p[0]!, p[1]!, p[2]!);
        }
      for (let i = 0; i < n[u]!; i++)
        for (let j = 0; j < n[w]!; j++) {
          const a = base + i * (n[w]! + 1) + j,
            b = a + n[w]! + 1;
          // u x w is +axis, so this winding faces +axis; the -axis face is flipped.
          if (sign > 0) indices.push(a, b, b + 1, a, b + 1, a + 1);
          else indices.push(a, b + 1, b, a, a + 1, b + 1);
        }
    }
  return outward({
    vertices: Float64Array.from(vertices),
    indices: Uint32Array.from(indices),
  });
}

/**
 * A hull's or mesh's own triangles as panels near `edge`: split in four (uniformly, so it stays closed) until its edges
 * reach `edge`, or, when it has more triangles than the panel budget allows (a detailed model), re-panelled as the star
 * its surface makes from its centroid: an ellipsoidal grid of its bounding box cast out to the surface and scaled to the
 * mesh's own volume. A convex hull is a star from its centroid, so this is the hull at panel resolution.
 */
export function ownPanelMesh(mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> }, edge: number) {
  if (edge === Infinity)
    return {
      vertices: Float64Array.from(mesh.vertices),
      indices: Uint32Array.from(mesh.indices),
    };
  let area = 0;
  const v = mesh.vertices,
    ix = mesh.indices;
  for (let t = 0; t < ix.length; t += 3) {
    const a = 3 * ix[t]!,
      b = 3 * ix[t + 1]!,
      c = 3 * ix[t + 2]!,
      ux = v[b]! - v[a]!,
      uy = v[b + 1]! - v[a + 1]!,
      uz = v[b + 2]! - v[a + 2]!,
      wx = v[c]! - v[a]!,
      wy = v[c + 1]! - v[a + 1]!,
      wz = v[c + 2]! - v[a + 2]!;
    area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  }
  const allowed = 1.25 * (area / ((Math.sqrt(3) / 4) * edge * edge)) + 32;
  return ix.length / 3 > allowed ? starMesh(mesh, edge) : refinedMesh(mesh, edge, allowed);
}

function refinedMesh(mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> }, edge: number, budget: number) {
  let vertices = Array.from(mesh.vertices),
    indices = Array.from(mesh.indices);
  // Bounded: each round quadruples the triangles and stops at the panel budget.
  for (let round = 0; round < 8; round++) {
    let longest = 0;
    for (let t = 0; t < indices.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const a = 3 * indices[t + k]!,
          b = 3 * indices[t + ((k + 1) % 3)]!;
        longest = Math.max(
          longest,
          Math.hypot(
            vertices[a]! - vertices[b]!,
            vertices[a + 1]! - vertices[b + 1]!,
            vertices[a + 2]! - vertices[b + 2]!,
          ),
        );
      }
    if (longest <= edge || (indices.length / 3) * 4 > budget) break;
    const middle = new Map<number, number>(),
      count = vertices.length / 3,
      next: number[] = [];
    const mid = (a: number, b: number) => {
      const key = Math.min(a, b) * count + Math.max(a, b);
      let at = middle.get(key);
      if (at === undefined) {
        at = vertices.length / 3;
        vertices.push(
          (vertices[3 * a]! + vertices[3 * b]!) / 2,
          (vertices[3 * a + 1]! + vertices[3 * b + 1]!) / 2,
          (vertices[3 * a + 2]! + vertices[3 * b + 2]!) / 2,
        );
        middle.set(key, at);
      }
      return at;
    };
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!],
        ab = mid(a, b),
        bc = mid(b, c),
        ca = mid(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    indices = next;
  }
  return {
    vertices: Float64Array.from(vertices),
    indices: Uint32Array.from(indices),
  };
}

/** The star a closed mesh makes from its vertex centroid, panelled near `edge` and scaled to the mesh's volume. */
function starMesh(mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> }, edge: number) {
  const v = mesh.vertices,
    ix = mesh.indices,
    low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3)
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k]!, v[i + k]!);
      high[k] = Math.max(high[k]!, v[i + k]!);
    }
  const centre = [0, 1, 2].map((k) => (low[k]! + high[k]!) / 2) as Vec3,
    half = [0, 1, 2].map((k) => (high[k]! - low[k]!) / 2) as Vec3,
    grid = sphereGrid(steps(Math.PI * Math.max(...half), edge, 6));
  const out = grid.vertices;
  for (let i = 0; i < out.length; i += 3) {
    // The ray from the centre through the ellipsoid's point, out to its farthest crossing of the surface.
    const d: Vec3 = [out[i]! * half[0], out[i + 1]! * half[1], out[i + 2]! * half[2]];
    let far = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const hit = rayTriangle(centre, d, v, 3 * ix[t]!, 3 * ix[t + 1]!, 3 * ix[t + 2]!);
      if (hit > far) far = hit;
    }
    for (let k = 0; k < 3; k++) out[i + k] = centre[k]! + far * d[k]!;
  }
  const own = volume({
      vertices: Float64Array.from(v),
      indices: Uint32Array.from(ix),
    }),
    scale = Math.cbrt(own / volume(grid));
  for (let i = 0; i < out.length; i += 3)
    for (let k = 0; k < 3; k++) out[i + k] = centre[k]! + (out[i + k]! - centre[k]!) * scale;
  return grid;
}

/** A unit sphere of `rings` rings, closed, poles as single vertices. */
function sphereGrid(rings: number) {
  return revolve(
    Array.from(
      { length: rings + 1 },
      (_, i) => [Math.sin((Math.PI * i) / rings), -Math.cos((Math.PI * i) / rings)] as const,
    ),
    2 * rings,
  );
}

/** Where the ray o + t d crosses triangle (a, b, c) of `v`, as t (Moller and Trumbore 1997), or 0 when it misses. */
function rayTriangle(o: Vec3, d: Vec3, v: ArrayLike<number>, a: number, b: number, c: number): number {
  const e1 = [v[b]! - v[a]!, v[b + 1]! - v[a + 1]!, v[b + 2]! - v[a + 2]!],
    e2 = [v[c]! - v[a]!, v[c + 1]! - v[a + 1]!, v[c + 2]! - v[a + 2]!],
    p = [d[1] * e2[2]! - d[2] * e2[1]!, d[2] * e2[0]! - d[0] * e2[2]!, d[0] * e2[1]! - d[1] * e2[0]!],
    det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
  if (Math.abs(det) < 1e-300) return 0;
  const s = [o[0] - v[a]!, o[1] - v[a + 1]!, o[2] - v[a + 2]!],
    u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) / det;
  if (u < 0 || u > 1) return 0;
  const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!],
    w = (d[0] * q[0]! + d[1] * q[1]! + d[2] * q[2]!) / det;
  if (w < 0 || u + w > 1) return 0;
  const t = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det;
  return t > 0 ? t : 0;
}

/** A closed mesh's signed volume (positive when wound outward), by the divergence theorem. */
function volume(mesh: HullMesh): number {
  const v = mesh.vertices,
    ix = mesh.indices;
  let six = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = 3 * ix[t]!,
      b = 3 * ix[t + 1]!,
      c = 3 * ix[t + 2]!;
    six +=
      v[a]! * (v[b + 1]! * v[c + 2]! - v[b + 2]! * v[c + 1]!) -
      v[a + 1]! * (v[b]! * v[c + 2]! - v[b + 2]! * v[c]!) +
      v[a + 2]! * (v[b]! * v[c + 1]! - v[b + 1]! * v[c]!);
  }
  return six / 6;
}

/** Flip the winding when the signed volume is negative, so the normals face out. */
function outward(mesh: { vertices: Float64Array; indices: Uint32Array }) {
  const ix = mesh.indices;
  if (volume(mesh) < 0)
    for (let t = 0; t < ix.length; t += 3) {
      const s = ix[t + 1]!;
      ix[t + 1] = ix[t + 2]!;
      ix[t + 2] = s;
    }
  return mesh;
}

function matrix(q: Quat): [Vec3, Vec3, Vec3] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function rotate(q: Quat, x: number, y: number, z: number): Vec3 {
  const tx = 2 * (q[1] * z - q[2] * y),
    ty = 2 * (q[2] * x - q[0] * z),
    tz = 2 * (q[0] * y - q[1] * x);
  return [
    x + q[3] * tx + (q[1] * tz - q[2] * ty),
    y + q[3] * ty + (q[2] * tx - q[0] * tz),
    z + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
}
