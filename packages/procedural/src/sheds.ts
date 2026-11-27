// Board-built sheds and a wooden launch rail: frame-and-plank buildings with lapped horizontal or vertical siding, door
// and window openings, door leaves (closed, open or swung up as an awning), a gabled roof, corner boards and fascia,
// and a straight timber rail capped with a metal strip. Our own shapes from boxes; local origin on the ground at the
// middle of the floor, +Y up, metres. Seeded and deterministic.
// UVs run with the grain in the columns of `shedBoardMap`, a map of weathered boards, and the faces turned into the
// shed are parts of their own with the average daylight factor that reaches them through the openings.
// Clean room from public building descriptions, no other engine's code:
// - Crisp, V. H. C. and Littlefair, P. J. 1984, "Average daylight factor prediction", Proc. CIBSE National Lighting
//   Conference, Cambridge (after Lynes, J. A. 1979, "A sequence for daylighting design", Lighting Research and
//   Technology 11(2), https://doi.org/10.1177/14771535790110020101): DF (percent) = T theta W / (A (1 - R^2)) for
//   openings of area W seeing theta degrees of sky into a room of total surface area A and mean reflectance R.
// - US Forest Products Laboratory 2010, "Wood Handbook: Wood as an Engineering Material", General Technical Report
//   FPL-GTR-190, chapter 17 (lap siding about 6 inches wide, laid with about 1 inch of lap) and nominal lumber sizes
//   (a 2 by 4 is 1.5 by 3.5 inches dressed).
// - Library of Congress, Wright Brothers negatives LC-W86-15 (the 1903 camp, 24 Nov 1903) and LC-W86-21 (the launching
//   track, 14 Dec 1903), public domain: a low gabled hangar of horizontal boards with doors hinged at the top, a smaller
//   steeper shed of vertical boards with one door and one window, and a 60 ft rail of timbers lying on the sand.
// - McFarland, M. W. (ed.) 1953, "The Papers of Wilbur and Orville Wright" (McGraw-Hill): the 1903 hangar about 44 by
//   16 ft; the launching rail of 2 by 4 timbers on edge, 60 ft in 15 ft lengths, faced with a thin metal strip.
import { boxGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, computeTangents, mergeGeometries, type GeometryData } from '@margoengine/geometry/utils';

/** A hole in a wall: a door or a window. Lengths in metres. */
export interface ShedOpening {
  /** The wall: `front` (+z long side), `back` (-z long side), `left` (-x gable end) or `right` (+x gable end). */
  readonly wall: 'front' | 'back' | 'left' | 'right';
  /** Centre of the opening along the wall from the wall's middle, metres (+ toward +x, or toward +z on a gable end). */
  readonly at?: number;
  readonly width: number;
  readonly height: number;
  /** Height of the opening's bottom edge above the floor. Default 0 (a door). */
  readonly bottom?: number;
  /**
   * What fills it: `none` (an open hole), `closed` (a board leaf in the hole), `open` (a leaf swung out 100 degrees on
   * its left hinge) or `awning` (a leaf hinged at the top and propped up 75 degrees, as the 1903 hangar's doors were).
   * Default `closed` for a door, `none` for a window.
   */
  readonly leaf?: 'none' | 'closed' | 'open' | 'awning';
}

/** Options for {@link generatePlankShed}. Every option has a default: `generatePlankShed()` is a 44 by 16 ft hangar. */
export interface PlankShedOptions {
  /** Length along x (the ridge), metres, 1.5 to 40. Default 13.4 (44 ft). */
  readonly length?: number;
  /** Width along z (the gable ends), metres, 1.2 to 16. Default 4.9 (16 ft). */
  readonly width?: number;
  /** Wall height to the eaves, metres, 1.5 to 8. Default 2.4. */
  readonly eaves?: number;
  /** Roof pitch, degrees, 5 to 60. Default 18. */
  readonly pitch?: number;
  /** `horizontal` lapped boards (clapboard) or `vertical` boards side by side. Default `horizontal`. */
  readonly siding?: 'horizontal' | 'vertical';
  /** Board face width, metres, 0.08 to 0.4. Default 0.15 (about 6 inches). */
  readonly board?: number;
  /** Roof overhang past the walls, metres, 0 to 1. Default 0.2. */
  readonly overhang?: number;
  /** Doors and windows. Default one awning door 3.6 m wide by 2.1 m on the front wall. */
  readonly openings?: readonly ShedOpening[];
  /** How weathered the boards are, 0 to 1: small tilts, uneven ends and gaps. Default 0.5. */
  readonly weathering?: number;
  /** Integer seed. Default 1. */
  readonly seed?: number;
}

