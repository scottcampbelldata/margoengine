import type { PDBAtom, PDBMolecule } from '@margoengine/loaders/pdb';
import { rangeError } from '../../shared/errors.js';
import type { Bounds } from './layer.js';

/** Molecular representation: scaled atom balls, full van der Waals balls, or equal-radius sticks. */
export type MoleculeStyle = 'ball-and-stick' | 'space-filling' | 'licorice';
/** Opaque analytic spheres and closed cylinders in angstroms. */
export interface MoleculeOptions {
  /** Default ball-and-stick. */
  readonly style?: MoleculeStyle;
  /** Ball radius as a fraction of van der Waals radius, default .3. Space filling uses 1. */
  readonly atomScale?: number;
  /** Cylinder radius, also the licorice atom radius. Default .2 angstrom. */
  readonly bondRadius?: number;
  /** Display only these atom indices and bonds whose two ends are selected. Default all. */
  readonly atomIndices?: ArrayLike<number>;
}
/** A complete author residue identity. Distinct insertion codes remain distinct residues. */
export interface MoleculeResidue {
  readonly chain: string;
  readonly id: string;
  readonly insertionCode: string;
  readonly name: string;
  readonly atoms: Uint32Array;
}
/** Nearest displayed analytic surface hit, in structure coordinates. */
export interface MoleculePick {
  readonly atomIndex: number;
  readonly atom: PDBAtom;
  readonly residue: MoleculeResidue;
  /** A bond hit identifies the nearer endpoint's residue. */
  readonly bond?: readonly [number, number];
  readonly position: readonly [number, number, number];
  /** Distance along the normalized input ray, in angstroms. */
  readonly distance: number;
}
// Bondi (1964) radii, with Ca from Mantina et al. (2009). Unlisted elements use 2 angstroms explicitly.
const VDW: Readonly<Record<string, number>> = {
  H: 1.2,
  HE: 1.4,
  C: 1.7,
  N: 1.55,
  O: 1.52,
  F: 1.47,
  NE: 1.54,
  NA: 2.27,
  MG: 1.73,
  SI: 2.1,
  P: 1.8,
  S: 1.8,
  CL: 1.75,
  AR: 1.88,
  K: 2.75,
  CA: 2.31,
  NI: 1.63,
  CU: 1.4,
  ZN: 1.39,
  GA: 1.87,
  AS: 1.85,
  SE: 1.9,
  BR: 1.85,
  KR: 2.02,
  PD: 1.63,
  AG: 1.72,
  CD: 1.58,
  IN: 1.93,
  SN: 2.17,
  TE: 2.06,
  I: 1.98,
  XE: 2.16,
  PT: 1.75,
  AU: 1.66,
  HG: 1.55,
  TL: 1.96,
  PB: 2.02,
  U: 1.86,
};
export const moleculeError = (message: string): never => {
  throw rangeError(`Molecule: ${message}; correct the structure or display options`, 'sciviz');
};
export interface MoleculeSnapshot {
  data: Float32Array;
  ends: readonly (readonly [number, number])[];
  atoms: readonly PDBAtom[];
  residues: readonly MoleculeResidue[];
  atomResidue: Uint32Array;
  bounds: Bounds;
}
/** @internal Owned immutable inputs for the GPU, picking, and device restore. */
export function moleculeSnapshot(input: PDBMolecule, options: MoleculeOptions): MoleculeSnapshot {
  const count = input.atoms.length,
    style = options.style ?? 'ball-and-stick',
    scale = options.atomScale ?? 0.3,
    radius = options.bondRadius ?? 0.2;
  if (
    !['ball-and-stick', 'space-filling', 'licorice'].includes(style) ||
    !(scale > 0) ||
    !Number.isFinite(Math.fround(scale)) ||
    !(radius > 0) ||
    !Number.isFinite(Math.fround(radius))
  )
    moleculeError('check style and positive finite atomScale/bondRadius');
  if (
    input.positions.length !== count * 3 ||
    input.colors.length !== count * 3 ||
    input.radii.length !== count ||
    input.bonds.length % 2
  )
    moleculeError('inconsistent molecule array lengths');
  const selected = new Set<number>();
  for (let j = 0; j < (options.atomIndices?.length ?? count); j++) {
    const i = options.atomIndices ? options.atomIndices[j] : j;
    if (!Number.isSafeInteger(i) || i < 0 || i >= count) moleculeError('atom selection contains an invalid index');
    selected.add(i);
  }
  const atoms = input.atoms.map((a) => ({ ...a })),
    residues: MoleculeResidue[] = [],
    atomResidue = new Uint32Array(count),
    groups = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const a = atoms[i],
      identity = JSON.stringify([a.chain, a.residueId ?? String(a.sequence), a.insertionCode ?? '', a.residue]),
      g = groups.get(identity);
    if (g) g.push(i);
    else groups.set(identity, [i]);
  }
  for (const indices of groups.values()) {
    const a = atoms[indices[0]],
      id = residues.length;
    residues.push({
      chain: a.chain,
      id: a.residueId ?? String(a.sequence),
      insertionCode: a.insertionCode ?? '',
      name: a.residue,
      atoms: Uint32Array.from(indices),
    });
    for (const i of indices) atomResidue[i] = id;
  }
  const packed: number[] = [],
    ends: [number, number][] = [],
    bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  function append(a: number, b: number, r: number): void {
    const start = Array.from(input.positions.subarray(a * 3, a * 3 + 3)),
      end = Array.from(input.positions.subarray(b * 3, b * 3 + 3));
    if (!(r > 0) || !Number.isFinite(Math.fround(r))) moleculeError('atom radius exceeds float32 range');
    const ca = Array.from(input.colors.subarray(a * 3, a * 3 + 3)),
      cb = Array.from(input.colors.subarray(b * 3, b * 3 + 3));
    if ([...start, ...end, ...ca, ...cb].some((v) => !Number.isFinite(v)) || [...ca, ...cb].some((v) => v < 0 || v > 1))
      moleculeError('positions and element colours must be finite, colours in [0,1]');
    if (a !== b && Math.hypot(...start.map((v, k) => v - end[k])) === 0) return;
    packed.push(...start, r, ...end, a === b ? 0 : 1, ...ca, 0, ...cb, 0);
    ends.push([a, b]);
    for (let k = 0; k < 3; k++) {
      bounds[k * 2] = Math.min(bounds[k * 2], start[k] - r, end[k] - r);
      bounds[k * 2 + 1] = Math.max(bounds[k * 2 + 1], start[k] + r, end[k] + r);
    }
  }
  for (const i of selected)
    append(
      i,
      i,
      style === 'licorice'
        ? radius
        : (VDW[atoms[i].element.toUpperCase()] ?? 2) * (style === 'space-filling' ? 1 : scale),
    );
  for (let i = 0; i < input.bonds.length; i += 2) {
    const a = input.bonds[i],
      b = input.bonds[i + 1];
    if (a >= count || b >= count || a === b) moleculeError('bond contains an invalid atom index');
    if (style !== 'space-filling' && selected.has(a) && selected.has(b)) append(a, b, radius);
  }
  if (ends.length && bounds.some((v) => !Number.isFinite(Math.fround(v))))
    moleculeError('molecule bounds exceed float32 range; translate/rescale the structure');
  return {
    data: Float32Array.from(packed),
    ends,
    atoms,
    residues,
    atomResidue,
    bounds: (ends.length ? bounds : [0, 0, 0, 0, 0, 0]) as unknown as Bounds,
  };
}
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): number[] => a.map((v, k) => v - b[k]);
/** @internal Stable quadratic roots of A*t*t+2*B*t+C. */
function roots(a: number, b: number, c: number): number[] {
  const d = b * b - a * c;
  if (!(a > 0) || d < 0) return [];
  const q = -b - (b >= 0 ? 1 : -1) * Math.sqrt(d);
  return q === 0 ? [-b / a] : [q / a, c / q];
}
/** @internal Same closed sphere/cylinder surface used by the fragment shader, including end caps. */
export function intersectMoleculePrimitive(
  data: Float32Array,
  index: number,
  origin: readonly number[],
  direction: readonly number[],
): number {
  const at = index * 16,
    a = Array.from(data.subarray(at, at + 3)),
    b = Array.from(data.subarray(at + 4, at + 7)),
    r = data[at + 3],
    o = sub(origin, a);
  let best = Infinity;
  const accept = (t: number): void => {
    if (t >= 0 && t < best) best = t;
  };
  if (!data[at + 7]) {
    for (const t of roots(dot(direction, direction), dot(o, direction), dot(o, o) - r * r)) accept(t);
    return best;
  }
  const axis = sub(b, a),
    length = Math.hypot(...axis),
    n = axis.map((v) => v / length),
    od = dot(o, n),
    dd = dot(direction, n),
    op = o.map((v, k) => v - od * n[k]),
    dp = direction.map((v, k) => v - dd * n[k]);
  for (const t of roots(dot(dp, dp), dot(op, dp), dot(op, op) - r * r)) {
    const h = od + t * dd;
    if (h >= 0 && h <= length) accept(t);
  }
  if (dd !== 0)
    for (const h of [0, length]) {
      const t = (h - od) / dd,
        p = op.map((v, k) => v + t * dp[k]);
      if (dot(p, p) <= r * r) accept(t);
    }
  return best;
}
/** @internal Ray in data coordinates, independent of canvas and GPU. */
export function pickMoleculeSnapshot(
  data: MoleculeSnapshot,
  origin: readonly number[],
  direction: readonly number[],
): MoleculePick | null {
  const length = Math.hypot(...direction);
  if (
    origin.length !== 3 ||
    direction.length !== 3 ||
    ![...origin, ...direction].every(Number.isFinite) ||
    !(length > 0)
  )
    moleculeError('ray requires a finite origin and nonzero direction');
  const d = direction.map((v) => v / length);
  let distance = Infinity,
    index = -1;
  for (let i = 0; i < data.ends.length; i++) {
    const t = intersectMoleculePrimitive(data.data, i, origin, d);
    if (t < distance) {
      distance = t;
      index = i;
    }
  }
  if (index < 0) return null;
  const position = origin.map((v, k) => v + d[k] * distance) as [number, number, number],
    [a, b] = data.ends[index],
    at = index * 16;
  const pa = Array.from(data.data.subarray(at, at + 3)),
    pb = Array.from(data.data.subarray(at + 4, at + 7)),
    axis = sub(pb, pa),
    atomIndex = a === b || dot(sub(position, pa), axis) <= dot(axis, axis) * 0.5 ? a : b;
  return {
    atomIndex,
    atom: { ...data.atoms[atomIndex] },
    residue: data.residues[data.atomResidue[atomIndex]],
    position,
    distance,
    ...(a !== b ? { bond: [a, b] as const } : {}),
  };
}
