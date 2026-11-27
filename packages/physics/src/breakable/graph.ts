// Connection graph and structural support analysis (Parker & O'Brien 2009):
// Tracks per-bond damage, resolves connected islands across unbroken bonds, and separates
// anchor-supported islands from unsupported overhangs that detach and fall.

/** A fracture bond joining two adjacent Voronoi cells across a shared cut face. */
export interface BreakableBond {
  /** Index of this bond within its parent {@link BreakableBody.bonds} array. */
  readonly index: number;
  /** Index of the first cell connected by this bond. */
  readonly cellA: number;
  /** Index of the second cell connected by this bond. */
  readonly cellB: number;
  /** Shared cut-face area in square metres. */
  readonly area: number;
  /** Shared cut-face centroid in the parent body's original local frame. */
  readonly localCentroid: readonly [number, number, number];
  /** Unit normal from `cellA` toward `cellB` in the parent body's original local frame. */
  readonly localNormal: readonly [number, number, number];
  /** Impulse threshold in N·s required to sever this bond. */
  strength: number;
  /** Accumulated impulse damage in N·s on this bond. */
  damage: number;
  /** True once `damage >= strength`. */
  broken: boolean;
  /** Normalized remaining bond health in [0, 1] (`0` when broken, `1` when undamaged). */
  readonly health: number;
}

/** Internal mutable bond implementation with live `health` getter. */
export class BondRecord implements BreakableBond {
  readonly index: number;
  readonly cellA: number;
  readonly cellB: number;
  readonly area: number;
  readonly localCentroid: readonly [number, number, number];
  readonly localNormal: readonly [number, number, number];
  strength: number;
  readonly initialStrength: number;
  damage = 0;
  broken = false;

  constructor(
    index: number,
    cellA: number,
    cellB: number,
    area: number,
    localCentroid: readonly [number, number, number],
    localNormal: readonly [number, number, number],
    strength: number,
  ) {
    this.index = index;
    this.cellA = cellA;
    this.cellB = cellB;
    this.area = area;
    this.localCentroid = localCentroid;
    this.localNormal = localNormal;
    this.strength = strength;
    this.initialStrength = strength;
  }

  get health(): number {
    if (this.broken || !(this.strength > 0)) return 0;
    const remaining = 1 - this.damage / this.strength;
    return remaining > 0 ? remaining : 0;
  }

  reset(): void {
    this.damage = 0;
    this.broken = false;
  }
}

/** A connected component of active cells linked by intact bonds. */
export interface GraphComponent {
  readonly cells: number[];
  readonly anchored: boolean;
}

/**
 * Partitions `cellIndices` into connected components across unbroken bonds.
 * A component is marked `anchored` when at least one of its cells is anchored.
 */
export function findConnectedComponents(
  cellIndices: readonly number[],
  cellCount: number,
  bonds: readonly BreakableBond[],
  anchoredFlags: Uint8Array,
): GraphComponent[] {
  const member = new Uint8Array(cellCount);
  for (let i = 0; i < cellIndices.length; i++) member[cellIndices[i]!] = 1;

  // Build adjacency lists restricted to unbroken bonds between active cells.
  const adjacency: number[][] = Array.from({ length: cellCount }, () => []);
  for (let i = 0; i < bonds.length; i++) {
    const b = bonds[i]!;
    if (b.broken) continue;
    if (member[b.cellA] && member[b.cellB]) {
      adjacency[b.cellA]!.push(b.cellB);
      adjacency[b.cellB]!.push(b.cellA);
    }
  }

  const visited = new Uint8Array(cellCount);
  const queue: number[] = [];
  const components: GraphComponent[] = [];

  for (let i = 0; i < cellIndices.length; i++) {
    const start = cellIndices[i]!;
    if (visited[start]) continue;
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    const cells: number[] = [];
    let anchored = false;
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      cells.push(current);
      if (anchoredFlags[current]) anchored = true;
      const neighbors = adjacency[current]!;
      for (let j = 0; j < neighbors.length; j++) {
        const next = neighbors[j]!;
        if (!visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    components.push({ cells, anchored });
  }
  return components;
}