/**
 * A shed from {@link generatePlankShed}: one mesh per material, all with UVs, tangents and unit normals. The UVs
 * suit {@link shedBoardMap} repeated: u runs across the grain, one column of the map to a board's width, and v along it,
 * one repeat to 2 m.
 */
export interface PlankShed {
  readonly parts: {
    /** The outer faces of the wall boards, and open and awning door leaves. */
    readonly siding: GeometryData;
    /** Roof boards (the undersides inside the walls are in `inside.faces`). */
    readonly roof: GeometryData;
    /** Corner boards, fascia and the ridge board. */
    readonly trim: GeometryData;
  };
  /** Height of the ridge above the floor, metres. */
  readonly ridge: number;
  /** What is turned into the shed. Render it with `parts`: the walls' inner faces are only here. */
  readonly inside: PlankShedInside;
}

/** The inside of a {@link PlankShed}, lit by what its openings let in. */
export interface PlankShedInside {
  /**
   * The faces turned into the shed: the insides of the walls and closed leaves, and the roof's underside. Render them as
   * `siding`, with the ambient light scaled by `daylight` (an `aoMap` of that value).
   */
  readonly faces: GeometryData;
  /** A thin floor inside the walls, 7 cm above the origin; scale its ambient light by `daylight` too. */
  readonly floor: GeometryData;
  /**
   * The average daylight factor inside, 0 to 1: the share of the open sky's light that reaches the inner surfaces
   * through the openings (Crisp and Littlefair 1984), boards of reflectance 0.25. A closed leaf lets none in; an awning
   * leaf shades all but the sky under its edge. 0 with every opening closed.
   */
  readonly daylight: number;
}

/** Options for {@link shedBoardMap}. */
export interface ShedBoardMapOptions {
  /** Mean albedo of the boards, linear RGB 0 to 1. Default [0.258, 0.205, 0.147] (weathered wood). */
  readonly color?: readonly [number, number, number];
  /** How much boards differ and weather, 0 to 1: tone, silvering, grain, knots and dirt in the joints. Default 0.5. */
  readonly variation?: number;
  /** Integer seed. Default 1. */
  readonly seed?: number;
}

/** A map of boards from {@link shedBoardMap}: opaque sRGB RGBA8 rows, repeating in both directions. */
export interface ShedBoardMap {
  readonly data: Uint8Array;
  /** 256: sixteen boards side by side along u. */
  readonly width: number;
  /** 512: 2 m along the grain. */
  readonly height: number;
}

/** Options for {@link generateLaunchRail}. */
export interface LaunchRailOptions {
  /** Length along +x from x = 0, metres, 1 to 60. Default 18.3 (60 ft). */
  readonly length?: number;
  /** Number of timber lengths butted end to end, 1 to 12. Default 4 (15 ft each). */
  readonly sections?: number;
  /** Timber cross-section: width and height, metres. Default [0.038, 0.089] (a dressed 2 by 4 laid on edge). */
  readonly timber?: readonly [number, number];
  /** A thin metal strip along the top. Default true. */
  readonly strip?: boolean;
  /** Height of the ground under each point along the rail, so it lies on sloping sand. Default flat 0. */
  readonly ground?: (x: number) => number;
  /** Integer seed. Default 1. */
  readonly seed?: number;
}

/** A rail from {@link generateLaunchRail}. */
export interface LaunchRail {
  /** `metal` is absent when `strip` is false. */
  readonly parts: { readonly wood: GeometryData; readonly metal?: GeometryData };
}

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function num(name: string, value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`Invalid shed ${name}; pass a finite number.`);
  if (value < min || value > max) throw new RangeError(`Shed ${name} ${value} is out of range; pass ${min} to ${max}.`);
  return value;
}
/** Boards side by side across a board map, and the metres of grain its height spans. */
const COLUMNS = 16,
  ALONG = 2;
/**
 * Gives a box of `size` the UVs of a board (see {@link PlankShed}): u across the grain (the longest side), a column of the
 * board map to `width` metres starting at `column`, v along the grain from `start`.
 */
