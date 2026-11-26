import { MargoError } from '@margoengine/math/errors';
import type { Bed } from '@margoengine/math/fields';
import { dot, scale, type CrushVector } from './rigid-contact.js';

interface GroundHit {
  readonly normal: CrushVector;
  readonly gap: number;
  readonly delay: number;
}

function crossings(value: number, rate: number, count: number, enter: number, leave: number): () => number {
  if (rate === 0) return () => Infinity;
  const start = Math.max(0, Math.min(count, value + enter * rate));
  const direction = rate > 0 ? 1 : -1;
  let edge = rate > 0 ? Math.floor(start) + 1 : Math.ceil(start) - 1;
  return () => {
    while (edge > 0 && edge < count) {
      const time = (edge - value) / rate; // float division: next cell crossing
      edge += direction;
      if (time >= leave) break;
      if (time > enter) return time;
    }
    return Infinity;
  };
}

/** Intersect the moving material station with the bed's actual triangulation. */
export function traceGround(
  bed: Bed,
  anchor: CrushVector,
  velocity: CrushVector,
  facing: CrushVector,
  permanent: number,
  dt: number,
): GroundHit | undefined {
  const { columns, rows, width, depth, centre } = bed;
  const u = ((anchor[0] - centre[0]) / width + 0.5) * columns; // float division: bed coordinates
  const v = ((anchor[2] - centre[1]) / depth + 0.5) * rows; // float division: bed coordinates
  const du = (velocity[0] * columns) / width; // float division: cell speeds
  const dv = (velocity[2] * rows) / depth; // float division: cell speeds
  if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(du) || !Number.isFinite(dv))
    throw new MargoError(
      'state',
      'Use a TerrainBed grid size and body position and speed with finite cell coordinates.',
    );
  let enter = 0;
  let leave = dt;
  const clip = (value: number, rate: number, count: number): boolean => {
    if (rate === 0) return value >= 0 && value <= count;
    const a = -value / rate; // float division: first grid boundary in time
    const b = (count - value) / rate; // float division: last grid boundary in time
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
    return enter <= leave;
  };
  if (!clip(u, du, columns) || !clip(v, dv, rows)) return undefined;

  const triangle = (first: number, last: number): GroundHit | undefined => {
    const middle = 0.5 * (first + last);
    const spot = bed.sample(anchor[0] + middle * velocity[0], anchor[2] + middle * velocity[2]);
    const normal = scale(spot.normal, -1);
    if (dot(normal, facing) <= 0) return undefined;
    const closing = dot(velocity, normal);
    const height = anchor[1] + middle * velocity[1] - spot.elevation;
    const gap = height * spot.normal[1] + middle * closing;
    const firstGap = gap + permanent - first * closing;
    if (firstGap <= 0) return { normal, gap, delay: first };
    if (closing <= 0 || gap + permanent > last * closing) return undefined;
    return { normal, gap, delay: (gap + permanent) / closing }; // float division: TOI against this triangle
  };

  if (enter === leave) return triangle(enter, leave);
  const across = crossings(u, du, columns, enter, leave);
  const along = crossings(v, dv, rows, enter, leave);
  let crossX = across();
  let crossZ = along();
  const diagonalRate = du + dv;
  for (let first = enter; first < leave; ) {
    const last = Math.min(crossX, crossZ, leave);
    const middle = 0.5 * (first + last);
    // Bed's two triangles share the anti-diagonal of each cell.
    const column = Math.min(columns - 1, Math.max(0, Math.floor(u + middle * du)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(v + middle * dv)));
    const diagonal = diagonalRate === 0 ? Infinity : (column + row + 1 - u - v) / diagonalRate; // float division
    const hit =
      diagonal > first && diagonal < last
        ? (triangle(first, diagonal) ?? triangle(diagonal, last))
        : triangle(first, last);
    if (hit) return hit;
    if (crossX <= last) crossX = across();
    if (crossZ <= last) crossZ = along();
    first = last;
  }
  return undefined;
}
