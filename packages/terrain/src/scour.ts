// Wind scour and shadow dunes round obstacles on a sand bed, as a change of ground height, and a heightfield mesh
// refined where such small forms need it. Pure CPU, no engine. Clean room from the papers, no other engine's code.
//
// Buildings (bluff bodies): the stalled air in front of a wall turns down into a horseshoe vortex that wraps round it
// (Hunt, Abell, Peterka and Woo 1978, J. Fluid Mech. 86). On a sand or snow bed it leaves:
// - a scour moat along the windward wall and the flanks, deepest at the windward corners (Tominaga, Okaze and Mochida
//   2018, "Wind tunnel experiment and CFD analysis of sand erosion/deposition due to wind around an obstacle",
//   J. Wind Eng. Ind. Aerodyn. 182, https://doi.org/10.1016/j.jweia.2018.09.008);
// - a deposit horseshoe in front, its crest about 0.65 building heights upwind (1.6 m for the 2.5 m cube of Thiis and
//   Gjessing 1999, as reported by Poppema 2020), steep toward the wall and gentle upwind;
// - two deposit tails past the flanks, over a length that scales with B = w^(2/3) h^(1/3), w the width across the wind
//   and h the height (Poppema, Wijnberg, Mulder, Vos and Hulscher 2021, Coastal Engineering 168,
//   https://doi.org/10.1016/j.coastaleng.2021.103866).
// Plants and other small porous obstacles: a pyramidal shadow dune in the lee, as high as half the obstacle's width
// times the slope of its sides (Hesp 1981, "The formation of shadow dunes", J. Sed. Petrology 51,
// https://doi.org/10.1306/212F7C1B-2B24-11D7-8648000102C1865D, eqn 1 as given by Hesp and Smyth 2017), its length shrinking as the wind rises (Hesp and Smyth 2017, "Nebkha flow dynamics and shadow
// dune formation", Geomorphology 282, https://doi.org/10.1016/j.geomorph.2016.12.026: 5.6, 2.9, 1.6 and 1.3 m behind
// a 1 m nebkha at 7.5, 10, 15 and 20 m/s).
// The papers give places, lengths and the shadow dune's shape; the moat and ridge depths and the cross profiles are
// Margo's choices, set by options.
import { computeVertexNormals, type GeometryData } from '@margoengine/geometry/utils';
import type { HeightField } from '@margoengine/math';
import type { HeightfieldOptions } from './heightfield.js';

/** A rectangle on the ground: minimum x, minimum z, maximum x, maximum z, metres. */
export type ScourBounds = readonly [number, number, number, number];

/** A building standing on the sand. */
export interface ScourBuilding {
  /** World x and z of the middle of its footprint. */
  readonly center: readonly [number, number];
  /** Footprint along x and z before `yaw`, metres, each above 0. */
  readonly size: readonly [number, number];
  /** Height to the ridge, metres, above 0. */
  readonly height: number;
  /** Turn about +y, radians, as a mesh's. Default 0. */
  readonly yaw?: number;
}

/** A plant, tussock or other small porous obstacle that grows a shadow dune. */
export interface ScourPlant {
  /** World x and z of its middle. */
  readonly center: readonly [number, number];
  /** Width across the wind at the ground, metres, above 0. */
  readonly width: number;
}

/** Settings of {@link windScour}. */
export interface WindScourOptions {
  readonly buildings?: readonly ScourBuilding[];
  readonly plants?: readonly ScourPlant[];
  /** Direction the wind blows toward, degrees from +x toward +z (as `duneField`). Default 90 (toward +z). */
  readonly wind?: number;
  /** Wind speed at 10 m, m/s, 0 or more. Default 11. */
  readonly speed?: number;
  /**
   * Speed at which sand starts to move, m/s: nothing changes at or below it, and the forms are full from 1.3 times it.
   * Default 6.6 (0.25 mm sand, as `BlownSand`).
   */
  readonly threshold?: number;
  /** Depth of the moat along a building's windward wall as a share of its height, 0 to 0.075. Default 0.06. */
  readonly scour?: number;
  /** Height of the deposit horseshoe and tails as a share of a building's height, 0 to 0.3. Default 0.07. */
  readonly deposit?: number;
  /** Length of a building's tails past its leeward wall, in units of {@link scourScale}, 0.5 to 8. Default 3. */
  readonly tail?: number;
  /** Slope of a shadow dune's sides, degrees, 5 to 32 (the repose angle of dry sand). Default 20. */
  readonly slope?: number;
}

