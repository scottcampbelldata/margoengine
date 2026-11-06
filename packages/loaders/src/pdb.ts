// Protein Data Bank .pdb files: ATOM and HETATM records, CONECT bonds and bonds found by distance.
import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { floats, limits, toText, uints, type BinaryInput } from './util.js';

const F = 'PDB';
/** Colour and covalent radius in angstroms of the common elements. Other elements draw pink at 1.5. */
const ELEMENTS: Record<string, [number, number]> = Object.assign(Object.create(null), {
  H: [0xffffff, 0.31],
  C: [0x909090, 0.76],
  N: [0x3050f8, 0.71],
  O: [0xff0d0d, 0.66],
  F: [0x90e050, 0.57],
  NA: [0xab5cf2, 1.66],
  MG: [0x8aff00, 1.41],
  P: [0xff8000, 1.07],
  S: [0xffff30, 1.05],
  CL: [0x1ff01f, 1.02],
  K: [0x8f40d4, 2.03],
  CA: [0x3dff00, 1.76],
  MN: [0x9c7ac7, 1.39],
  FE: [0xe06633, 1.32],
  CO: [0xf090a0, 1.26],
  NI: [0x50d050, 1.24],
  CU: [0xc88033, 1.32],
  ZN: [0x7d80b0, 1.22],
  SE: [0xffa100, 1.2],
  BR: [0xa62929, 1.2],
  I: [0x940094, 1.39],
});
const OTHER: [number, number] = [0xff1493, 1.5];
/** Slack added to two covalent radii when finding bonds by distance. */
const BOND_SLACK = 0.45;

/** Options of {@link parsePDB}. `maxVertices` counts atoms. */
export interface PDBOptions extends ParseLimits {
  /** Add bonds by distance, because standard residues have no CONECT records. Default true. */
  guessBonds?: boolean;
}

/** One atom's labels, in the order of `positions`. */
export interface PDBAtom {
  serial: number;
  /** The atom's name, such as `CA`. */
  name: string;
  /** The element's symbol in capitals. */
  element: string;
  /** The residue's name, such as `ALA`. */
  residue: string;
  /** The residue's sequence number. */
  sequence: number;
  chain: string;
  /** True for a HETATM record. */
  hetero: boolean;
}

/** What {@link parsePDB} returns: the atoms as a point cloud in angstroms. */
export interface PDBMolecule extends LoadedGeometry {
  kind: 'points';
  colors: Float32Array;
  atoms: PDBAtom[];
  /** Covalent radius per atom, in angstroms. */
  radii: Float32Array;
  /** Two atom indices per bond, each bond once. */
  bonds: Uint32Array;
  /** The TITLE records joined, when the file has them. */
  title?: string;
  /** Things the parser moved past, each listed once. */
  warnings: string[];
}

function column(line: string, start: number, end: number, lineNumber: number, what: string): number {
  const value = Number(line.slice(start, end));
  if (!line.slice(start, end).trim() || !Number.isFinite(value))
    throw new LoaderError(F, 'syntax', `line ${lineNumber} has a bad ${what}`);
  return value;
}

function element(line: string, name: string): string {
  const written = line.slice(76, 78).trim().toUpperCase();
  if (/^[A-Z]{1,2}$/.test(written)) return written;
  // Older files leave the column empty: the element ends the name's first two columns, so " CA " is carbon, "CA  " calcium.
  const letters = name.slice(0, 2).replace(/[^A-Za-z]/g, '').toUpperCase();
  return name[0] === ' ' || /\d/.test(name[0]) ? letters.slice(-1) : letters;
}

/** Every pair of atoms close enough for their radii, through a grid of the largest bond length. */
function nearbyPairs(positions: Float32Array, radii: Float32Array, add: (a: number, b: number) => void): void {
  let largest = 0;
  for (const radius of radii) largest = Math.max(largest, radius);
  const cell = largest * 2 + BOND_SLACK,
    grid = new Map<string, number[]>(),
    id = (x: number, y: number, z: number): string => `${x} ${y} ${z}`;
  for (let i = 0; i < radii.length; i++) {
    const x = Math.floor(positions[i * 3] / cell),
      y = Math.floor(positions[i * 3 + 1] / cell),
      z = Math.floor(positions[i * 3 + 2] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(id(x + dx, y + dy, z + dz)) ?? []) {
            const limit = radii[i] + radii[j] + BOND_SLACK,
              distance = Math.hypot(
                positions[i * 3] - positions[j * 3],
                positions[i * 3 + 1] - positions[j * 3 + 1],
                positions[i * 3 + 2] - positions[j * 3 + 2],
              );
            if (distance > 0.4 && distance <= limit) add(j, i);
          }
    const own = id(x, y, z),
      list = grid.get(own);
    if (list) list.push(i);
    else grid.set(own, [i]);
  }
}

