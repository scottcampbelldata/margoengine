// Waterfront props for a cove scene: a wooden jetty and a small rowing boat. Our own shapes from primitives and a
// lofted hull; local origin at the water surface (y = 0), +Y up, metres. Both are seeded and deterministic.
import { boxGeometry, cylinderGeometry } from '@margoengine/geometry/primitives';
import {
  applyMatrix4,
  computeTangents,
  computeVertexNormals,
  mergeGeometries,
  type GeometryData,
} from '@margoengine/geometry/utils';
import { resolveDetail, type MeshDetail, type MeshDetailOptions } from './foliage.js';

/** Options for `generateJettyMesh`. Every option has a default, so `generateJettyMesh()` is a good-looking jetty. */
export interface JettyOptions extends MeshDetailOptions {
  /** Length from the shore end (x = 0) to the far end (x = length), metres, 4 to 120. Default 24. */
  length?: number;
  /** Deck width across z, metres, 1 to 8. Default 2.2. */
  width?: number;
  /** Deck height above the water surface (y = 0), metres, 0.3 to 4. Default 1.1. */
  height?: number;
  /** Adds a ladder down the +z side at the far end. Default true. */
  ladder?: boolean;
  /** Integer seed for plank widths, small height and angle differences and post lean. Default 1. */
  seed?: number;
}

/** Options for `generateBoatMesh`. Every option has a default, so `generateBoatMesh()` is a small rowing boat. */
export interface BoatOptions extends MeshDetailOptions {
  /** Hull length from stern (x = -length / 2) to bow (x = +length / 2), metres, 1.5 to 12. Default 3.6. */
  length?: number;
  /** Number of seats (thwarts), integer 0 to 4. Default 3. */
  seats?: number;
  /** Adds two oars resting in their oarlocks. Default true. */
  oars?: boolean;
  /** Integer seed for small differences in length, beam, seat positions and oar angle. Default 1. */
  seed?: number;
}

// mulberry32: a small seeded generator, enough for tiny variations.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function number(name: string, value: unknown, min: number, max: number, fallback: number, integer = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number') throw new TypeError(`Invalid ${name}; pass a number from ${min} to ${max}.`);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new RangeError(`Invalid ${name}; pass ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
  return value;
}

function flag(name: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`Invalid ${name}; pass true or false.`);
  return value;
}

function seedOf(options: { seed?: number }): number {
  if (options.seed === undefined) return 1;
  if (typeof options.seed !== 'number') throw new TypeError('Invalid seed; pass an integer.');
  if (!Number.isInteger(options.seed)) throw new RangeError('Invalid seed; pass an integer.');
  return options.seed;
}

function optionsOf<T extends object>(options: T | undefined, what: string): T {
  if (options === undefined) return {} as T;
  if (typeof options !== 'object' || options === null) throw new TypeError(`Invalid ${what} options; pass an object.`);
  return options;
}

/** Places `data` with a rotation (columns ex, ey, ez; unit length, right handed) and a translation. */
function basis(
  data: GeometryData,
  ex: readonly number[],
  ey: readonly number[],
  ez: readonly number[],
  at: readonly number[],
): GeometryData {
  return applyMatrix4(data, [...ex, 0, ...ey, 0, ...ez, 0, ...at, 1]);
}
const at = (data: GeometryData, x: number, y: number, z: number) =>
  basis(data, [1, 0, 0], [0, 1, 0], [0, 0, 1], [x, y, z]);
/** Turns a Y-axis cylinder to lie along X. */
const alongX = (data: GeometryData, x: number, y: number, z: number) =>
  basis(data, [0, 1, 0], [-1, 0, 0], [0, 0, 1], [x, y, z]);