/** The ground change round obstacles, from {@link windScour}. */
export interface WindScour {
  /** Change of the ground's height at world (x, z), metres: 0 inside building footprints and away from obstacles. */
  change(x: number, z: number): number;
  /** One rectangle for each building, then each plant: outside all of them `change` is 0. */
  readonly bounds: readonly ScourBounds[];
}

/**
 * The length that deposition round a building scales with, metres: B = w^(2/3) h^(1/3), `width` across the wind and
 * `height` (Poppema et al. 2021).
 */
export function scourScale(width: number, height: number): number {
  return Math.cbrt(width * width * height);
}

/** Hesp and Smyth 2017: wind speed (m/s) against shadow dune length behind a nebkha 1 m across. */
const LENGTHS: readonly (readonly [number, number])[] = [
  [7.5, 5.6],
  [10, 2.9],
  [15, 1.6],
  [20, 1.3],
];

/**
 * Length of the shadow dune behind an obstacle `width` metres across in a wind of `speed` m/s: the CFD wake lengths of
 * Hesp and Smyth 2017 for a 1 m nebkha, straight between their speeds and held outside them, in proportion to the
 * width (Hesp 1981 found width the stronger control up to 0.2 m).
 */
export function shadowDuneLength(width: number, speed: number): number {
  let i = 0;
  while (i < LENGTHS.length - 2 && speed > LENGTHS[i + 1]![0]) i++;
  const [a, la] = LENGTHS[i]!,
    [b, lb] = LENGTHS[i + 1]!,
    t = Math.min(1, Math.max(0, (speed - a) / (b - a)));
  return width * (la + (lb - la) * t);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** A Gaussian that reaches exactly 0 at 3 sigma. */
const FLOOR = Math.exp(-9);
const bell = (u: number, sigma: number) => Math.max(0, Math.exp(-((u / sigma) ** 2)) - FLOOR) / (1 - FLOOR);

const range = (name: string, value: number, min: number, max: number) => {
  if (!(Number.isFinite(value) && value >= min && value <= max))
    throw new RangeError(`windScour: ${name} must be from ${min} to ${max}.`);
  return value;
};
const pair = (name: string, value: readonly number[] | undefined) => {
  if (!(value?.length === 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])))
    throw new RangeError(`windScour: ${name} must be two finite numbers.`);
};
const positive = (name: string, value: number) => {
  if (!(Number.isFinite(value) && value > 0)) throw new RangeError(`windScour: ${name} must be above 0.`);
  return value;
};

interface Form {
  readonly bounds: ScourBounds;
  /** Height change at (x, z), and the distance to the footprint (Infinity for a plant). */
  at(x: number, z: number): number;
}

/** World rectangle of the box from p0 to p1 along the wind (ax, az) and -q to q across it, round (x, z). */
function box(x: number, z: number, ax: number, az: number, p0: number, p1: number, q: number): ScourBounds {
  let x0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    z1 = -Infinity;
  for (const p of [p0, p1])
    for (const s of [-q, q]) {
      const wx = x + p * ax - s * az,
        wz = z + p * az + s * ax;
      x0 = Math.min(x0, wx);
      x1 = Math.max(x1, wx);
      z0 = Math.min(z0, wz);
      z1 = Math.max(z1, wz);
    }
  return [x0, z0, x1, z1];
}

/**
 * The change of ground height that wind leaves round `buildings` (a scour moat on the windward side and flanks, a
 * deposit horseshoe and two tails) and behind `plants` (shadow dunes). Add `change(x, z)` to a ground height, and give
 * the ground mesh vertices there with {@link refinedHeightfieldGeometry}: the moat of a 3 m shed is about 1.4 m wide.
 * Sand is not conserved between the moat and the deposits.
 * @throws RangeError for a bad option.
 */
