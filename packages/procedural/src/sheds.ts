// Board-built sheds and a wooden launch rail: frame-and-plank buildings with lapped horizontal or vertical siding, door
// and window openings, door leaves (closed, open or swung up as an awning), a gabled roof, corner boards and fascia,
// and a straight timber rail capped with a metal strip. Our own shapes from boxes; local origin on the ground at the
// middle of the floor, +Y up, metres. Seeded and deterministic.
// Clean room from public building descriptions, no other engine's code:
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

/** A shed from {@link generatePlankShed}: one mesh part per material, all with UVs, tangents and unit normals. */
export interface PlankShed {
  readonly parts: {
    /** Wall boards and door leaves. */
    readonly siding: GeometryData;
    /** Roof boards. */
    readonly roof: GeometryData;
    /** Corner boards, fascia and the ridge board. */
    readonly trim: GeometryData;
  };
  /** Height of the ridge above the floor, metres. */
  readonly ridge: number;
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
/** A box of size (sx, sy, sz) turned by `yaw` about +y, then by `tilt` about its own x axis, centred at (x, y, z). */
function board(sx: number, sy: number, sz: number, x: number, y: number, z: number, yaw = 0, tilt = 0): GeometryData {
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    ct = Math.cos(tilt),
    st = Math.sin(tilt);
  // Columns: local x turned by yaw; local y and z turned by tilt about local x, then by yaw.
  return applyMatrix4(boxGeometry(sx, sy, sz), [
    c,
    0,
    -s,
    0,
    s * st,
    ct,
    c * st,
    0,
    s * ct,
    -st,
    c * ct,
    0,
    x,
    y,
    z,
    1,
  ]);
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
    trim: GeometryData[] = [];
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
          siding.push(board(length, B, T, x, yy, z, wall.yaw, tilt + age * 0.01 * (rand() - 0.5)));
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
          siding.push(board(w - 0.003, q - p, T, x, yy, z, wall.yaw, age * 0.004 * (rand() - 0.5)));
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
    if (leaf === 'closed') siding.push(board(w - 0.02, ht - 0.02, T, hx, hy, hz, wall.yaw));
    else if (leaf === 'awning') {
      // Hinged along the top edge and propped up 75 degrees: its middle swings out and up.
      const angle = (75 * Math.PI) / 180,
        r = ht / 2;
      siding.push(
        board(
          w - 0.02,
          ht - 0.02,
          T,
          hx + out[0] * r * Math.sin(angle),
          h.top - r * Math.cos(angle),
          hz + out[2] * r * Math.sin(angle),
          wall.yaw,
          -angle,
        ),
      );
    } else {
      // Hinged on its left edge and swung out 100 degrees.
      const angle = (100 * Math.PI) / 180,
        r = w / 2,
        [lx, , lz] = wall.place(h.a, 0),
        yaw = wall.yaw - angle,
        cx = lx + Math.cos(yaw) * r,
        cz = lz - Math.sin(yaw) * r;
      siding.push(board(w - 0.02, ht - 0.02, T, cx, hy, cz, yaw));
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
      roof.push(board(span - age * 0.02 * rand(), 0.025, w - 0.004, 0, y, z, 0, side * pitch));
    }
    // Fascia board along the eaves.
    const e = slope - 0.02;
    trim.push(
      board(span, 0.14, 0.025, 0, ridge - e * Math.sin(pitch) - 0.05, side * (e * Math.cos(pitch) + 0.01), 0, 0),
    );
  }
  trim.push(board(span, 0.05, 0.12, 0, ridge + 0.06, 0));
  // Corner boards up the four corners.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) trim.push(board(0.1, E, 0.1, sx * (L / 2 + 0.02), E / 2, sz * (W / 2 + 0.02)));
  const finish = (list: GeometryData[]) => computeTangents(mergeGeometries(list));
  return { parts: { siding: finish(siding), roof: finish(roof), trim: finish(trim) }, ridge };
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
    wood.push(applyMatrix4(boxGeometry(run, th, tw), [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, cx, cy, 0, 1]));
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