function grain(
  data: GeometryData,
  size: readonly number[],
  width: number,
  column: number,
  start: number,
): GeometryData {
  const long = size[0]! >= size[1]! && size[0]! >= size[2]! ? 0 : size[1]! >= size[2]! ? 1 : 2,
    { positions: p, normals: n, uvs } = data;
  for (let i = 0; i < uvs.length / 2; i++) {
    const face = Math.abs(n[3 * i]!) > 0.5 ? 0 : Math.abs(n[3 * i + 1]!) > 0.5 ? 1 : 2,
      // The side of this face that runs across the grain (on an end face, either of its two).
      across = face === long ? (long + 1) % 3 : 3 - long - face,
      along = face === long ? (long + 2) % 3 : long;
    uvs[2 * i] = (column + (p[3 * i + across]! + size[across]! / 2) / width) / COLUMNS;
    uvs[2 * i + 1] = start + p[3 * i + along]! / ALONG;
  }
  return data;
}
/** The triangles of `data` whose vertices `keep` accepts, as a geometry of their own. */
function faces(data: GeometryData, keep: (vertex: number) => boolean): GeometryData {
  const to = new Map<number, number>(),
    indices: number[] = [];
  for (let t = 0; t < data.indices.length; t += 3) {
    const corners = [data.indices[t]!, data.indices[t + 1]!, data.indices[t + 2]!];
    if (!corners.every(keep)) continue;
    for (const v of corners) {
      if (!to.has(v)) to.set(v, to.size);
      indices.push(to.get(v)!);
    }
  }
  const pick = (source: Float32Array, size: number) => {
    const out = new Float32Array(to.size * size);
    for (const [from, at] of to) out.set(source.subarray(from * size, (from + 1) * size), at * size);
    return out;
  };
  return {
    positions: pick(data.positions, 3),
    normals: pick(data.normals, 3),
    uvs: pick(data.uvs, 2),
    indices: Uint32Array.from(indices),
  };
}
/** Turns a box by `yaw` about +y, then by `tilt` about its own x axis, and centres it at (x, y, z). */
function place(data: GeometryData, x: number, y: number, z: number, yaw: number, tilt: number): GeometryData {
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    ct = Math.cos(tilt),
    st = Math.sin(tilt);
  // Columns: local x turned by yaw; local y and z turned by tilt about local x, then by yaw.
  return applyMatrix4(data, [c, 0, -s, 0, s * st, ct, c * st, 0, s * ct, -st, c * ct, 0, x, y, z, 1]);
}

/**
 * A board-built gabled shed. Walls are boards on a frame (horizontal lapped boards or vertical boards); openings cut
 * the boards they cross and can hold a door leaf; the roof is two board slopes with an overhang, fascia along the
 * eaves and a ridge board; corner boards cover the wall ends. Render `siding` and `roof` with a weathered wood
 * material and `trim` with the same or a darker one. Origin on the ground at the middle of the floor; the ridge runs
 * along x. The default is the 1903 Kill Devil Hills hangar: 13.4 by 4.9 m, low roof, a wide awning door on the front.
 * @throws TypeError when an option has the wrong type; RangeError when it is out of range or an opening does not fit
 * its wall.
 */