export function windScour(options: WindScourOptions = {}): WindScour {
  const toward = (range('wind', options.wind ?? 90, -3600, 3600) * Math.PI) / 180,
    speed = range('speed', options.speed ?? 11, 0, 200),
    threshold = positive('threshold', options.threshold ?? 6.6),
    scour = range('scour', options.scour ?? 0.06, 0, 0.075),
    deposit = range('deposit', options.deposit ?? 0.07, 0, 0.3),
    tail = range('tail', options.tail ?? 3, 0.5, 8),
    slope = Math.tan((range('slope', options.slope ?? 20, 5, 32) * Math.PI) / 180),
    ax = Math.cos(toward),
    az = Math.sin(toward),
    moving = smooth(threshold, 1.3 * threshold, speed);

  const buildings = (options.buildings ?? []).map((b) => {
    pair('a building center', b.center);
    pair('a building size', b.size);
    const [cx, cz] = b.center,
      sx = positive('a building size', b.size[0]) / 2,
      sz = positive('a building size', b.size[1]) / 2,
      h = positive('a building height', b.height),
      yaw = range('a building yaw', b.yaw ?? 0, -1000, 1000),
      c = Math.cos(yaw),
      s = Math.sin(yaw),
      // Half the footprint's extent across and along the wind (its local axes are (c, -s) and (s, c)).
      half = Math.abs(-c * az - s * ax) * sx + Math.abs(-s * az + c * ax) * sz,
      along = Math.abs(c * ax - s * az) * sx + Math.abs(s * ax + c * az) * sz,
      B = scourScale(2 * half, h),
      reach = tail * B,
      crest = 0.65 * h,
      nearIn = 0.18 * h,
      nearOut = 0.45 * h,
      far = 0.22 * B,
      moat = 0.45 * h,
      spread = 0.12,
      corners = [-1, 1].flatMap((u) =>
        [-1, 1].map((v) => [cx + c * u * sx + s * v * sz, cz - s * u * sx + c * v * sz]),
      );
    /** Distance from (x, z) to the footprint, 0 inside it. */
    const distance = (x: number, z: number) => {
      const dx = x - cx,
        dz = z - cz;
      return Math.hypot(Math.max(0, Math.abs(c * dx - s * dz) - sx), Math.max(0, Math.abs(s * dx + c * dz) - sz));
    };
    const side = half + crest + spread * reach + 3 * Math.max(nearOut, far),
      bounds = box(cx, cz, ax, az, -along - crest - 3 * nearOut - half, along + reach, side + along);
    return {
      bounds,
      distance,
      at(x: number, z: number): number {
        if (x < bounds[0] || x > bounds[2] || z < bounds[1] || z > bounds[3]) return 0;
        const d = distance(x, z);
        if (d <= 0) return 0;
        const dx = x - cx,
          dz = z - cz,
          p = dx * ax + dz * az,
          q = Math.abs(dz * ax - dx * az);
        let y = 0;
        if (d < moat) {
          // Strongest at the front, weaker along the flanks, none in the lee; deeper at the two windward corners.
          const windward = (1 - 0.7 * smooth(-along, along + 0.3 * h, p)) * (1 - smooth(along, along + 0.4 * h, p)),
            corner = Math.max(...corners.map(([u, v]) => Math.exp(-((x - u!) ** 2 + (z - v!) ** 2) / (0.5 * h) ** 2)));
          // A sin^2 profile of depth 0.075 h over 0.45 h has a steepest slope of 28 degrees; where the corner deepens
          // it, the slope along the wall adds to that, under the repose angle of 32 to 34 degrees.
          y -= Math.min(0.075 * h, scour * h * windward * (1 + 0.5 * corner)) * Math.sin((Math.PI * d) / moat) ** 2;
        }
        // The horseshoe: round the front at `crest` from the wall, then two tails past the flanks, widening slowly.
        // It is laid round the building's extent along and across the wind, so an oblique building has one too.
        const front = Math.hypot(Math.max(0, -along - p), Math.max(0, q - half)),
          u = p < -along ? front - crest : q - (half + crest + spread * Math.max(0, p - along)),
          t = smooth(-along, along + B, p),
          sigma = (u < 0 ? nearIn : nearOut) * (1 - t) + far * t,
          length = 1 - smooth(along + 0.3 * reach, along + reach, p);
        y += deposit * h * bell(u, sigma) * length;
        return y;
      },
    };
  });

  const length = shadowDuneLength(1, speed);
  const plants: Form[] = (options.plants ?? []).map((plant) => {
    pair('a plant center', plant.center);
    const [cx, cz] = plant.center,
      r = positive('a plant width', plant.width) / 2,
      L = length * 2 * r,
      bounds = box(cx, cz, ax, az, -r, L, r);
    return {
      bounds,
      at(x: number, z: number): number {
        const dx = x - cx,
          dz = z - cz,
          p = dx * ax + dz * az,
          q = Math.abs(dz * ax - dx * az);
        // A rounded front under the plant, then a pyramid tapering to nothing at the wake's end.
        const rim = p < 0 ? r - Math.hypot(p, q) : r * (1 - p / L) - q;
        return rim > 0 ? slope * rim : 0;
      },
    };
  });

  // Plants binned on a grid, so a height costs the few plants near it.
  const CELL = 4,
    bins = new Map<string, Form[]>();
  for (const plant of plants) {
    const [x0, z0, x1, z1] = plant.bounds;
    for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++)
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
        const key = `${i},${j}`,
          list = bins.get(key);
        if (list) list.push(plant);
        else bins.set(key, [plant]);
      }
  }

  return {
    bounds: [...buildings.map((b) => b.bounds), ...plants.map((p) => p.bounds)],
    change(x, z) {
      if (moving <= 0) return 0;
      // Shadow dunes that meet merge into one body of sand: the highest, not their sum.
      let sand = 0;
      for (const plant of bins.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? [])
        sand = Math.max(sand, plant.at(x, z));
      let near = Infinity;
      for (const b of buildings) {
        near = Math.min(near, b.distance(x, z));
        sand += b.at(x, z);
      }
      // No change at any wall, so a building set on the unchanged ground stays on it.
      return near > 0 ? moving * sand * smooth(0, 0.3, near) : 0;
    },
  };
}

