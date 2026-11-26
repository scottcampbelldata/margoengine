import { MargoError } from '@margoengine/math/errors';
import { type CrushVector, dot, sub } from './rigid-contact.js';
import { shellEdgeKey } from './shell-topology.js';

type Boundary = readonly [number, number];

/** Coincident boundary edges with a bilinear, irreversible traction law. */
export interface CrushSheetSeam {
  /** Opposite sides of the seam. Give each edge in the same endpoint order. */
  readonly sides: readonly [Boundary, Boundary];
  /** Initial cohesive stiffness in Pa per metre of opening. */
  readonly stiffness: number;
  /** Peak traction in Pa. */
  readonly peakTraction: number;
  /** Total separation energy per unit undeformed section area in J/m². */
  readonly toughness: number;
}

/** Live state of a cohesive shell seam. */
export interface CrushSheetSeamReading {
  /** Current relative displacement magnitude at the two Gauss points, m. */
  readonly separation: Boundary;
  /** Maximum history coordinate at each Gauss point, capped at total release, m. */
  readonly history: Boundary;
  /** Recoverable interface energy, J. */
  readonly elasticEnergy: number;
  /** Irreversible interface fracture work, J. */
  readonly fractureWork: number;
  /** Area between the released edges, m². Zero while the seam still transmits load. */
  readonly openingArea: number;
  readonly broken: boolean;
}

export const SEAM_STATE_WORDS = 8;

export function prepareSeams(
  seams: readonly CrushSheetSeam[],
  positions: readonly CrushVector[],
  boundaryEdges: ReadonlySet<string>,
  masses: Float64Array,
  thickness: number,
): { packed: ArrayBuffer; frequencySquared: number } {
  const packed = new ArrayBuffer(seams.length * 48);
  const indices = new Uint32Array(packed);
  const scalars = new Float64Array(packed);
  const used = new Set<string>();
  const stiffnessByVertex = new Float64Array(positions.length);
  for (const [i, seam] of seams.entries()) {
    const [front, back] = seam.sides;
    if (front.length !== 2 || back.length !== 2)
      throw new MargoError('state', 'Give a shell seam two boundary edges of two vertices each.');
    const [a, b] = front;
    const [c, d] = back;
    const nodes = [a, b, c, d];
    const pairs = [shellEdgeKey(a, b), shellEdgeKey(c, d)];
    if (
      nodes.some((vertex) => !Number.isSafeInteger(vertex) || vertex < 0 || vertex >= positions.length) ||
      new Set(nodes).size !== 4 ||
      pairs.some((key) => !boundaryEdges.has(key) || used.has(key))
    )
      throw new MargoError('state', 'Pair two distinct existing shell boundaries and use each boundary only once.');
    const frontStart = positions[a]!;
    const frontEnd = positions[b]!;
    const same = (p: CrushVector, q: CrushVector) => p.every((value, j) => value === q[j]);
    if (!same(frontStart, positions[c]!) || !same(frontEnd, positions[d]!))
      throw new MargoError('state', 'Give the two shell boundaries matching rest positions and endpoint order.');
    const { stiffness, peakTraction, toughness } = seam;
    const initiation = peakTraction / stiffness;
    const failure = (2 * toughness) / peakTraction;
    if (
      ![stiffness, peakTraction, toughness, initiation, failure].every(
        (value) => value > 0 && Number.isFinite(value),
      ) ||
      !(failure > initiation)
    )
      throw new MargoError('state', 'Use positive cohesive properties and choose a failure opening above initiation.');
    for (const key of pairs) used.add(key);
    const direction = sub(frontEnd, frontStart);
    const area = Math.sqrt(dot(direction, direction)) * thickness;
    const tangentBound = Math.max(stiffness, (stiffness * initiation) / (failure - initiation));
    const rowBound = area * tangentBound;
    if (!(rowBound > 0 && Number.isFinite(rowBound)))
      throw new MargoError('state', 'Use a finite area and a finite traction slope for the shell seam.');
    for (const vertex of nodes) stiffnessByVertex[vertex]! += rowBound;
    indices.set(nodes, 12 * i);
    scalars.set([stiffness, initiation, failure, area], 6 * i + 2);
  }
  let frequencySquared = 0;
  for (let i = 0; i < masses.length; i++)
    frequencySquared = Math.max(frequencySquared, stiffnessByVertex[i]! / masses[i]!);
  return { packed, frequencySquared };
}

export function readSeamRow(words: Float64Array, at: number): CrushSheetSeamReading {
  return {
    history: [words[at]!, words[at + 1]!],
    separation: [words[at + 2]!, words[at + 3]!],
    elasticEnergy: words[at + 4]!,
    fractureWork: words[at + 5]!,
    openingArea: words[at + 6]!,
    broken: words[at + 7] === 1,
  };
}
