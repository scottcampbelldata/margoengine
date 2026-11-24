// PDBx/mmCIF coordinate structures, written from the IUCr CIF 1.1 syntax and wwPDB dictionary.
import { LoaderError } from './types.js';
import { limits, toText, type BinaryInput } from './util.js';
import { elementProperties, nearbyPairs } from './molecule-common.js';
import type { PDBAtom, PDBMolecule, PDBOptions } from './pdb.js';

/** Coordinate loader options. The first data block is read by default. */
export interface MMCIFOptions extends PDBOptions {
  /** Data block name without data_. Case insensitive. */
  block?: string;
}
interface Token {
  value: string;
  bare: boolean;
}
const F = 'mmCIF';
function fail(message: string): never {
  throw new LoaderError(F, 'syntax', message);
}
const present = (v: string | undefined): string => (v === '.' || v === '?' ? '' : (v ?? ''));
const control = (t: Token): boolean => t.bare && /^(?:_|data_|save_|loop_$|stop_$|global_$)/i.test(t.value);

/** One token of lookahead, retaining whether a reserved-looking value was quoted. */
class Scanner {
  #at = 0;
  #next: Token | undefined;
  constructor(readonly text: string) {}
  peek(): Token | undefined {
    return (this.#next ??= this.#read());
  }
  take(): Token | undefined {
    const t = this.peek();
    this.#next = undefined;
    return t;
  }
  #read(): Token | undefined {
    const s = this.text;
    while (this.#at < s.length) {
      if (/\s/.test(s[this.#at])) {
        this.#at++;
        continue;
      }
      if (s[this.#at] === '#') {
        while (this.#at < s.length && s[this.#at] !== '\n') this.#at++;
        continue;
      }
      break;
    }
    if (this.#at >= s.length) return undefined;
    const start = this.#at++,
      first = s[start];
    if (first === ';' && (start === 0 || s[start - 1] === '\n')) {
      const end = s.indexOf('\n;', this.#at);
      if (end < 0) fail('unterminated semicolon text field');
      this.#at = end + 2;
      if (this.#at < s.length && !/\s/.test(s[this.#at])) fail('text-field delimiter must end its line');
      return { value: s.slice(start + 1, end).replace(/\r\n/g, '\n').replace(/\r$/, ''), bare: false };
    }
    if (first === "'" || first === '"') {
      while (this.#at < s.length) {
        const at = this.#at++;
        if (s[at] === '\n' || s[at] === '\r') fail('quoted fields cannot contain line breaks');
        if (s[at] === first && (this.#at === s.length || /\s/.test(s[this.#at])))
          return { value: s.slice(start + 1, at), bare: false };
      }
      fail('unterminated quoted field');
    }
    while (this.#at < s.length && !/\s/.test(s[this.#at])) this.#at++;
    return { value: s.slice(start, this.#at), bare: true };
  }
}
type Row = Map<string, string>;
const get = (row: Row, ...names: string[]): string => {
  for (const n of names) {
    const value = row.get(n.toLowerCase()) ?? '';
    if (value) return value;
  }
  return '';
};
const key = (...v: string[]): string => JSON.stringify(v);

/**
 * Parse the first coordinate model of a PDBx/mmCIF data block in angstroms. Supports CIF 1.1 quoted and
 * semicolon text fields, loops, author/label identifiers, first alternate locations, and identity-symmetry
 * covalent/disulfide struct_conn records. Optional distance bonds use the PDB loader's covalent radii.
 * Returns the same structure as parsePDB; crystal/biological assembly expansion is a separate operation.
 */
export function parseMMCIF(input: BinaryInput | string, options: MMCIFOptions = {}): PDBMolecule {
  const scanner = new Scanner(toText(input, F)),
    { maxVertices } = limits(options, F),
    atoms: PDBAtom[] = [],
    xyz: number[] = [],
    colors: number[] = [],
    radii: number[] = [],
    seen = new Set<string>(),
    warnings = new Set<string>(),
    connections: Row[] = [],
    labels = new Map<string, number>(),
    authors = new Map<string, number>();
  let selected = false,
    found = false,
    model = '',
    title = '';
  function row(category: string, r: Row): void {
    if (category === '_struct_conn') {
      connections.push(r);
      return;
    }
    if (category !== '_atom_site') return;
    const current = get(r, '_atom_site.pdbx_pdb_model_num') || '1';
    if (!model) model = current;
    if (model !== current) {
      warnings.add('only the first MODEL is read');
      return;
    }
    const chain = get(r, '_atom_site.auth_asym_id', '_atom_site.label_asym_id'),
      residueId = get(r, '_atom_site.auth_seq_id', '_atom_site.label_seq_id'),
      name = get(r, '_atom_site.auth_atom_id', '_atom_site.label_atom_id'),
      residue = get(r, '_atom_site.auth_comp_id', '_atom_site.label_comp_id'),
      insertionCode = get(r, '_atom_site.pdbx_pdb_ins_code'),
      alternateLocation = get(r, '_atom_site.label_alt_id'),
      identity = key(chain, residueId, insertionCode, residue, name);
    if (!name || !residue || !residueId) fail('atom_site is missing atom or residue identifiers');
    if (seen.has(identity)) return;
    seen.add(identity);
    if (atoms.length >= maxVertices) throw new LoaderError(F, 'limit', `atom count exceeds ${maxVertices}`);
    const values = ['x', 'y', 'z'].map((k) => {
      const text = get(r, '_atom_site.cartn_' + k),
        v = Number(text);
      if (!text || !Number.isFinite(v) || !Number.isFinite(Math.fround(v))) fail('invalid Cartesian coordinate');
      return v;
    });
    const element = get(r, '_atom_site.type_symbol').toUpperCase();
    if (!/^[A-Z]{1,2}$/.test(element)) fail('atom_site requires a chemical element symbol');
    const [rgb, radius] = elementProperties(element),
      id = get(r, '_atom_site.id'),
      serial = Number(id),
      seq = Number(residueId),
      labelSeq = Number(get(r, '_atom_site.label_seq_id'));
    const atom: PDBAtom = {
      serial: id && Number.isSafeInteger(serial) ? serial : atoms.length + 1,
      id,
      name,
      element,
      residue,
      residueId,
      insertionCode,
      alternateLocation,
      sequence: Number.isSafeInteger(seq) ? seq : Number.isSafeInteger(labelSeq) ? labelSeq : 0,
      chain,
      hetero: get(r, '_atom_site.group_pdb').toUpperCase() === 'HETATM',
    };
    authors.set(key(chain, residueId, insertionCode, name), atoms.length);
    labels.set(
      key(
        get(r, '_atom_site.label_asym_id'),
        get(r, '_atom_site.label_seq_id'),
        get(r, '_atom_site.label_comp_id'),
        get(r, '_atom_site.label_atom_id'),
      ),
      atoms.length,
    );
    atoms.push(atom);
    xyz.push(...values);
    radii.push(radius);
    colors.push((rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255);
  }
  const single = new Map<string, Row>();
  const flush = (): void => {
    for (const [cat, r] of single) row(cat, r);
    single.clear();
  };
  while (scanner.peek()) {
    const t = scanner.take()!;
    const low = t.value.toLowerCase();
    if (t.bare && low.startsWith('data_')) {
      if (selected) {
        flush();
        break;
      }
      selected = options.block === undefined ? !found : low.slice(5) === options.block.toLowerCase();
      if (selected) found = true;
      continue;
    }
    if (!selected) continue;
    if (t.bare && low === 'loop_') {
      flush();
      const tags: string[] = [];
      while (scanner.peek()?.bare && scanner.peek()!.value.startsWith('_'))
        tags.push(scanner.take()!.value.toLowerCase());
      if (!tags.length || new Set(tags).size !== tags.length) fail('loop requires unique data names');
      const category = tags[0].split('.')[0];
      if (tags.some((tag) => tag.split('.')[0] !== category)) fail('loop mixes data categories');
      while (scanner.peek() && !control(scanner.peek()!)) {
        const r: Row = new Map();
        for (const tag of tags) {
          const value = scanner.take();
          if (!value || control(value)) fail('incomplete loop row');
          r.set(tag, value.bare ? present(value.value) : value.value);
        }
        row(category, r);
      }
    } else if (t.bare && low.startsWith('_')) {
      const value = scanner.take();
      if (!value || control(value)) fail('data name has no value');
      const cat = low.split('.')[0],
        r = single.get(cat) ?? new Map<string, string>();
      if (r.has(low)) fail('duplicate data name');
      r.set(low, value.bare ? present(value.value) : value.value);
      single.set(cat, r);
      if (low === '_struct.title') title = value.bare ? present(value.value) : value.value;
    } else if (t.bare && low === 'stop_') continue;
    else fail('unexpected token or unsupported save frame in coordinate data block');
  }
  flush();
  if (!atoms.length) fail('selected data block has no atom_site coordinates');
  const bonds: number[] = [],
    known = new Set<string>(),
    add = (a: number, b: number): void => {
      const low = Math.min(a, b),
        high = Math.max(a, b),
        id = `${low}:${high}`;
      if (low === high || known.has(id)) return;
      known.add(id);
      bonds.push(low, high);
    };
  for (const r of connections) {
    const type = get(r, '_struct_conn.conn_type_id').toLowerCase();
    if (!type.startsWith('covale') && type !== 'disulf') continue;
    const partner = (n: number): number | undefined => {
      const p = `_struct_conn.ptnr${n}_`,
        extra = `_struct_conn.pdbx_ptnr${n}_`,
        symmetry = get(r, p + 'symmetry');
      if (symmetry && symmetry !== '1_555') {
        warnings.add('symmetry-related struct_conn bonds require crystal expansion');
        return undefined;
      }
      const alt = get(r, extra + 'label_alt_id');
      const index =
        authors.get(
          key(
            get(r, p + 'auth_asym_id'),
            get(r, p + 'auth_seq_id'),
            get(r, extra + 'pdb_ins_code'),
            get(r, p + 'auth_atom_id', p + 'label_atom_id'),
          ),
        ) ??
        labels.get(
          key(
            get(r, p + 'label_asym_id'),
            get(r, p + 'label_seq_id'),
            get(r, p + 'label_comp_id'),
            get(r, p + 'label_atom_id'),
          ),
        );
      return index !== undefined && (!alt || atoms[index].alternateLocation === alt) ? index : undefined;
    };
    const a = partner(1),
      b = partner(2);
    if (a !== undefined && b !== undefined) add(a, b);
    else warnings.add('struct_conn names atoms not present in the selected model/conformer');
  }
  const positions = Float32Array.from(xyz),
    sizes = Float32Array.from(radii);
  if (options.guessBonds ?? true) nearbyPairs(positions, sizes, add);
  return {
    kind: 'points',
    positions,
    atoms,
    radii: sizes,
    colors: Float32Array.from(colors),
    bonds: Uint32Array.from(bonds),
    warnings: [...warnings],
    ...(title ? { title } : {}),
  };
}
