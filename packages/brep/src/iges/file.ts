// IGES 5.3 file structure, written from the specification (US PRO/IPO-100-1996, chapter 2): the Fixed Format's
// 80-column lines with a section letter in column 73 and a sequence number in 74-80; the Start, Global, Directory Entry,
// Parameter Data and Terminate sections; free-formatted parameters with the parameter and record delimiters the Global
// Section names (comma and semicolon by default), Hollerith strings (nHtext, which may cross lines), D exponents and
// defaulted (empty) fields; and the 20 fixed fields of each entity's two Directory Entry lines.
import { stepText } from '../step/file.js';

/** A parameter value: a number (integers, reals and pointers), a string, or null for a defaulted field. */
export type IGESValue = number | string | null;

/** One entity: its Directory Entry fields and its parameters. */
export interface IGESEntity {
  /** The sequence number of its first Directory Entry line (odd): what pointers to it hold. */
  readonly de: number;
  readonly type: number;
  readonly form: number;
  /** Directory Entry pointer to its Transformation Matrix (Type 124), or 0. */
  readonly transform: number;
  /** Colour number (1 black ... 8 white) or a negated pointer to a Color Definition (Type 314), 0 when none. */
  readonly color: number;
  readonly level: number;
  /** Blank status: true when the sending system does not display it. */
  readonly blanked: boolean;
  /** Subordinate entity switch: 0 independent, 1 physically, 2 logically, 3 both dependent. */
  readonly subordinate: number;
  /** Entity use flag: 0 geometry, 1 annotation, 2 definition, 3 other, 4 logical, 5 2D parametric, 6 construction. */
  readonly use: number;
  readonly label: string;
  readonly subscript: number;
  /** The parameter data after the entity type number (index 0 is the specification's index 1). */
  readonly params: readonly IGESValue[];
}

/** The Global Section. */
export interface IGESGlobal {
  readonly parameterDelimiter: string;
  readonly recordDelimiter: string;
  readonly sender: string;
  readonly fileName: string;
  readonly system: string;
  readonly preprocessor: string;
  /** Model space units per real-world unit (0.125: one model unit is 8 real-world units). */
  readonly modelScale: number;
  /** The units flag (1 inches ... 11 microinches; 3 means the units name says). */
  readonly unitsFlag: number;
  readonly unitsName: string;
  /** Millimetres per model unit, from the units flag (or name). */
  readonly millimetres: number;
  /** Minimum user-intended resolution, in model units (0 when not given). */
  readonly resolution: number;
  /** Approximate maximum coordinate, in model units (0 when not given). */
  readonly maxCoordinate: number;
  readonly author: string;
  readonly organization: string;
  /** Specification version flag (11 for 5.3). */
  readonly version: number;
  /** Every Global field in order (index 0 is field 1). */
  readonly fields: readonly IGESValue[];
}

/** A parsed IGES file. */
export interface IGESFile {
  /** The Start Section's text, one line per line. */
  readonly start: string;
  readonly global: IGESGlobal;
  /** Entities by the sequence number of their first Directory Entry line. */
  readonly entities: ReadonlyMap<number, IGESEntity>;
}

const fail = (message: string): never => {
  throw new TypeError(`Invalid IGES file: ${message}; export it again from the CAD tool as IGES (fixed ASCII format)`);
};

const UNITS: Readonly<Record<number, number>> = {
  1: 25.4,
  2: 1,
  4: 304.8,
  5: 1609344,
  6: 1000,
  7: 1e6,
  8: 0.0254,
  9: 0.001,
  10: 10,
  11: 0.0000254,
};
const UNIT_NAMES: Readonly<Record<string, number>> = {
  IN: 25.4,
  INCH: 25.4,
  MM: 1,
  FT: 304.8,
  MI: 1609344,
  M: 1000,
  KM: 1e6,
  MIL: 0.0254,
  UM: 0.001,
  MICRON: 0.001,
  CM: 10,
  UIN: 0.0000254,
};

/** A number field: digits with an optional sign, decimal point and E or D exponent. */
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([EeDd][+-]?\d+)?$/;

/**
 * Splits free-formatted text from `at` into fields up to the record delimiter (or the end of the text). Returns the
 * fields and the index after the record delimiter (-1 when the text ended first).
 */
