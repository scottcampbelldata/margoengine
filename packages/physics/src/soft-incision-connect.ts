import { FACES, faceKey, type SliceCell, type SlicePoint } from './soft-plane-cut.js';

function disjointSets(size: number) {
  const parent = Int32Array.from({ length: size }, (_, i) => i);
  const find = (i: number): number => {
    while (i !== parent[i]) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  return {
    find,
    join: (a: number, b: number) => {
      parent[find(a)] = find(b);
    },
  };
}

/** Each unreleased face joins its two cells and the three corresponding corner slots. */
export function incisionPieces(
  cells: readonly SliceCell[],
  points: SlicePoint[],
  severed: ReadonlySet<string>,
  trackFront?: true | ReadonlySet<string>,
): { pieces: SliceCell[][]; crackFront: ReadonlySet<string> | undefined } {
  const bodies = disjointSets(cells.length);
  const corners = disjointSets(4 * cells.length);
  const awaiting = new Map<string, number>();
  cells.forEach(({ nodes }, cell) => {
    for (const face of FACES) {
      const key = faceKey(face.map((slot) => nodes[slot]));
      if (severed.has(key)) continue;
      const neighbor = awaiting.get(key);
      if (neighbor === undefined) {
        awaiting.set(key, cell);
        continue;
      }
      bodies.join(neighbor, cell);
      const previous = cells[neighbor]!.nodes;
      for (const slot of face) corners.join(4 * neighbor + previous.indexOf(nodes[slot]), 4 * cell + slot);
    }
  });
  const firstGroup = new Map<number, number>();
  const aliases = new Map<number, number>();
  const pieces = new Map<number, SliceCell[]>();
  const lipFaces = trackFront && new Map<string, number[]>();
  const crackFront = trackFront && new Set<string>();
  cells.forEach((cell, i) => {
    const nodes = cell.nodes.map((point, slot) => {
      const root = corners.find(4 * i + slot);
      const had = aliases.get(root);
      if (had !== undefined) return had;
      const original = firstGroup.get(point);
      const copy = original === undefined ? point : points.push(points[point]!) - 1;
      if (original === undefined) firstGroup.set(point, root);
      aliases.set(root, copy);
      return copy;
    }) as SliceCell['nodes'];
    const root = bodies.find(i);
    const piece = pieces.get(root) ?? [];
    piece.push({ ...cell, nodes });
    pieces.set(root, piece);
    if (lipFaces && crackFront) {
      for (const face of FACES) {
        const key = faceKey(face.map((slot) => cell.nodes[slot]));
        if (!severed.has(key)) continue;
        const lip = face.map((slot) => nodes[slot]);
        const previous = lipFaces.get(key);
        if (!previous) {
          lipFaces.set(key, lip);
          continue;
        }
        // The open faces retain exactly the two shared particles at a bonded front.
        const shared = face.filter((slot) => previous.includes(nodes[slot]));
        if (
          shared.length === 2 &&
          (trackFront === true || trackFront?.has(faceKey(shared.map((slot) => cell.nodes[slot]))))
        )
          crackFront.add(faceKey(shared.map((slot) => nodes[slot])));
      }
    }
  });
  return { pieces: [...pieces.values()], crackFront };
}