export function generatePlankShed(options: PlankShedOptions = {}): PlankShed {
  if (typeof options !== 'object' || options === null) throw new TypeError('Invalid shed options; pass an object.');
  const L = num('length', options.length, 1.5, 40, 13.4),
    W = num('width', options.width, 1.2, 16, 4.9),
    E = num('eaves', options.eaves, 1.5, 8, 2.4),
    pitch = (num('pitch', options.pitch, 5, 60, 18) * Math.PI) / 180,
    B = num('board', options.board, 0.08, 0.4, 0.15),
    over = num('overhang', options.overhang, 0, 1, 0.2),
    age = num('weathering', options.weathering, 0, 1, 0.5),
    vertical = (options.siding ?? 'horizontal') === 'vertical',
    rand = random((num('seed', options.seed, 0, 2 ** 31, 1) * 2654435761 + 7) >>> 0),
    rise = (W / 2) * Math.tan(pitch),
    ridge = E + rise,
    T = 0.022,
    openings = options.openings ?? [
      { wall: 'front', width: Math.min(3.6, L - 0.6), height: Math.min(2.1, E - 0.1), leaf: 'awning' },
    ];
  if (options.siding !== undefined && options.siding !== 'horizontal' && options.siding !== 'vertical')
    throw new RangeError("Unknown shed siding; pass 'horizontal' or 'vertical'.");
  const siding: GeometryData[] = [],
    roof: GeometryData[] = [],
    trim: GeometryData[] = [],
    interior: GeometryData[] = [];
  // The UVs draw from a stream of their own, so the boards lie where they did.
  const pick = random((num('seed', options.seed, 0, 2 ** 31, 1) * 2654435761 + 23) >>> 0);
  /**
   * A box of size (sx, sy, sz), its face columns `wide` metres each, turned by `yaw` then `tilt` at (x, y, z), added to
   * `list`; with `inside` (a local axis, its negative side turned into the shed) that face goes to the interior.
   */
  const board = (
    list: GeometryData[],
    [sx, sy, sz]: readonly [number, number, number],
    [x, y, z]: readonly [number, number, number],
    yaw = 0,
    tilt = 0,
    inside?: 1 | 2,
    wide = B,
  ) => {
    const box = grain(boxGeometry(sx, sy, sz), [sx, sy, sz], wide, Math.floor(pick() * COLUMNS), pick());
    if (inside === undefined) list.push(place(box, x, y, z, yaw, tilt));
    else {
      const inward = (v: number) => box.normals[3 * v + inside]! < -0.5;
      list.push(
        place(
          faces(box, (v) => !inward(v)),
          x,
          y,
          z,
          yaw,
          tilt,
        ),
      );
      interior.push(place(faces(box, inward), x, y, z, yaw, tilt));
    }
  };
  // Each wall: its length, the top of the wall at a point s along it, how to place a board on it.
  const walls = {
    front: { len: L, top: () => E, place: (s: number, y: number) => [s, y, W / 2] as const, yaw: 0 },
    back: { len: L, top: () => E, place: (s: number, y: number) => [s, y, -W / 2] as const, yaw: Math.PI },
    right: {
      len: W,
      top: (s: number) => E + rise * (1 - Math.abs(s) / (W / 2)),
      place: (s: number, y: number) => [L / 2, y, s] as const,
      yaw: Math.PI / 2,
    },
    left: {
      len: W,
      top: (s: number) => E + rise * (1 - Math.abs(s) / (W / 2)),
      place: (s: number, y: number) => [-L / 2, y, s] as const,
      yaw: -Math.PI / 2,
    },
  };
  const holes = openings.map((o) => {
    const wall = walls[o.wall];
    if (!wall) throw new RangeError(`Unknown shed wall ${String(o.wall)}; pass front, back, left or right.`);
    const at = o.at ?? 0,
      bottom = o.bottom ?? 0,
      a = at - o.width / 2,
      b = at + o.width / 2;
    if (!(o.width > 0 && o.height > 0) || a < -wall.len / 2 + 0.1 || b > wall.len / 2 - 0.1)
      throw new RangeError(`A shed opening does not fit its ${o.wall} wall; pass a smaller width or move it with at.`);
    if (bottom + o.height > Math.min(wall.top(a), wall.top(b)) - 0.05)
      throw new RangeError(`A shed opening is taller than its ${o.wall} wall; pass a lower height.`);
    return { ...o, a, b, bottom, top: bottom + o.height };
  });
  // Cuts the span [s0, s1] of the wall at heights [y0, y1] around the openings, giving the pieces left.
  const cut = (wall: string, s0: number, s1: number, y0: number, y1: number) => {
    let pieces: [number, number][] = [[s0, s1]];
    for (const h of holes)
      if (h.wall === wall && y1 > h.bottom && y0 < h.top)
        pieces = pieces.flatMap(([p, q]): [number, number][] =>
          h.b <= p || h.a >= q
            ? [[p, q]]
            : (
                [
                  [p, h.a],
                  [h.b, q],
                ] as [number, number][]
              ).filter(([u, v]) => v - u > 0.02),
        );
    return pieces;
  };
  for (const [name, wall] of Object.entries(walls)) {
    const half = wall.len / 2 - T;
    if (!vertical) {
      // Lapped boards: each course B high, laid B minus about an inch apart, its bottom edge out over the one below.
      const step = B - 0.025,
        // Negative: the board's top leans in, its bottom edge stands out over the course below.
        tilt = -Math.atan2(0.012, B);
      for (let y = 0.05; y < ridge; y += step) {
        const mid = y + B / 2;
        if (mid > wall.top(0)) break;
        // A gable course is as long as the roof lets it be at its top.
        const reach =
          name === 'left' || name === 'right' ? Math.min(half, (W / 2) * (1 - Math.max(0, y + B - E) / rise)) : half;
        if (reach < 0.05) break;
        for (const [p, q] of cut(name, -reach, reach, y, y + B)) {
          const jitter = age * 0.006 * (rand() - 0.5),
            length = q - p - age * 0.01 * rand(),
            [x, yy, z] = wall.place((p + q) / 2, mid + jitter);
          board(siding, [length, B, T], [x, yy, z], wall.yaw, tilt + age * 0.01 * (rand() - 0.5), 2);
        }
      }
    } else {
      // Vertical boards side by side with small gaps, each up to the wall's top at its middle.
      for (let s = -half; s < half - 0.02; s += B + 0.004 * age) {
        const w = Math.min(B, half - s),
          c = s + w / 2,
          top = wall.top(c) - 0.01;
        for (const [p, q] of cutVertical(holes, name, c - w / 2, c + w / 2, 0.02, top)) {
          const [x, yy, z] = wall.place(c, (p + q) / 2);
          board(siding, [w - 0.003, q - p, T], [x, yy, z], wall.yaw, age * 0.004 * (rand() - 0.5), 2);
        }
      }
    }
  }
  // Door leaves: boards across the hole, hinged as asked.
  for (const h of holes) {
    const leaf = h.leaf ?? (h.bottom > 0 ? 'none' : 'closed');
    if (leaf === 'none') continue;
    const wall = walls[h.wall],
      w = h.b - h.a,
      ht = h.top - h.bottom,
      [hx, hy, hz] = wall.place((h.a + h.b) / 2, (h.bottom + h.top) / 2),
      out = [Math.sin(wall.yaw), 0, Math.cos(wall.yaw)];
    if (leaf === 'closed') board(siding, [w - 0.02, ht - 0.02, T], [hx, hy, hz], wall.yaw, 0, 2);
    else if (leaf === 'awning') {
      // Hinged along the top edge and propped up 75 degrees: its middle swings out and up.
      const angle = (75 * Math.PI) / 180,
        r = ht / 2;
      board(
        siding,
        [w - 0.02, ht - 0.02, T],
        [hx + out[0] * r * Math.sin(angle), h.top - r * Math.cos(angle), hz + out[2] * r * Math.sin(angle)],
        wall.yaw,
        -angle,
      );
    } else {
      // Hinged on its left edge and swung out 100 degrees.
      const angle = (100 * Math.PI) / 180,
        r = w / 2,
        [lx, , lz] = wall.place(h.a, 0),
        yaw = wall.yaw - angle,
        cx = lx + Math.cos(yaw) * r,
        cz = lz - Math.sin(yaw) * r;
      board(siding, [w - 0.02, ht - 0.02, T], [cx, hy, cz], yaw);
    }
  }
  // Roof: two board slopes from the ridge past the eaves, each B wide boards running along the ridge.
  const slope = Math.hypot(W / 2, rise) + over / Math.cos(pitch),
    span = L + 2 * over;
  for (const side of [1, -1]) {
    for (let d = 0; d < slope; d += B) {
      const w = Math.min(B, slope - d),
        m = d + w / 2,
        y = ridge + 0.03 - m * Math.sin(pitch) + age * 0.004 * (rand() - 0.5),
        z = side * m * Math.cos(pitch);
      // The underside of a board inside the walls is the shed's ceiling; an eave's is outdoors.
      const ceiling = Math.abs(z) < W / 2;
      board(roof, [span - age * 0.02 * rand(), 0.025, w - 0.004], [0, y, z], 0, side * pitch, ceiling ? 1 : undefined);
    }
    // Fascia board along the eaves.
    const e = slope - 0.02;
    board(trim, [span, 0.14, 0.025], [0, ridge - e * Math.sin(pitch) - 0.05, side * (e * Math.cos(pitch) + 0.01)]);
  }
  board(trim, [span, 0.05, 0.12], [0, ridge + 0.06, 0]);
  // Corner boards up the four corners.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) board(trim, [0.1, E, 0.1], [sx * (L / 2 + 0.02), E / 2, sz * (W / 2 + 0.02)]);
  const floor: GeometryData[] = [];
  board(floor, [L - 2 * T, 0.02, W - 2 * T], [0, 0.06, 0]);
  const finish = (list: GeometryData[]) => computeTangents(mergeGeometries(list));
  return {
    parts: { siding: finish(siding), roof: finish(roof), trim: finish(trim) },
    ridge,
    inside: { faces: finish(interior), floor: finish(floor), daylight: daylightFactor(holes, L, W, E, rise) },
  };
}