function freeFields(
  text: string,
  at: number,
  pd: string,
  rd: string,
  where: string,
): { values: IGESValue[]; end: number } {
  const values: IGESValue[] = [],
    n = text.length;
  let i = at;
  for (;;) {
    while (i < n && text[i] === ' ') i++;
    if (i >= n) return { values, end: -1 };
    const ch = text[i];
    if (ch === pd) {
      values.push(null);
      i++;
      continue;
    }
    if (ch === rd) {
      // After a parameter delimiter, the last field is empty.
      if (values.length) values.push(null);
      return { values, end: i + 1 };
    }
    let value: IGESValue;
    let j = i;
    while (j < n && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
    if (j > i && j < n && (text[j] === 'H' || text[j] === 'h')) {
      // A Hollerith string: its count, H, then exactly that many characters (delimiters included).
      const count = Number(text.slice(i, j));
      if (j + 1 + count > n) fail(`${where}: a string of ${count} characters runs past the end`);
      value = text.slice(j + 1, j + 1 + count);
      i = j + 1 + count;
      while (i < n && text[i] === ' ') i++;
      if (i < n && text[i] !== pd && text[i] !== rd)
        fail(`${where}: text after the string ${JSON.stringify(value)}; check its character count`);
    } else {
      j = i;
      while (j < n && text[j] !== pd && text[j] !== rd) j++;
      const raw = text.slice(i, j).trim();
      value = raw === '' ? null : NUMBER.test(raw) ? Number(raw.replace(/[Dd]/, 'E')) : raw;
      i = j;
    }
    values.push(value);
    if (i >= n) return { values, end: -1 };
    if (text[i] === rd) return { values, end: i + 1 };
    i++;
  }
}

const str = (v: IGESValue | undefined): string => (typeof v === 'string' ? v : '');
const num = (v: IGESValue | undefined, fallback: number): number => (typeof v === 'number' ? v : fallback);

/** Lines of the file as text: split at line breaks, or every 80 characters for a file written without them. */
function linesOf(text: string): string[] {
  let lines = text.split(/\r\n|\n|\r/);
  if (lines.length <= 2 && lines[0].length > 160 && lines[0].length % 80 === 0) {
    const out: string[] = [];
    for (let i = 0; i < lines[0].length; i += 80) out.push(lines[0].slice(i, i + 80));
    lines = out;
  }
  return lines;
}

/** Whether `input` (text or bytes) starts like an IGES file: a Start (or Flag) line with its sequence number, then Global lines. */
export function isIGES(input: string | ArrayBuffer | ArrayBufferView): boolean {
  let text: string;
  if (typeof input === 'string') text = input.slice(0, 4096);
  else {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input, 0, Math.min(4096, input.byteLength))
        : new Uint8Array(input.buffer, input.byteOffset, Math.min(4096, input.byteLength));
    text = new TextDecoder('latin1').decode(bytes);
  }
  const lines = linesOf(text).filter((l) => l.trim() !== '');
  const tag = (l: string | undefined) => (l && l.length >= 74 && /^\s*\d+\s*$/.test(l.slice(73, 80)) ? l[72] : '');
  let k = 0;
  if (tag(lines[0]) === 'C' || tag(lines[0]) === 'B') k = 1;
  if (tag(lines[k]) !== 'S') return false;
  while (tag(lines[k]) === 'S') k++;
  return tag(lines[k]) === 'G';
}

/**
 * Reads an IGES 5.3 file in the Fixed (ASCII) Format: its Start and Global sections and every entity's Directory Entry
 * and parameters. Text or bytes (read as ISO 8859-1). Throws a TypeError that names the line for a malformed file, and
 * for the Compressed and Binary formats (save the file in the fixed ASCII format).
 */