/** Re-winds each triangle so its face normal has the sign `side` along the direction `toward(centroid)`. */
function wind(positions: number[], indices: number[], toward: (x: number, y: number, z: number) => number[], side = 1) {
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]],
      e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]],
      n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]],
      d = toward(
        (positions[a] + positions[b] + positions[c]) / 3,
        (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
        (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3,
      );
    if (side * (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) < 0)
      [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  }
}

/** Builds a smooth-normal mesh part from raw arrays, winding it with `toward`. */
function part(
  positions: number[],
  uvs: number[],
  indices: number[],
  toward: (x: number, y: number, z: number) => number[],
  side = 1,
): GeometryData {
  wind(positions, indices, toward, side);
  return computeVertexNormals({
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  });
}

/**
 * A wooden jetty: deck planks across the width, stringers and cross beams underneath, posts on both sides that stand
 * in the water (every fourth one, and the last, rises above the deck as a mooring post) and an optional ladder. Local
 * origin at the water surface under the shore end; the deck runs along +X at `height`, centred on z = 0. Render it
 * with a wood material; one mesh with UVs, tangents and unit normals.
 * `options.detail` (default 2) gives 2,768 triangles for the default 24 m jetty at 2 (planks 0.16 m wide with
 * gaps), 1,680 at 1 (planks 0.32 m wide, six-sided posts) and 508 at 0 (one deck slab, square posts, no stringers).
 * @throws TypeError when an option has the wrong type.
 * @throws RangeError when `length`, `width`, `height`, `seed` or `detail` is outside its range.
 */
export function generateJettyMesh(options?: JettyOptions): GeometryData {
  const o = optionsOf(options, 'jetty');
  const length = number('jetty length', o.length, 4, 120, 24),
    width = number('jetty width', o.width, 1, 8, 2.2),
    height = number('jetty height', o.height, 0.3, 4, 1.1),
    ladder = flag('jetty ladder', o.ladder, true),
    detail = resolveDetail(o),
    rand = random(seedOf(o) * 2654435761 + 17);
  const parts: GeometryData[] = [],
    plankT = 0.05,
    radial = [4, 6, 8][detail],
    beam = 0.1,
    stringerY = height - plankT - 0.06;
  // Deck planks, laid across the width from x = 0.
  if (detail === 0) parts.push(at(boxGeometry(length, plankT, width), length / 2, height - plankT / 2, 0));
  else {
    const board = detail === 2 ? 0.16 : 0.32,
      gap = detail === 2 ? 0.02 : 0;
    for (let x = 0; x < length - 0.05; ) {
      const w = Math.min(board * (0.9 + rand() * 0.2), length - x),
        run = width + 0.04 + rand() * 0.04,
        piece = boxGeometry(w, plankT, run);
      parts.push(at(piece, x + w / 2, height - plankT / 2 + (rand() - 0.5) * 0.008, (rand() - 0.5) * 0.04));
      x += w + gap;
    }
  }
  // Stringers along the length under the deck: both edges, and the middle of a wide deck.
  const rails = width > 3 ? [-1, 0, 1] : [-1, 1];
  if (detail > 0)
    for (const side of rails)
      parts.push(at(boxGeometry(length, 0.12, beam), length / 2, stringerY, side * (width / 2 - 0.1)));
  // Posts in pairs with a cross beam each; spacing about 2.4 m, the last pair at the far end.
  const pairs = Math.max(2, Math.round(length / 2.4) + 1);
  for (let i = 0; i < pairs; i++) {
    const x = (i / (pairs - 1)) * length;
    const rise = i % 4 === 0 || i === pairs - 1 ? 0.35 : -0.03;
    for (const side of [-1, 1]) {
      const bottom = -1.6 - rand() * 0.3,
        top = height + rise,
        lean = (rand() - 0.5) * 0.03,
        post = cylinderGeometry(0.085, 0.1, top - bottom, radial, 1);
      parts.push(
        basis(
          post,
          [1, 0, 0],
          [lean, 1, 0],
          [0, 0, 1],
          [Math.min(length - 0.1, Math.max(0.1, x)), (top + bottom) / 2, side * (width / 2 + 0.08)],
        ),
      );
    }
    if (detail === 2)
      parts.push(at(boxGeometry(0.1, 0.1, width + 0.28), Math.min(length - 0.1, Math.max(0.1, x)), stringerY - 0.1, 0));
  }
  if (ladder) {
    const xl = length - 0.8,
      zl = width / 2 + 0.2,
      top = height + 0.12,
      bottom = -0.9,
      side = [-0.2, 0.2];
    for (const dx of side)
      parts.push(at(cylinderGeometry(0.03, 0.03, top - bottom, radial, 1), xl + dx, (top + bottom) / 2, zl));
    const rungs = Math.floor((top - 0.2 - bottom) / 0.3);
    for (let r = 0; r <= rungs; r++)
      parts.push(alongX(cylinderGeometry(0.022, 0.022, 0.4, radial, 1), xl, top - 0.2 - r * 0.3, zl));
  }
  return computeTangents(mergeGeometries(parts));
}

/** Detail settings of the boat: stations along the hull, points around each section, seat and oar segments. */
const BOAT_DETAIL: readonly { stations: number; around: number; radial: number }[] = [
  { stations: 8, around: 6, radial: 4 },
  { stations: 14, around: 10, radial: 6 },
  { stations: 24, around: 16, radial: 8 },
];

/**
 * A small rowing boat: a lofted open hull with a pointed bow, a flat transom, a rim (gunwale) all round, up to four
 * seats and two oars resting in their oarlocks. Local origin at the waterline amidships; the bow points to +X, the keel
 * is about 0.2 m below y = 0 and the rim 0.46 m above it for the default 3.6 m boat (all sizes scale with `length`).
 * Render the hull double sided or with a wood material; one mesh with UVs, tangents and unit normals.
 * `options.detail` (default 2) gives 1,884 triangles for the default boat at 2 (24 stations of 16 points), 812 at 1 and
 * 372 at 0.
 * @throws TypeError when an option has the wrong type.
 * @throws RangeError when `length`, `seats`, `seed` or `detail` is outside its range.
 */
export function generateBoatMesh(options?: BoatOptions): GeometryData {
  const o = optionsOf(options, 'boat');
  const base = number('boat length', o.length, 1.5, 12, 3.6),
    seats = number('boat seats', o.seats, 0, 4, 3, true),
    oars = flag('boat oars', o.oars, true),
    detail: MeshDetail = resolveDetail(o),
    rand = random(seedOf(o) * 2246822519 + 5);
  const L = base * (0.98 + rand() * 0.04),
    s = L / 3.6,
    half = 0.7 * s * (0.96 + rand() * 0.08),
    wall = 0.03 * Math.max(0.6, s),
    { stations, around, radial } = BOAT_DETAIL[detail];
  const u = (t: number) => Math.abs(2 * t - 1);
  // Half beam, rim height and keel depth along the hull, t = 0 at the stern, 1 at the bow.
  const beamAt = (t: number) =>
    t < 0.5 ? half * (1 - 0.5 * (1 - 2 * t) ** 1.8) : Math.max(0.03 * s, half * (1 - u(t) ** 2.2) ** 0.8);
  const sheerAt = (t: number) => (0.46 + 0.2 * u(t) ** 2) * s,
    draftAt = (t: number) => (0.2 * (1 - u(t) ** 1.6) + 0.025) * s;
  const inner = (t: number) => Math.max(beamAt(t) * 0.2, beamAt(t) * 0.9 - wall);
  const section = (t: number, j: number, w: number, lift: number) => {
    const phi = (Math.PI * j) / around,
      sheer = sheerAt(t),
      depth = sheer + draftAt(t) - lift;
    return [w * Math.cos(phi), sheer - depth * Math.sin(phi) ** 0.75];
  };
  const outerPos: number[] = [],
    outerUv: number[] = [],
    innerPos: number[] = [],
    innerUv: number[] = [],
    grid: number[] = [];
  for (let i = 0; i <= stations; i++) {
    const t = i / stations,
      x = (t - 0.5) * L,
      xi = x + wall * (1 - t);
    for (let j = 0; j <= around; j++) {
      const [z, y] = section(t, j, beamAt(t), 0),
        [zi, yi] = section(t, j, inner(t), wall);
      outerPos.push(x, y, z);
      outerUv.push(t, j / around);
      innerPos.push(xi, yi, zi);
      innerUv.push(t, j / around);
    }
  }
  const stride = around + 1;
  for (let i = 0; i < stations; i++)
    for (let j = 0; j < around; j++) {
      const a = i * stride + j;
      grid.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
    }
  const outer = part(outerPos, outerUv, [...grid], (_x, y, z) => [0, y - 0.08 * s, z]);
  const inside = part(innerPos, innerUv, [...grid], (_x, y, z) => [0, y - 0.08 * s, z], -1);
  const parts: GeometryData[] = [outer, inside];
  // Rim: a flat strip between the outer and inner edge on each side.
  const rimPos: number[] = [],
    rimUv: number[] = [],
    rimIdx: number[] = [];
  for (let i = 0; i <= stations; i++) {
    const t = i / stations;
    for (const j of [0, around]) {
      rimPos.push(
        outerPos[(i * stride + j) * 3],
        outerPos[(i * stride + j) * 3 + 1],
        outerPos[(i * stride + j) * 3 + 2],
      );
      rimPos.push(
        innerPos[(i * stride + j) * 3],
        innerPos[(i * stride + j) * 3 + 1],
        innerPos[(i * stride + j) * 3 + 2],
      );
      rimUv.push(t, j ? 1 : 0, t, j ? 0.9 : 0.1);
    }
  }
  for (let i = 0; i < stations; i++)
    for (let k = 0; k < 2; k++) {
      const a = i * 4 + k * 2,
        b = a + 4;
      rimIdx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  parts.push(part(rimPos, rimUv, rimIdx, () => [0, 1, 0]));
  // End plates: stern transom (outer face -x, inner face +x) and the closed bow tip.
  const plate = (pos: number[], station: number, nx: number) => {
    const p: number[] = [],
      uv: number[] = [],
      idx: number[] = [];
    const first = station * stride;
    p.push(pos[first * 3], pos[first * 3 + 1], 0);
    uv.push(0.5, 1);
    for (let j = 0; j <= around; j++) {
      const v = (first + j) * 3;
      p.push(pos[v], pos[v + 1], pos[v + 2]);
      uv.push(j / around, 0);
    }
    for (let j = 1; j <= around; j++) idx.push(0, j, j + 1);
    return part(p, uv, idx, () => [nx, 0, 0]);
  };
  parts.push(plate(outerPos, 0, -1), plate(innerPos, 0, 1));
  parts.push(plate(outerPos, stations, 1), plate(innerPos, stations, -1));
  // Seats: planks across the hull just below the rim, spread over the middle.
  const seatY = 0.2 * s,
    spread = [[], [0.5], [0.38, 0.66], [0.3, 0.5, 0.7], [0.26, 0.42, 0.58, 0.74]][seats] ?? [];
  const widthAt = (t: number, y: number) => {
    const sheer = sheerAt(t),
      depth = sheer + draftAt(t) - wall,
      f = Math.min(1, Math.max(0, (sheer - y) / depth)),
      phi = Math.asin(f ** (1 / 0.75));
    return inner(t) * Math.cos(phi);
  };
  for (const base of spread) {
    const t = base + (rand() - 0.5) * 0.04,
      w = widthAt(t, seatY) * 2 - 0.01;
    parts.push(at(boxGeometry(0.24 * s, 0.04 * s, w), (t - 0.5) * L, seatY, 0));
  }
  if (oars) {
    const tilt = 0.12 + rand() * 0.08;
    for (const side of [-1, 1]) {
      const lock = 0.5 + (rand() - 0.5) * 0.03,
        x = (lock - 0.5) * L,
        y = sheerAt(lock) + 0.02 * s,
        z = side * beamAt(lock),
        len = 2 * s,
        shaft = at(cylinderGeometry(0.018 * s, 0.018 * s, len, radial, 1), 0, len / 2 - 0.55 * s, 0),
        blade = at(boxGeometry(0.1 * s, 0.5 * s, 0.012 * s), 0, len - 0.55 * s - 0.2 * s, 0),
        grip = at(cylinderGeometry(0.024 * s, 0.024 * s, 0.14 * s, radial, 1), 0, -0.5 * s, 0),
        oar = mergeGeometries([shaft, blade, grip]);
      // Oar axis (local Y) points outboard, a little aft and down; the blade face stays toward the stern.
      const ey = [-tilt, -0.14, side],
        n = Math.hypot(...ey),
        d = ey.map((v) => v / n),
        ex = [1, 0, 0],
        ez = [d[1] * ex[2] - d[2] * ex[1], d[2] * ex[0] - d[0] * ex[2], d[0] * ex[1] - d[1] * ex[0]],
        zl = Math.hypot(...ez),
        ezn = ez.map((v) => v / zl),
        exn = [d[1] * ezn[2] - d[2] * ezn[1], d[2] * ezn[0] - d[0] * ezn[2], d[0] * ezn[1] - d[1] * ezn[0]];
      parts.push(basis(oar, exn, d, ezn, [x, y, z]));
    }
  }
  return computeTangents(mergeGeometries(parts));
}