/** Reflectance of the weathered boards inside a shed, for its daylight factor. */
const REFLECTANCE = 0.25;
/** The average daylight factor, 0 to 1, of a gabled room lit through `holes` (Crisp and Littlefair 1984). */
function daylightFactor(
  holes: readonly (ShedOpening & { bottom: number })[],
  L: number,
  W: number,
  E: number,
  rise: number,
): number {
  // Floor, two roof slopes, four walls and the two gables.
  const area = L * W + 2 * L * Math.hypot(W / 2, rise) + 2 * (L + W) * E + W * rise;
  let sky = 0;
  for (const h of holes) {
    const leaf = h.leaf ?? (h.bottom > 0 ? 'none' : 'closed');
    if (leaf === 'closed') continue;
    // Degrees of sky seen from the opening's middle: 90 for a clear vertical opening; under an awning leaf (75 degrees
    // from hanging), up to its outer edge.
    const lift = (75 * Math.PI) / 180,
      theta = leaf === 'awning' ? (Math.atan2(0.5 - Math.cos(lift), Math.sin(lift)) * 180) / Math.PI : 90;
    sky += h.width * h.height * theta;
  }
  return Math.min(1, sky / (area * (1 - REFLECTANCE ** 2)) / 100);
}

/** Value noise on a lattice that repeats every `px` by `py` cells, 0 to 1. */
function noise(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    at = (i: number, j: number) => {
      let h = Math.imul((((i % px) + px) % px) + 1, 0x27d4eb2d) ^ Math.imul((((j % py) + py) % py) + seed, 0x165667b1);
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
      return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
    },
    ease = (t: number) => t * t * (3 - 2 * t),
    fx = ease(x - ix),
    fy = ease(y - iy),
    low = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * fx,
    high = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * fx;
  return low + (high - low) * fy;
}

