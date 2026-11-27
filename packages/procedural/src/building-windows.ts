// The windows of a block of a joined plan (building-plans.ts) where another block's walls or roof stand against them:
// such a window is moved along its bay or up its storey, else narrowed or shortened, until it is clear of them, and left
// out where no useful window remains. So none opens into another block's roof space. Internal to
// @margoengine/procedural; our own code, clean room from:
// - NHBC Standards 2024, 7.1.15 "Detailing of flat roofs" and 7.1.16 "Accessible thresholds and upstands": where a
//   roof meets a wall the waterproofing runs at least 150 mm up it above the roof's surface, so an opening's sill
//   stands no lower, https://nhbc-standards.co.uk/7-roofs/7-1-flat-roofs-and-balconies/7-1-15-detailing-of-flat-roofs/
// - Sutherland, I. E., Hodgman, G. W. 1974, "Reentrant polygon clipping", Communications of the ACM 17(1) 32-42,
//   https://doi.org/10.1145/360767.360802 (the window's rectangle cut by each face of a block's solid).
import type { Hole } from './building-interiors.js';
import type { V3 } from './mesh-builder.js';

/** Marks a building's options with the fit its windows take (set by building-plans.ts). */
export const WINDOW_FIT: unique symbol = Symbol('windowFit');
/** Where a window may go on its wall: `a` along the side, `y` up, local metres. */
export interface WindowRoom {
  readonly a0: number;
  readonly a1: number;
  readonly y1: number;
}
/** A wall side as building-rules.ts lays it out, local. */
export interface WindowSide {
  readonly start: V3;
  readonly dir: V3;
  readonly out: V3;
}
/** The window to build for a wanted one, or null for none. */
export type WindowFit = (hole: Hole, side: WindowSide, room: WindowRoom) => Hole | null;

/** Half-spaces `[x, y, z, d]`, inside where the dot product is at most `d`. */
export type Convex = readonly (readonly [number, number, number, number])[];

/** Height a roof's flashing takes up a wall, which also keeps a window's trim off a wall beside it, metres. */
const CLEAR = 0.15;
/** The smallest window worth keeping, and the narrowest outer door (IRC R311.2: 32 in clear), metres. */
const MIN_WIDTH = 0.4;
const MIN_HEIGHT = 0.45;
const MIN_DOOR = 0.82;
/** The room a door's frame keeps from a wall beside it, metres: no roof stands under a door, so no flashing does. */
const DOOR_CLEAR = 0.02;

