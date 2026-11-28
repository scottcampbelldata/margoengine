// Escape from the storeys of a rules building: whether a storey asks for a second stair, how far its rooms walk to one,
// how much of that way two stairs share and how far apart they stand. Internal to @margoengine/procedural; our own
// code, clean room from:
// - Japan, Building Standard Law Enforcement Order (https://laws.e-gov.go.jp/api/1/lawdata/325CO0000000338): art. 120,
//   the walk from a room to a direct stair at most 40 m, 50 m in a fire-resistive or noncombustible building; art. 121
//   para. 1 item 6, two stairs from a storey on the 6th floor or above with habitable rooms, and below it where their
//   floor area passes 200 m2 on the storey directly over the ground one or 100 m2 on another; para. 2, those areas
//   doubled for a fire-resistive or noncombustible building; para. 3, the way common to both at most half the walk.
// - International Building Code 2021 1007.1.1, two exits at least half the diagonal of the area served apart (without
//   sprinklers), as quoted in ICC interpretation 86-22, https://www3.iccsafe.org/cs/committeeArea/pdf_file/BU_21_86_22.pdf.
// - IBC Table 1006.3.4(2), a single exit from a second storey of Group B only up to 29 occupants and 75 ft of travel and
//   none from a third, and Table 1004.5, 150 square feet gross to an occupant of business areas, both read from a
//   summary of the 2024 model code, https://datadrivenaec.com/insights/ibc-exit-requirements.
// - Dijkstra, E. W. 1959, "A note on two problems in connexion with graphs", Numerische Mathematik 1, 269-271,
//   https://doi.org/10.1007/BF01386390: the shortest ways from a stair through the doorways.
import type { BuildingRoomUse, BuildingStyle } from './building-rules.js';

/** A storey's way out. */
export interface BuildingEscape {
  /** The storey, 1 the one over the ground floor. */
  readonly floor: number;
  /**
   * Why the style's code asks for two stairs here: the floor area or occupants, the storey's height, or a room walking
   * too far to one; null where one will do.
   */
  readonly required: 'area' | 'storey' | 'walk' | null;
  /**
   * What the code asks of this storey that the building does not give, absent where it gives all that is checked:
   * `stair-off`, a second stair is asked and `escapeStair` is false; `no-room`, no framed or winder stair stands clear
   * of the first, a quarter of the diagonal from it, in a room or a stair hall; `walk` (Japan), a room walks farther
   * than the limit to the nearer of two stairs; `shared` (Japan), the way its two walks share passes half the limit.
   */
  readonly unmet?: 'stair-off' | 'no-room' | 'walk' | 'shared';
  /** Stairs down from this storey: 1, or 2. */
  readonly stairs: number;
  /** The farthest walk from a room's corner to its nearest stair, metres, and the most the code allows. */
  readonly walk: number;
  readonly walkLimit: number;
  /** Straight between the nearest ends of two stairs, and the diagonal of the floor inside its walls, metres. */
  readonly apart?: number;
  readonly diagonal: number;
  /** The longest walk a room has before its ways to two stairs part, metres. */
  readonly shared?: number;
}

type Point = readonly [number, number];
export interface EscapeRoom {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}
/** A storey as it is walked: its rooms, what each is used as, and the openings between them (local `[x, z]`). */
export interface EscapeFloor {
  readonly rooms: readonly EscapeRoom[];
  readonly uses: readonly BuildingRoomUse[];
  readonly ways: readonly Point[];
}

const FOOT = 0.3048,
  /** IBC: 75 ft of travel with one exit; 29 occupants of 150 sq ft gross from a second storey. */
  ONE_EXIT_TRAVEL = 75 * FOOT,
  ONE_EXIT_LOAD = 29,
  GROSS = 150 * FOOT * FOOT,
  HABITABLE: readonly BuildingRoomUse[] = ['living', 'bedroom', 'office', 'kitchen', 'shop'];

/** Concrete and steel-framed styles, fire-resistive or noncombustible under art. 121 para. 2. */
const noncombustible = (style: BuildingStyle) => style === 'japan-2011-concrete' || style === 'japan-2011-warehouse';

/** The most walk to a stair: art. 120, or IBC's travel with one exit; none for a one-family house (IRC). */
export function walkLimit(style: BuildingStyle): number {
  if (style === 'western-1910-house') return Infinity;
  if (!style.startsWith('japan')) return ONE_EXIT_TRAVEL;
  return noncombustible(style) ? 50 : 40;
}