/**
 * Sixteen weathered boards side by side, the albedo map for a {@link PlankShed}'s parts (and the rail's): each board has
 * its own tone and silvering, grain streaks along it, a knot or two and dirt in the joint at its edges. Their mean is
 * `color`. Deterministic; make a texture of it with repeat wrapping and the sRGB colour space.
 * @throws TypeError or RangeError for a bad option.
 * @example
 * const map = shedBoardMap({ color: [0.26, 0.2, 0.15] }); // { data, width: 256, height: 512 }
 */
export function shedBoardMap(options: ShedBoardMapOptions = {}): ShedBoardMap {
  if (typeof options !== 'object' || options === null)
    throw new TypeError('Invalid board map options; pass an object.');
  const color = options.color ?? [0.258, 0.205, 0.147],
    variation = num('variation', options.variation, 0, 1, 0.5),
    seed = num('seed', options.seed, 0, 2 ** 31, 1) >>> 0;
  if (!Array.isArray(color) || color.length !== 3 || !color.every((v) => v >= 0 && v <= 1))
    throw new RangeError('Board map color must be three linear values from 0 to 1.');
  const width = 256,
    height = 512,
    wide = width / COLUMNS,
    rand = random((seed * 2654435761 + 31) >>> 0),
    luma = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2],
    linear = new Float32Array(width * height * 3),
    mean = [0, 0, 0];
  for (let c = 0; c < COLUMNS; c++) {
    const tone = 1 + variation * 0.9 * (rand() - 0.5),
      silver = variation * rand(),
      knots = [0, 1].map(() => ({ x: 3 + rand() * (wide - 6), y: rand() * height, r: 2 + rand() * 3 }));
    for (let y = 0; y < height; y++)
      for (let i = 0; i < wide; i++) {
        const x = c * wide + i,
          // Fine and broad grain: narrow across, long along.
          streak =
            1 +
            variation *
              (0.5 * (noise(x / 1.5, y / 64, 1024, 8, seed) - 0.5) +
                0.35 * (noise(x / 4, y / 16, 64, 32, seed + 7) - 0.5)),
          edge = i === 0 || i === wide - 1 ? 1 - 0.55 * variation : 1;
        let knot = 1;
        for (const k of knots) {
          const dy = Math.min(Math.abs(y - k.y), height - Math.abs(y - k.y)) / 3,
            d = Math.hypot(i - k.x, dy) / k.r;
          if (d < 1) knot = Math.min(knot, 1 - 0.6 * variation * (1 - d * d));
        }
        for (let k = 0; k < 3; k++) {
          const v = (color[k]! + (luma - color[k]!) * silver) * tone * streak * edge * knot;
          linear[(y * width + x) * 3 + k] = v;
          mean[k] += v;
        }
      }
  }
  const scale = mean.map((sum, k) => (sum > 0 ? (color[k]! * width * height) / sum : 0)),
    data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let k = 0; k < 3; k++) {
      const v = Math.min(1, linear[i * 3 + k]! * scale[k]!);
      data[i * 4 + k] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    }
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function cutVertical(
  holes: readonly { wall: string; a: number; b: number; bottom: number; top: number }[],
  wall: string,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
): [number, number][] {
  let pieces: [number, number][] = [[y0, y1]];
  for (const h of holes)
    if (h.wall === wall && s1 > h.a && s0 < h.b)
      pieces = pieces.flatMap(([p, q]): [number, number][] =>
        h.top <= p || h.bottom >= q
          ? [[p, q]]
          : (
              [
                [p, h.bottom],
                [h.top, q],
              ] as [number, number][]
            ).filter(([u, v]) => v - u > 0.02),
      );
  return pieces;
}