interface Box {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

/** The bounds of the part of `r` where `alpha * a + beta * y <= gamma` for every cut, or null when none is left. */
function clipped(r: Box, cuts: readonly (readonly [number, number, number])[]): Box | null {
  let poly: [number, number][] = [
    [r.a0, r.y0],
    [r.a1, r.y0],
    [r.a1, r.y1],
    [r.a0, r.y1],
  ];
  for (const [alpha, beta, gamma] of cuts) {
    const next: [number, number][] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length],
        dp = alpha * p[0] + beta * p[1] - gamma,
        dq = alpha * q[0] + beta * q[1] - gamma;
      if (dp <= 0) next.push(p);
      if (dp <= 0 !== dq <= 0) {
        const t = dp / (dp - dq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    poly = next;
    if (!poly.length) return null;
  }
  const as = poly.map((p) => p[0]),
    ys = poly.map((p) => p[1]),
    out = { a0: Math.min(...as), a1: Math.max(...as), y0: Math.min(...ys), y1: Math.max(...ys) };
  // A touch along an edge or at a corner covers nothing.
  return out.a1 - out.a0 > 1e-6 && out.y1 - out.y0 > 1e-6 ? out : null;
}

/**
 * The fit for a block whose neighbours' solids are `others`, in the frame `place` puts the block's local points in. A
 * wall is `thickness` thick: an opening must be clear just in front of its face and right through the wall. Doors keep
 * their sills and heights; a door with no room left beside what covers it is left out, another way in being made where
 * the plan then has none (building-plans.ts).
 */
export function windowFit(others: readonly Convex[], place: (p: V3) => V3, thickness: number): WindowFit {
  return (hole, side, room) => {
    // Each solid as cuts of the wall's own plane, at depths through the wall.
    const planes = [0.05, -thickness / 2, -thickness - 0.05].map((off) => {
      const at = (a: number, y: number) =>
          place([
            side.start[0] + side.dir[0] * a + side.out[0] * off,
            y,
            side.start[2] + side.dir[2] * a + side.out[2] * off,
          ]),
        o = at(0, 0),
        u = at(1, 0),
        v = at(0, 1);
      return others.map((solid) =>
        solid.map(([x, y, z, d]): [number, number, number] => {
          const base = x * o[0] + y * o[1] + z * o[2];
          return [
            x * (u[0] - o[0]) + y * (u[1] - o[1]) + z * (u[2] - o[2]),
            x * (v[0] - o[0]) + y * (v[1] - o[1]) + z * (v[2] - o[2]),
            d - base,
          ];
        }),
      );
    });
    const door = hole.kind === 'door',
      margin = door ? DOOR_CLEAR : CLEAR;
    // The bounds of everything within the clearance of an opening.
    const covered = (r: Box, clear = margin): Box | null => {
      const grown = { a0: r.a0 - clear, a1: r.a1 + clear, y0: r.y0 - clear, y1: r.y1 + clear };
      let hit: Box | null = null;
      for (const cuts of planes.flat()) {
        const c = clipped(grown, cuts);
        if (!c) continue;
        hit = hit
          ? {
              a0: Math.min(hit.a0, c.a0),
              a1: Math.max(hit.a1, c.a1),
              y0: Math.min(hit.y0, c.y0),
              y1: Math.max(hit.y1, c.y1),
            }
          : c;
      }
      return hit;
    };
    const fixed = door || hole.kind === 'balcony-door',
      narrowest = door ? Math.min(MIN_DOOR, hole.a1 - hole.a0) : MIN_WIDTH,
      // Whether a point just in front of the wall is inside another block.
      taken = (a: number, y: number) =>
        planes[0].some((cuts) => cuts.every(([alpha, beta, gamma]) => alpha * a + beta * y <= gamma));
    // A door that other blocks take whole goes with its wall: it is not one to move.
    const across = [0.01, 0.5, 0.99];
    if (
      door &&
      across.every((u) =>
        across.every((v) => taken(hole.a0 + (hole.a1 - hole.a0) * u, hole.y0 + (hole.y1 - hole.y0) * v)),
      )
    )
      return hole;
    const left = Math.min(room.a0, hole.a0),
      right = Math.max(room.a1, hole.a1),
      top = Math.max(room.y1, hole.y1),
      gap = margin + 1e-3;
    let best: Box | null = null,
      score = -Infinity;
    // Away from what covers it, whole where the wall allows, else cut short; the largest window nearest its place wins.
    const search = (r: Box, depth: number) => {
      const w = r.a1 - r.a0,
        h = r.y1 - r.y0;
      if (w < narrowest - 1e-9 || h < (fixed ? 0 : MIN_HEIGHT - 1e-9)) return;
      const moved = Math.abs(r.a0 + r.a1 - hole.a0 - hole.a1) + Math.abs(r.y0 + r.y1 - hole.y0 - hole.y1),
        worth = w * h - 0.1 * moved;
      // Every step from here only moves further or cuts more.
      if (worth <= score) return;
      const hit = covered(r);
      if (!hit) {
        best = r;
        score = worth;
        return;
      }
      if (depth === 5) return;
      const a0 = hit.a1 + gap,
        a1 = hit.a0 - gap;
      if (a0 > r.a0) search({ ...r, a0, a1: Math.min(right, a0 + w) }, depth + 1);
      if (a1 < r.a1) search({ ...r, a1, a0: Math.max(left, a1 - w) }, depth + 1);
      if (fixed) return;
      const y0 = hit.y1 + gap;
      if (y0 > r.y0) search({ ...r, y0, y1: Math.min(top, y0 + h) }, depth + 1);
      if (hit.y0 - gap < r.y1) search({ ...r, y1: hit.y0 - gap }, depth + 1);
    };
    search(hole, 0);
    const found = best as Box | null;
    if (!found) return null;
    return { ...hole, a0: found.a0, a1: found.a1, y0: found.y0, y1: found.y1 };
  };
}
