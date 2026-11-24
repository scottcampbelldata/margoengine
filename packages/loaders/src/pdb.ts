// Protein Data Bank .pdb files: ATOM and HETATM records, CONECT bonds and bonds found by distance.
import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { elementProperties, nearbyPairs } from './molecule-common.js';
import { floats, limits, toText, uints, type BinaryInput } from './util.js';

const F = 'PDB';
/** Options of {@link parsePDB}. `maxVertices` counts atoms. */
export interface PDBOptions extends ParseLimits {
  /** Add bonds by distance, because standard residues have no CONECT records. Default true. */
  guessBonds?: boolean;
}

/** One atom's labels, in the order of `positions`. */
export interface PDBAtom {
  serial: number;
  /** Original atom id, when the format provides a non-numeric identifier. */
  id?: string;
  /** Residue identifier in the author namespace, including non-numeric mmCIF ids. */
  residueId?: string;
  /** PDB insertion code, blank when absent. */
  insertionCode?: string;
  /** Selected alternate location, blank when absent. */
  alternateLocation?: string;
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
        [rgb, radius] = elementProperties(symbol),
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
        ...((line[26] ?? '').trim() ? { insertionCode: line[26] } : {}),
        ...((line[16] ?? '').trim() ? { alternateLocation: line[16] } : {}),
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