/**
 * A straight wooden launch rail along +x from x = 0: timbers on edge butted end to end, capped with a thin metal strip,
 * lying on the ground (`ground(x)` gives its height, so it follows sloping sand). Render `wood` with a weathered wood
 * material and `metal` with a dull metal one. The default is the Wright brothers' 1903 rail: 60 ft of 2 by 4 timbers
 * in four 15 ft lengths.
 * @throws TypeError or RangeError for a bad option.
 */
export function generateLaunchRail(options: LaunchRailOptions = {}): LaunchRail {
  if (typeof options !== 'object' || options === null) throw new TypeError('Invalid rail options; pass an object.');
  const length = num('rail length', options.length, 1, 60, 18.3),
    sections = Math.round(num('rail sections', options.sections, 1, 12, 4)),
    [tw, th] = options.timber ?? [0.038, 0.089],
    ground = options.ground ?? (() => 0),
    rand = random((num('seed', options.seed, 0, 2 ** 31, 1) * 2654435761 + 11) >>> 0);
  if (!(tw > 0 && th > 0 && tw < 0.5 && th < 0.5))
    throw new RangeError('Rail timber is out of range; pass a width and height above 0 and under 0.5 m.');
  const wood: GeometryData[] = [],
    metal: GeometryData[] = [],
    piece = length / sections;
  for (let i = 0; i < sections; i++) {
    const x0 = i * piece + (i ? 0.004 : 0),
      x1 = (i + 1) * piece,
      g0 = ground(x0),
      g1 = ground(x1),
      angle = Math.atan2(g1 - g0, x1 - x0),
      run = Math.hypot(x1 - x0, g1 - g0),
      cx = (x0 + x1) / 2,
      cy = (g0 + g1) / 2 + th / 2 - 0.01 + 0.004 * (rand() - 0.5);
    // Pitch the timber about z to follow the slope.
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const timber = grain(boxGeometry(run, th, tw), [run, th, tw], th, (i * 5) % COLUMNS, x0 / ALONG);
    wood.push(applyMatrix4(timber, [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, cx, cy, 0, 1]));
    if (options.strip ?? true)
      metal.push(
        applyMatrix4(boxGeometry(run, 0.003, tw * 0.7), [
          c,
          s,
          0,
          0,
          -s,
          c,
          0,
          0,
          0,
          0,
          1,
          0,
          cx - s * (th / 2 + 0.0015),
          cy + c * (th / 2 + 0.0015),
          0,
          1,
        ]),
      );
  }
  const finish = (list: GeometryData[]) => computeTangents(mergeGeometries(list));
  return { parts: metal.length ? { wood: finish(wood), metal: finish(metal) } : { wood: finish(wood) } };
}
