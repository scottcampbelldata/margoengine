import type { Tile } from './index.js';

/** One authored tile. Socket labels match by exact equality on opposite faces. */
export interface SocketTile {
  /** +X, -X, +Y, -Y, +Z, -Z labels; each label describes an orientation-independent connector. */
  sockets: readonly string[];
  /** Total relative frequency across this source's variants, default 1. */
  weight?: number;
  /** Rotations around +Y (default), all 24 proper cube rotations, or identity only. */
  rotations?: 'y' | 'cube' | 'none';
}
/** Expanded solver tile and the transform needed to render its authored geometry. */
export interface SocketVariant extends Tile {
  /** Index into the authored source array. */
  source: number;
  /** Column-major 3x3 rotation, mapping source vectors to world vectors. No reflections. */
  rotation: readonly number[];
  /** Rotated labels, in solver direction order. */
  sockets: readonly string[];
}
const faces = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Build reciprocal adjacency and stable Uint16-compatible IDs for ConstrainedWFC; at most 4096 variants. */
export function buildSocketTiles(sources: readonly SocketTile[]): SocketVariant[] {
  const variants: SocketVariant[] = [];
  if (!sources.length) throw new RangeError('WFC sockets need at least one source tile');
  sources.forEach((source, index) => {
    const mode = source.rotations ?? 'y',
      weight = source.weight ?? 1;
    if (
      source.sockets.length !== 6 ||
      source.sockets.some((s) => typeof s !== 'string') ||
      !['y', 'cube', 'none'].includes(mode) ||
      !Number.isFinite(weight) ||
      weight <= 0
    )
      throw new RangeError(
        'Invalid WFC sockets; provide six string labels, positive finite weight and y/cube/none rotations',
      );
    const rotations: number[][] = [];
    for (const x of faces)
      for (const y of faces) {
        if (x.some((v, i) => v && y[i])) continue;
        const z = cross(x, y),
          matrix = [...x, ...y, ...z].map((v) => v || 0);
        if (mode !== 'cube' && (y[0] !== 0 || y[1] !== 1 || y[2] !== 0)) continue;
        if (mode === 'none' && x[0] !== 1) continue;
        rotations.push(matrix);
      }
    for (const rotation of rotations) {
      const sockets = Array<string>(6);
      faces.forEach((face, d) => {
        const transformed = [0, 1, 2].map(
          (r) => face[0] * rotation[r] + face[1] * rotation[3 + r] + face[2] * rotation[6 + r],
        );
        const target = faces.findIndex((f) => f.every((v, r) => v === transformed[r]));
        sockets[target] = source.sockets[d];
      });
      variants.push({ source: index, rotation, sockets, weight: weight / rotations.length, neighbors: [] });
    }
    if (variants.length > 4096) throw new RangeError('WFC sockets support at most 4096 expanded variants');
  });
  for (const variant of variants)
    variant.neighbors = variant.sockets.map((label, d) =>
      variants.flatMap((other, id) => (other.sockets[d ^ 1] === label ? [id] : [])),
    );
  return variants;
}