/** Why a storey asks for two stairs, `walk` being the farthest walk to the one it has. */
export function twoStairs(
  style: BuildingStyle,
  k: number,
  floor: EscapeFloor,
  gross: number,
  walk: number,
): BuildingEscape['required'] {
  // A one-family house keeps one stair however large (IRC).
  if (style === 'western-1910-house') return null;
  if (style.startsWith('japan')) {
    const area = floor.rooms.reduce(
      (sum, r, i) => sum + (HABITABLE.includes(floor.uses[i]) ? (r.x1 - r.x0) * (r.z1 - r.z0) : 0),
      0,
    );
    if (k >= 5 && area > 0) return 'storey';
    if (area > (k === 1 ? 200 : 100) * (noncombustible(style) ? 2 : 1)) return 'area';
  } else {
    if (k >= 2) return 'storey';
    if (Math.ceil(gross / GROSS) > ONE_EXIT_LOAD) return 'area';
  }
  return walk > walkLimit(style) + 1e-9 ? 'walk' : null;
}

/** What a storey still lacks, given the walks `both` to its two stairs, undefined where it has one. */
export function unmetBy(
  style: BuildingStyle,
  required: BuildingEscape['required'],
  wanted: boolean,
  both?: { walk: number; shared: number },
): BuildingEscape['unmet'] {
  if (!both) return required ? (wanted ? 'no-room' : 'stair-off') : undefined;
  // IBC's 75 ft is the most travel with one exit only; arts. 120 and 121 para. 3 hold with two stairs too.
  if (!style.startsWith('japan')) return undefined;
  if (both.walk > walkLimit(style) + 1e-9) return 'walk';
  return both.shared > walkLimit(style) / 2 + 1e-9 ? 'shared' : undefined;
}

const within = (r: EscapeRoom, [x, z]: Point) =>
  x >= r.x0 - 0.08 && x <= r.x1 + 0.08 && z >= r.z0 - 0.08 && z <= r.z1 + 0.08;
const far = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The shortest ways from `exit` to every opening, straight across each room: lengths and the next node toward it. */
function ways(floor: EscapeFloor, exit: Point) {
  const nodes: Point[] = [exit, ...floor.ways],
    rooms = nodes.map((p) => floor.rooms.flatMap((r, i) => (within(r, p) ? [i] : []))),
    length = nodes.map((_, i) => (i ? Infinity : 0)),
    next = nodes.map(() => -1),
    done = nodes.map(() => false);
  for (;;) {
    let at = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && (at < 0 || length[i] < length[at])) at = i;
    if (at < 0 || length[at] === Infinity) break;
    done[at] = true;
    for (let i = 0; i < nodes.length; i++) {
      if (done[i] || !rooms[i].some((r) => rooms[at].includes(r))) continue;
      const d = length[at] + far(nodes[at], nodes[i]);
      if (d < length[i]) {
        length[i] = d;
        next[i] = at;
      }
    }
  }
  /** The way from a point of room `room`: its nodes in turn, the exit last, and its length. */
  return (p: Point, room: number) => {
    let best = -1,
      d = Infinity;
    for (let i = 0; i < nodes.length; i++)
      if (rooms[i].includes(room) && far(p, nodes[i]) + length[i] < d) {
        d = far(p, nodes[i]) + length[i];
        best = i;
      }
    const path: Point[] = [];
    for (let i = best; i >= 0; i = next[i]) path.push(nodes[i]);
    return { length: d, path };
  };
}

/** The farthest walk to the nearest of the exits, and with two the longest way they share, from the rooms' corners. */
export function walks(floor: EscapeFloor, exits: readonly Point[]): { walk: number; shared: number } {
  const to = exits.map((e) => ways(floor, e));
  let walk = 0,
    shared = 0;
  floor.rooms.forEach((r, i) => {
    for (const p of [
      [r.x0, r.z0],
      [r.x1, r.z0],
      [r.x0, r.z1],
      [r.x1, r.z1],
    ] as const) {
      const [a, b] = to.map((way) => way(p, i));
      walk = Math.max(walk, b ? Math.min(a.length, b.length) : a.length);
      if (!b) continue;
      let from: Point = p,
        common = 0;
      for (let n = 0; n < Math.min(a.path.length, b.path.length) && a.path[n] === b.path[n]; n++) {
        common += far(from, a.path[n]);
        from = a.path[n];
      }
      shared = Math.max(shared, common);
    }
  });
  return { walk, shared };
}
