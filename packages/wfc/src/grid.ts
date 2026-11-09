import type { CellPosition } from './constraints.js';
import type { Tile } from './index.js';

/** Internal copied/validated rules, shared by the two local-domain representations. */
export function prepareGrid(dimensions: CellPosition, tiles: readonly Tile[]) {
  const size = dimensions[0] * dimensions[1] * dimensions[2],
    T = tiles.length,
    B = Math.ceil(T / 32);
  if (
    dimensions.length !== 3 ||
    Array.from(dimensions).some((n) => !Number.isInteger(n) || n < 1) ||
    !Number.isSafeInteger(size) ||
    size > 1_000_000 ||
    T < 1 ||
    T > 4096 ||
    size * T > 16_777_216
  )
    throw new RangeError(
      'Invalid constrained WFC grid; use 1..4096 tiles, positive dimensions and at most 16,777,216 cell/tile pairs',
    );
  const weights = Float64Array.from(tiles, (t) => t.weight ?? 1),
    logs = weights.map((w) => w * Math.log(w));
  if (
    weights.some((w) => !Number.isFinite(w) || w <= 0) ||
    !Number.isFinite(weights.reduce((a, b) => a + b, 0)) ||
    !Number.isFinite(logs.reduce((a, b) => a + b, 0))
  )
    throw new RangeError(
      'Invalid WFC weights; use positive finite weights whose sum and weighted logarithms stay finite',
    );
  const adjacency = new Uint32Array(T * 6 * B);
  tiles.forEach((tile, t) => {
    if (tile.neighbors.length !== 6)
      throw new TypeError('Invalid WFC adjacency; give each tile exactly six neighbour lists');
    for (let d = 0; d < 6; d++) {
      const list = tile.neighbors[d];
      if (!list) throw new TypeError('Invalid WFC adjacency; give each tile exactly six neighbour lists');
      for (const u of list) {
        if (!Number.isInteger(u) || u < 0 || u >= T)
          throw new RangeError('Invalid WFC adjacency; use existing tile IDs and reciprocal opposite directions');
        adjacency[(t * 6 + d) * B + (u >>> 5)] |= 1 << (u & 31);
      }
    }
  });
  const copied = tiles.map((tile, t) => ({
    weight: weights[t],
    neighbors: tile.neighbors.map((list, d) => {
      for (const u of list)
        if (!(adjacency[(u * 6 + (d ^ 1)) * B + (t >>> 5)] & (1 << (t & 31))))
          throw new RangeError('Invalid WFC adjacency; use existing tile IDs and reciprocal opposite directions');
      return [...new Set(list)];
    }),
  }));
  return { size, tiles: copied, weights, logs, dimensions: [...dimensions] as [number, number, number] };
}
