import type { Rect } from './layout.js';

/** A direction of spatial navigation. */
export type Direction = 'up' | 'down' | 'left' | 'right';

const center = (r: Rect) => [r.x + r.width / 2, r.y + r.height / 2] as const;

/**
 * Pick where focus moves from `from` in `direction` among `candidates` (rectangles in UI units, in document order).
 * A candidate qualifies when its centre lies beyond the centre of `from` in that direction. Among those, ones that overlap
 * `from` on the other axis (a neighbour in the same row or column) beat ones that do not; then the nearest edge wins,
 * with sideways misalignment counting twice. Ties go to the earlier candidate. Returns an index into `candidates`, or -1.
 * With `wrap`, when nothing lies ahead, the farthest candidate in the opposite direction that best lines up is chosen
 * (down from the last row goes to the first).
 */
export function moveFocus(from: Rect, candidates: readonly Rect[], direction: Direction, wrap = false): number {
  const horizontal = direction === 'left' || direction === 'right',
    sign = direction === 'right' || direction === 'down' ? 1 : -1,
    [fx, fy] = center(from);
  let best = -1,
    bestScore = Infinity;
  const score = (r: Rect, ahead: boolean): number => {
    const [cx, cy] = center(r),
      along = horizontal ? (cx - fx) * sign : (cy - fy) * sign,
      across = Math.abs(horizontal ? cy - fy : cx - fx),
      overlap = horizontal
        ? Math.min(r.y + r.height, from.y + from.height) - Math.max(r.y, from.y) > 0
        : Math.min(r.x + r.width, from.x + from.width) - Math.max(r.x, from.x) > 0,
      gap = horizontal
        ? Math.max(0, sign > 0 ? r.x - (from.x + from.width) : from.x - (r.x + r.width))
        : Math.max(0, sign > 0 ? r.y - (from.y + from.height) : from.y - (r.y + r.height));
    // Wrapping prefers the farthest one that lines up, so the "gap" counts the other way round.
    return (ahead ? gap + along * 0.001 : along) + across * 2 + (overlap ? 0 : 100000);
  };
  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i],
      [cx, cy] = center(r),
      along = horizontal ? (cx - fx) * sign : (cy - fy) * sign;
    if (along <= 1e-6) continue;
    const s = score(r, true);
    if (s < bestScore) {
      bestScore = s;
      best = i;
    }
  }
  if (best >= 0 || !wrap) return best;
  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i],
      [cx, cy] = center(r),
      along = horizontal ? (cx - fx) * sign : (cy - fy) * sign;
    if (along >= -1e-6) continue;
    const s = score(r, false);
    if (s < bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}