/** Options of {@link refinedHeightfieldGeometry}. */
export interface RefinedHeightfieldOptions extends HeightfieldOptions {
  /** Rectangles whose cells are split. */
  readonly regions: readonly ScourBounds[];
  /** Splits per cell side inside the regions, an integer 1 to 16. Default 5. */
  readonly subdivide?: number;
  /**
   * Added to the height at every vertex, such as `windScour(...).change`. `height` is read only at the coarse grid's
   * vertices, so without this the refined surface is the coarse one. Default none.
   */
  readonly add?: HeightField;
}

/**
 * `heightfieldGeometry` with the cells that touch `regions` split `subdivide` times a side, for small forms on a large
 * ground. The split cells lie on the coarse triangles (so grass or anything else placed on the coarse grid still stands
 * on the mesh) until `add` moves them, and the cells round a region are fanned to its edge vertices: no cracks.
 * @throws RangeError for a bad option, a non-finite height or more than 4,000,000 vertices.
 */
export function refinedHeightfieldGeometry(height: HeightField, options: RefinedHeightfieldOptions): GeometryData {
  const { size, resolution: n = 192, regions, subdivide: k = 5, add } = options,
    origin = options.origin ?? [-size?.[0] / 2, -size?.[1] / 2];
  if (
    typeof height !== 'function' ||
    !(size?.length === 2 && size[0] > 0 && size[1] > 0 && Number.isFinite(size[0] + size[1])) ||
    !(origin.length === 2 && Number.isFinite(origin[0] + origin[1])) ||
    !(Number.isInteger(n) && n >= 1 && n <= 1024) ||
    !(Number.isInteger(k) && k >= 1 && k <= 16) ||
    !Array.isArray(regions) ||
    !regions.every((r) => r?.length === 4 && r.every(Number.isFinite) && r[2] >= r[0] && r[3] >= r[1]) ||
    (add !== undefined && typeof add !== 'function')
  )
    throw new RangeError(
      'refinedHeightfieldGeometry: pass a height function, a positive size, a resolution 1 to 1024, subdivide 1 to 16 and regions as [minX, minZ, maxX, maxZ].',
    );
  const cx = size[0] / n,
    cz = size[1] / n,
    split = new Uint8Array(n * n);
  for (const [x0, z0, x1, z1] of regions) {
    const i0 = Math.max(0, Math.floor((x0 - origin[0]) / cx)),
      i1 = Math.min(n - 1, Math.ceil((x1 - origin[0]) / cx) - 1),
      j0 = Math.max(0, Math.floor((z0 - origin[1]) / cz)),
      j1 = Math.min(n - 1, Math.ceil((z1 - origin[1]) / cz) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) split[j * n + i] = k > 1 ? 1 : 0;
  }
  const fine = (i: number, j: number) => i >= 0 && j >= 0 && i < n && j < n && split[j * n + i] === 1;
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  const vertex = (x: number, z: number, y: number): number => {
    const index = positions.length / 3,
      value = y + (add ? add(x, z) : 0);
    if (!Number.isFinite(Math.fround(value))) throw new RangeError('Terrain height must be finite');
    if (index >= 4_000_000)
      throw new RangeError('refinedHeightfieldGeometry: over 4,000,000 vertices; split fewer cells.');
    positions.push(x, value, z);
    uvs.push((x - origin[0]) / size[0], 1 - (z - origin[1]) / size[1]);
    return index;
  };
  // The coarse vertices come first, row by row along x.
  const base = new Float64Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const x = origin[0] + i * cx,
        z = origin[1] + j * cz,
        y = height(x, z);
      base[j * (n + 1) + i] = y;
      vertex(x, z, y);
    }
  // Vertices between them, on the grid of k steps a cell, each made once.
  const made = new Map<number, number>(),
    wide = n * k + 1;
  const at = (a: number, b: number): number => {
    if (a % k === 0 && b % k === 0) return (b / k) * (n + 1) + a / k;
    const key = b * wide + a;
    let index = made.get(key);
    if (index === undefined) {
      const i = Math.min(n - 1, Math.floor(a / k)),
        j = Math.min(n - 1, Math.floor(b / k)),
        u = a / k - i,
        v = b / k - j,
        w = j * (n + 1) + i,
        h00 = base[w]!,
        h10 = base[w + 1]!,
        h01 = base[w + n + 1]!,
        h11 = base[w + n + 2]!,
        // The coarse cell's two triangles, split from (0, 1) to (1, 0) as heightfieldGeometry splits them.
        y = u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
      index = vertex(origin[0] + (a * cx) / k, origin[1] + (b * cz) / k, y);
      made.set(key, index);
    }
    return index;
  };
  const quad = (a: number, b: number, step: number) => {
    const v00 = at(a, b),
      v10 = at(a + step, b),
      v01 = at(a, b + step),
      v11 = at(a + step, b + step);
    indices.push(v00, v01, v10, v10, v01, v11);
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = i * k,
        b = j * k;
      if (fine(i, j)) {
        for (let v = 0; v < k; v++) for (let u = 0; u < k; u++) quad(a + u, b + v, 1);
        continue;
      }
      const west = fine(i - 1, j),
        north = fine(i, j + 1),
        east = fine(i + 1, j),
        south = fine(i, j - 1);
      if (!(west || north || east || south)) {
        quad(a, b, k);
        continue;
      }
      // A fan from the cell's middle round its rim, through every vertex a split neighbour has on a shared edge.
      const rim: number[] = [];
      const edge = (split: boolean, point: (t: number) => number) => {
        const steps = split ? k : 1;
        for (let t = 0; t < steps; t++) rim.push(point((t * k) / steps));
      };
      edge(west, (t) => at(a, b + t));
      edge(north, (t) => at(a + t, b + k));
      edge(east, (t) => at(a + k, b + k - t));
      edge(south, (t) => at(a + k - t, b));
      const x = origin[0] + (i + 0.5) * cx,
        z = origin[1] + (j + 0.5) * cz,
        centre = vertex(x, z, (base[j * (n + 1) + i + 1]! + base[(j + 1) * (n + 1) + i]!) / 2);
      for (let t = 0; t < rim.length; t++) indices.push(centre, rim[t]!, rim[(t + 1) % rim.length]!);
    }
  return computeVertexNormals({
    positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  });
}