/**
 * Reads a Protein Data Bank `.pdb` file: ATOM and HETATM records by their fixed columns, element colours and radii,
 * CONECT bonds, and bonds by distance for the residues the format leaves unconnected. Only the first MODEL loads, and an
 * atom with alternate locations keeps its first.
 *
 * @param input The file's bytes or text.
 * @param options The shared size limits and whether to find bonds by distance.
 * @returns The atoms as a point cloud with colours, labels, radii and bonds.
 * @throws LoaderError with code `syntax` for a bad column or no atoms, or `limit`.
 *
 * @example
 * ```ts
 * import { parsePDB } from '@margoengine/loaders/pdb';
 *
 * const text = [
 *   'ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O',
 *   'ATOM      2  H1  HOH A   1       0.960   0.000   0.000  1.00  0.00           H',
 * ].join('\n');
 * const { atoms, bonds } = parsePDB(text);
 * console.log(atoms[0].element, bonds);
 * ```
 */
export function parsePDB(input: BinaryInput | string, options: PDBOptions = {}): PDBMolecule {
  const text = toText(input, F),
    { maxVertices } = limits(options, F),
    positions = floats(),
    colors = floats(),
    atoms: PDBAtom[] = [],
    radii: number[] = [],
    serials = new Map<number, number>(),
    connections: [number, number][] = [],
    seen = new Set<string>(),
    warnings = new Set<string>(),
    title: string[] = [];
  let lineNumber = 0,
    ended = false;
  if ((text.match(/^MODEL/gm)?.length ?? 0) > 1) warnings.add('only the first MODEL is read');
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    lineNumber++;
    const record = line.slice(0, 6).trim();
    if (record === 'ENDMDL') ended = true;
    else if (record === 'TITLE') title.push(line.slice(10).trim());
    // CONECT rows come after the last model, so reading goes on past ENDMDL for them alone.
    else if (ended && record !== 'CONECT') continue;
    else if (record === 'ATOM' || record === 'HETATM') {
      const name = line.slice(12, 16),
        chain = line[21] ?? ' ',
        sequence = column(line, 22, 26, lineNumber, 'residue number'),
        id = `${chain} ${sequence} ${line[26] ?? ' '} ${name}`;
      // An atom with alternate locations appears once per location.
      if (line[16] !== ' ' && line[16] !== undefined && seen.has(id)) continue;
      seen.add(id);
      if (atoms.length >= maxVertices)
        throw new LoaderError(F, 'limit', `atom count exceeds the limit of ${maxVertices}`);
      const symbol = element(line, name),
        [rgb, radius] = ELEMENTS[symbol] ?? OTHER,
        serial = column(line, 6, 11, lineNumber, 'serial');
      positions.push3(
        column(line, 30, 38, lineNumber, 'x'),
        column(line, 38, 46, lineNumber, 'y'),
        column(line, 46, 54, lineNumber, 'z'),
      );
      colors.push3((rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255);
      serials.set(serial, atoms.length);
      radii.push(radius);
      atoms.push({
        serial,
        name: name.trim(),
        element: symbol,
        residue: line.slice(17, 20).trim(),
        sequence,
        chain: chain.trim(),
        hetero: record === 'HETATM',
      });
    } else if (record === 'CONECT') {
      const from = column(line, 6, 11, lineNumber, 'serial');
      for (let at = 11; at + 5 <= line.length + 4 && at < 31; at += 5)
        if (line.slice(at, at + 5).trim()) connections.push([from, column(line, at, at + 5, lineNumber, 'serial')]);
    }
  }
  if (!atoms.length) throw new LoaderError(F, 'syntax', 'the file has no ATOM or HETATM records');

  const bonds = uints(),
    known = new Set<number>(),
    add = (a: number, b: number): void => {
      const low = Math.min(a, b),
        high = Math.max(a, b),
        id = low * atoms.length + high;
      if (low === high || known.has(id)) return;
      known.add(id);
      bonds.push(low);
      bonds.push(high);
    };
  for (const [from, to] of connections) {
    const a = serials.get(from),
      b = serials.get(to);
    // A CONECT row may name an atom of a model or an alternate location that was not read.
    if (a === undefined || b === undefined) warnings.add('CONECT names atoms that were not read');
    else add(a, b);
  }
  const packed = positions.result(),
    sizes = Float32Array.from(radii);
  if (options.guessBonds ?? true) nearbyPairs(packed, sizes, add);
  const result: PDBMolecule = {
    kind: 'points',
    positions: packed,
    colors: colors.result(),
    atoms,
    radii: sizes,
    bonds: bonds.result(),
    warnings: [...warnings],
  };
  if (title.length) result.title = title.join(' ');
  return result;
}
