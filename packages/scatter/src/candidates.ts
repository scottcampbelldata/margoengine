import { createLcgRandom } from '@margoengine/math/mathutils';
import type { GroundBounds, GroundPlacement } from './placement.js';
import { validateExclusions } from './placement.js';

function random(seed: number, scale: readonly [number, number]): () => number {
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    scale.length !== 2 ||
    !Number.isFinite(scale[0]) ||
    !Number.isFinite(scale[1]) ||
    scale[0] <= 0 ||
    scale[0] > scale[1]
  )
    throw new RangeError(
      'Invalid placement seed or scale; use an integer seed from 0 to 4294967295 and scale as [min, max] with 0 < min <= max.',
    );
  return createLcgRandom(seed);
}
function count(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 1000000)
    throw new RangeError('Invalid placement candidate count; pass an integer from 0 to 1000000.');
}

/** Seeded rectangle candidates; submit the result to PlacementLayout to reserve clear footprints. */
export function randomPlacements(
  total: number,
  bounds: GroundBounds,
  scale: readonly [number, number],
  seed = 1,
): GroundPlacement[] {
  validateExclusions([bounds]);
  count(total);
  const next = random(seed, scale),
    placements: GroundPlacement[] = [];
  for (let i = 0; i < total; i++)
    placements.push([
      bounds[0] + next() * (bounds[2] - bounds[0]),
      bounds[1] + next() * (bounds[3] - bounds[1]),
      scale[0] + next() * (scale[1] - scale[0]),
      next() * Math.PI * 2,
    ]);
  return placements;
}

/** Seeded candidates around world XZ anchors; occupancy is resolved by PlacementLayout. */
export function radialPlacements(
  centers: readonly (readonly [number, number])[],
  perCenter: number,
  distance: readonly [number, number],
  scale: readonly [number, number],
  seed = 1,
): GroundPlacement[] {
  count(perCenter);
  count(centers.length * perCenter);
  if (
    distance.length !== 2 ||
    !Number.isFinite(distance[0]) ||
    !Number.isFinite(distance[1]) ||
    distance[0] < 0 ||
    distance[0] > distance[1]
  )
    throw new RangeError('Invalid radial placement distance; pass [min, max] as finite numbers with 0 <= min <= max.');
  const next = random(seed, scale),
    placements: GroundPlacement[] = [];
  for (const center of centers) {
    if (center.length !== 2 || !Number.isFinite(Math.fround(center[0])) || !Number.isFinite(Math.fround(center[1])))
      throw new RangeError('Invalid placement center; pass each center as finite [x, z] numbers.');
    for (let i = 0; i < perCenter; i++) {
      const angle = next() * Math.PI * 2,
        radius = distance[0] + next() * (distance[1] - distance[0]);
      placements.push([
        center[0] + Math.cos(angle) * radius,
        center[1] + Math.sin(angle) * radius,
        scale[0] + next() * (scale[1] - scale[0]),
        next() * Math.PI * 2,
      ]);
    }
  }
  return placements;
}