export function readIGES(input: string | ArrayBuffer | ArrayBufferView): IGESFile {
  const text = stepText(input),
    sections: Record<string, string[]> = { S: [], G: [], D: [], P: [], T: [] };
  let order = 0,
    seenT = false;
  const ORDER = 'SGDPT';
  for (const [index, line] of linesOf(text).entries()) {
    if (seenT) break;
    if (line.trim() === '') continue;
    const letter = line.length >= 73 ? line[72] : '';
    if (index === 0 && (letter === 'C' || letter === 'B'))
      fail(`it is in the ${letter === 'C' ? 'Compressed' : 'Binary'} Format, which the reader does not read`);
    const at = letter ? ORDER.indexOf(letter) : -1;
    if (at < 0)
      fail(`line ${index + 1} has no section letter (S, G, D, P or T) in column 73; IGES lines are 80 columns wide`);
    if (at < order) fail(`line ${index + 1}: the ${letter} section comes after a later section`);
    order = at;
    sections[letter].push(line.padEnd(80, ' '));
    if (letter === 'T') seenT = true;
  }
  if (!sections.G.length) fail('no Global section (lines with G in column 73)');
  if (!sections.D.length) fail('no Directory Entry section (lines with D in column 73)');
  if (sections.D.length % 2) fail(`the Directory Entry section has ${sections.D.length} lines; each entity has two`);
  if (!seenT) fail('no Terminate line (T in column 73); the file may be cut short');

  // --- Global section ---
  const g = sections.G.map((l) => l.slice(0, 72)).join('');
  let i = 0;
  while (g[i] === ' ') i++;
  let pd = ',',
    rd = ';';
  if (/^1[Hh]/.test(g.slice(i, i + 2))) {
    pd = g[i + 2];
    i += 3;
  }
  while (g[i] === ' ') i++;
  if (g[i] !== pd) fail(`the Global section's first field is not followed by its parameter delimiter ${pd}`);
  i++;
  while (g[i] === ' ') i++;
  if (/^1[Hh]/.test(g.slice(i, i + 2))) {
    rd = g[i + 2];
    i += 3;
    while (g[i] === ' ') i++;
  }
  if (pd === rd) fail(`the parameter and record delimiters are both ${pd}`);
  if (/[\d\s+\-.DEH]/i.test(pd) || /[\d\s+\-.DEH]/i.test(rd))
    fail(`delimiter ${JSON.stringify(pd)} or ${JSON.stringify(rd)} is one the specification does not allow`);
  let rest: IGESValue[] = [];
  if (g[i] === pd) {
    const parsed = freeFields(g, i + 1, pd, rd, 'Global section');
    rest = parsed.values;
  } else if (g[i] !== rd) fail("the Global section's second field is not followed by a delimiter");
  const fields: IGESValue[] = [pd, rd, ...rest],
    flag = num(fields[13], 1),
    unitsName = str(fields[14]),
    millimetres = flag === 3 ? (UNIT_NAMES[unitsName.trim().toUpperCase()] ?? 1) : (UNITS[flag] ?? 25.4);
  const global: IGESGlobal = {
    parameterDelimiter: pd,
    recordDelimiter: rd,
    sender: str(fields[2]),
    fileName: str(fields[3]),
    system: str(fields[4]),
    preprocessor: str(fields[5]),
    modelScale: num(fields[12], 1) || 1,
    unitsFlag: flag,
    unitsName,
    millimetres,
    resolution: Math.abs(num(fields[18], 0)),
    maxCoordinate: Math.abs(num(fields[19], 0)),
    author: str(fields[20]),
    organization: str(fields[21]),
    version: num(fields[22], 3),
    fields,
  };

  // --- Parameter data: columns 1-64 of every P line, end to end, so strings may cross lines ---
  const pText = sections.P.map((l) => l.slice(0, 64)).join('');

  // --- Directory entries ---
  const entities = new Map<number, IGESEntity>();
  const int = (s: string, where: string): number => {
    const t = s.trim();
    if (t === '') return 0;
    if (!/^[+-]?\d+$/.test(t)) fail(`${where}: ${JSON.stringify(t)} is not an integer`);
    return Number(t);
  };
  for (let k = 0; k < sections.D.length; k += 2) {
    const a = sections.D[k],
      b = sections.D[k + 1],
      de = k + 1,
      where = `directory entry ${de}`,
      field = (line: string, f: number) => line.slice(f * 8, f * 8 + 8);
    const type = int(field(a, 0), where);
    if (type === 0) continue;
    const pointer = int(field(a, 1), where),
      status = field(a, 8).trim().padStart(8, '0'),
      count = int(field(b, 3), where);
    if (int(field(b, 0), where) !== type) fail(`${where}: its two lines give different entity types`);
    if (pointer < 1 || pointer > sections.P.length)
      fail(`${where}: parameter data pointer ${pointer} is outside the Parameter Data section`);
    const parsed = freeFields(pText, (pointer - 1) * 64, pd, rd, `parameter data of entity ${de} (type ${type})`);
    if (parsed.end < 0) fail(`parameter data of entity ${de} (type ${type}) has no record delimiter ${rd}`);
    if (parsed.end > (pointer - 1 + Math.max(count, 1)) * 64 + 64 && count > 0)
      fail(`parameter data of entity ${de} runs past its ${count} lines; check its record delimiter`);
    const [head, ...params] = parsed.values;
    if (head !== type) fail(`parameter data of entity ${de} starts with ${JSON.stringify(head)}, not its type ${type}`);
    entities.set(de, {
      de,
      type,
      form: int(field(b, 4), where),
      transform: int(field(a, 6), where),
      color: int(field(b, 2), where),
      level: int(field(a, 4), where),
      blanked: status.slice(0, 2) === '01',
      subordinate: Number(status.slice(2, 4)) || 0,
      use: Number(status.slice(4, 6)) || 0,
      label: field(b, 7).trim(),
      subscript: Number(field(b, 8).trim()) || 0,
      params,
    });
  }
  return { start: sections.S.map((l) => l.slice(0, 72).trimEnd()).join('\n'), global, entities };
}
