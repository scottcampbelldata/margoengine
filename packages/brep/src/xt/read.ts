// Parasolid transmit files (.x_t text, .x_b neutral binary), written from the published Parasolid XT Format Reference:
// the human header, the T or PS flag with modeller and schema versions, the node stream (type, embedded schema edits
// on the first node of a type, variable length, index, fields) and the terminator. Nodes are returned by index for the
// converter in `xt/step.ts`.
import { BASE_SCHEMA, LATER_SCHEMA, type XTField, type XTNodeType } from './schema.js';

/** A field value: number (or null for Parasolid's null value), string (char, char array), vector, or array. */
export type XTValue = number | null | string | boolean | readonly number[] | readonly XTValue[];

/** One node of the file. */
export interface XTNode {
  readonly type: number;
  readonly name: string;
  readonly index: number;
  readonly fields: Readonly<Record<string, XTValue>>;
}

/** What {@link readXT} returns. */
export interface XTFile {
  readonly modeller: string;
  readonly schema: string;
  readonly nodes: ReadonlyMap<number, XTNode>;
  /** Index 1: the root (a body, an assembly, a list of parts or a partition's world). */
  readonly root: XTNode | undefined;
}

const fail = (message: string): never => {
  throw new TypeError(`Invalid Parasolid file: ${message}`);
};

/** Parasolid's null double and null int, written as '?' in text files. */
const NULL_DOUBLE = -3.14158e13,
  NULL_INT = -32764;

interface Source {
  readonly binary: boolean;
  done(): boolean;
  number(kind: 'int' | 'real'): number | null;
  pointer(): number;
  short(): number | null;
  byte(): number;
  char(): string;
  logical(): boolean;
  /** A schema short string (length, then characters). */
  shortString(): string;
  /** `n` characters of a char array. */
  chars(n: number): string;
  where(): string;
}

/** Text transmit data: numbers end in one space; chars and logicals do not; '?' is a null number or vector. */
class TextSource implements Source {
  readonly binary = false;
  at = 0;
  constructor(readonly s: string) {}
  done() {
    return this.at >= this.s.length;
  }
  where() {
    return `character ${this.at}`;
  }
  private token(): string {
    const s = this.s;
    if (s[this.at] === '?') {
      this.at++;
      return '?';
    }
    const start = this.at;
    while (this.at < s.length && s[this.at] !== ' ') this.at++;
    const t = s.slice(start, this.at);
    this.at++;
    if (!t) fail(`empty number at ${this.where()}`);
    return t;
  }
  number(): number | null {
    const t = this.token();
    if (t === '?') return null;
    const v = Number(t);
    if (!Number.isFinite(v)) fail(`"${t.slice(0, 20)}" is not a number at ${this.where()}`);
    return v;
  }
  pointer() {
    return (this.number() as number) ?? 0;
  }
  short() {
    return this.number();
  }
  byte() {
    return (this.number() as number) ?? 0;
  }
  char() {
    if (this.at >= this.s.length) fail('the file ends inside a node');
    return this.s[this.at++];
  }
  logical() {
    const c = this.char();
    if (c !== 'T' && c !== 'F') fail(`logical "${c}" at ${this.where()}`);
    return c === 'T';
  }
  shortString() {
    const n = this.byte();
    return this.chars(n);
  }
  chars(n: number) {
    // From V12.1, \0 \n \r and \\ are escaped in text files.
    let out = '';
    for (let k = 0; k < n; k++) {
      let c = this.char();
      if (c === '\\') {
        const e = this.char();
        c = e === '0' ? '\0' : e === 'n' ? '\n' : e === 'r' ? '\r' : e;
      }
      out += c;
    }
    return out;
  }
}

/** Neutral binary transmit data: big-endian, IEEE doubles, pointer indices as one or two shorts. */
class BinarySource implements Source {
  readonly binary = true;
  readonly view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    public at: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  done() {
    return this.at >= this.bytes.length;
  }
  where() {
    return `byte ${this.at}`;
  }
  private need(n: number) {
    if (this.at + n > this.bytes.length) fail('the file ends inside a node');
  }
  int32() {
    this.need(4);
    const v = this.view.getInt32(this.at);
    this.at += 4;
    return v;
  }
  int16() {
    this.need(2);
    const v = this.view.getInt16(this.at);
    this.at += 2;
    return v;
  }
  number(kind: 'int' | 'real') {
    if (kind === 'int') {
      const v = this.int32();
      return v === NULL_INT ? null : v;
    }
    this.need(8);
    const v = this.view.getFloat64(this.at);
    this.at += 8;
    return v === NULL_DOUBLE ? null : v;
  }
  pointer() {
    let r = this.int16(),
      q = 0;
    if (r < 0) {
      q = this.int16();
      r = -r;
    }
    return q * 32767 + r - 1;
  }
  short() {
    const v = this.int16();
    return v === NULL_INT ? null : v;
  }
  byte() {
    this.need(1);
    return this.bytes[this.at++];
  }
  char() {
    return String.fromCharCode(this.byte());
  }
  logical() {
    return this.byte() !== 0;
  }
  shortString() {
    return this.chars(this.byte());
  }
  chars(n: number) {
    this.need(n);
    let out = '';
    for (let k = 0; k < n; k++) out += String.fromCharCode(this.bytes[this.at++]);
    return out;
  }
}

/** One field value from the source. */
function value(src: Source, type: string): XTValue {
  switch (type) {
    case 'd':
      return src.number('int');
    case 'p':
      return src.pointer();
    case 'f':
      return src.number('real');
    case 'u':
      return src.byte();
    case 'n':
    case 'w':
      return src.short();
    case 'c':
      return src.char();
    case 'l':
      return src.logical();
    case 'v':
    case 'h': {
      // A null vector is a single '?' in text (and a null first component in binary).
      const x = src.number('real');
      if (x === null && !src.binary) return null;
      const y = src.number('real'),
        z = src.number('real');
      return x === null || y === null || z === null ? null : [x, y, z];
    }
    case 'i': {
      const a = src.number('real'),
        b = src.number('real');
      return [a ?? Number.NaN, b ?? Number.NaN];
    }
    case 'b':
      return Array.from({ length: 6 }, () => src.number('real') ?? Number.NaN);
    default:
      return fail(`unknown field type ${type}`);
  }
}

/** A field spec from an embedded schema: name, pointer class, element count, type, transmit flag. */
function fieldSpec(src: Source): XTField & { transmit: boolean } {
  const name = src.shortString(),
    ptrClass = src.short() ?? 0,
    count = src.binary ? src.pointer() : ((src.number('int') as number) ?? 0),
    type = ptrClass ? 'p' : src.shortString(),
    transmit = count === 1 ? src.logical() : true;
  return { name, type, count, transmit };
}

/**
 * Reads a Parasolid transmit file (text .x_t or neutral binary .x_b) into its nodes. Throws a TypeError for a file it
 * cannot read, naming where.
 */
export function readXT(input: string | ArrayBuffer | ArrayBufferView): XTFile {
  const bytes =
    typeof input === 'string'
      ? Uint8Array.from(input, (c) => c.charCodeAt(0) & 255)
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  // The human header ends with **END_OF_HEADER and a line end.
  const headText = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16))),
    end = headText.indexOf('**END_OF_HEADER');
  let start = 0;
  if (end >= 0) {
    const eol = headText.indexOf('\n', end);
    start = eol < 0 ? fail('the header does not end') : eol + 1;
  }
  let src: Source;
  let modeller: string, schema: string;
  if (bytes[start] === 0x50 && bytes[start + 1] === 0x53 && bytes[start + 2] === 0 && bytes[start + 3] === 0) {
    const b = new BinarySource(bytes, start + 4);
    modeller = b.chars(b.int16());
    schema = b.chars(b.int32());
    src = b;
  } else if (bytes[start] === 0x42) {
    return fail('bare binary files (machine-dependent) are not supported; write neutral binary or text');
  } else {
    // Text: line ends and the spaces before them are not part of the data.
    const text = new TextDecoder('latin1')
      .decode(bytes.subarray(start))
      .split(/\r\n|\r|\n/)
      .map((line) => line.replace(/ +$/, ''))
      .join('');
    const t = new TextSource(text);
    if (t.char() !== 'T') fail('no T flag after the header');
    modeller = t.chars(t.byte());
    schema = t.chars(t.byte());
    src = t;
  }
  // SCH_<modeller>_<schema>[_<base>]: a base number means node types describe their changes against it.
  const parts = /^SCH_(\d+)_(\d+)(?:_(\d+))?$/.exec(schema.trim()) ?? fail(`schema name "${schema}"`),
    schemaNumber = Number(parts[2]),
    embedded = parts[3] !== undefined;
  // Before modeller version 12 the node layouts differ from the published format, and no schema describes them.
  if (schemaNumber < 12000)
    throw new RangeError(
      `Parasolid ${schema.trim()} is from modeller version ${Math.floor(schemaNumber / 1000)} (before 12), which is not supported; save it again from a current Parasolid application as text or neutral binary`,
    );
  if (embedded) src.short(); // the highest node type number
  const userFields = (src instanceof BinarySource ? src.int32() : ((src.number('int') as number) ?? 0)) || 0;

  const layouts = new Map<number, XTNodeType>();
  const layout = (type: number): XTNodeType => {
    let known = layouts.get(type);
    if (known) return known;
    const base = BASE_SCHEMA.get(type);
    if (embedded) {
      if (!base) {
        // A node type the base schema lacks: it describes itself in full.
        const count = src.byte(),
          name = src.shortString();
        src.shortString(); // description
        const fields: XTField[] = [];
        for (let k = 0; k < count; k++) {
          const f = fieldSpec(src);
          if (f.transmit) fields.push(f);
        }
        known = { name, fields };
      } else {
        const flag = src.byte();
        if (flag === 255) known = base;
        else {
          // An edit sequence against the base fields: Copy, Delete, Insert, Append, then Z.
          const fields: XTField[] = [];
          let b = 0;
          for (let guard = 0; guard < 10000; guard++) {
            const op = src.char();
            if (op === 'Z') break;
            if (op === 'C') fields.push(base.fields[b++] ?? fail(`schema edit copies past ${base.name}'s fields`));
            else if (op === 'D') b++;
            else if (op === 'I' || op === 'A') {
              const f = fieldSpec(src);
              if (f.transmit) fields.push(f);
            } else fail(`schema edit "${op}" for ${base.name} at ${src.where()}`);
          }
          known = { name: base.name, fields };
        }
      }
    } else {
      known = (schemaNumber > 13006 ? LATER_SCHEMA.get(type) : undefined) ?? base;
      if (!known) fail(`node type ${type} is not in the schema this reader knows (${schema}) at ${src.where()}`);
    }
    layouts.set(type, known!);
    return known!;
  };

  const nodes = new Map<number, XTNode>();
  for (let guard = 0; !src.done() && guard < 1e8; guard++) {
    const type = src.binary ? (src as BinarySource).int16() : ((src.number('int') as number) ?? 0);
    if (type === 1) break; // the terminator (its index, 0, follows)
    if (!(type > 1 && type < 1000)) fail(`node type ${type} at ${src.where()}`);
    const l = layout(type),
      variable = l.fields.length > 0 && l.fields[l.fields.length - 1].count === 1;
    const length = variable ? (src.binary ? (src as BinarySource).int32() : ((src.number('int') as number) ?? 0)) : 0;
    if (length < 0 || length > 1e8) fail(`variable length ${length} at ${src.where()}`);
    const index = src.pointer();
    if (!(index > 0)) fail(`node index ${index} at ${src.where()}`);
    const fields: Record<string, XTValue> = {};
    for (const f of l.fields) {
      if (f.count === 0) fields[f.name] = value(src, f.type);
      else if (f.type === 'c') fields[f.name] = src.chars(f.count === 1 ? length : f.count);
      else {
        const n = f.count === 1 ? length : f.count,
          list: XTValue[] = [];
        for (let k = 0; k < n; k++) list.push(value(src, f.type));
        fields[f.name] = list;
      }
    }
    // User fields follow nodes visible at the PK interface when the file has them.
    if (userFields > 0 && VISIBLE.has(type)) for (let k = 0; k < userFields; k++) src.number('int');
    nodes.set(index, { type, name: l.name, index, fields });
  }
  return { modeller: modeller.trim(), schema: schema.trim(), nodes, root: nodes.get(1) };
}

/** Node types visible at the PK interface (they carry user fields when a file has them). */
const VISIBLE = new Set([
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 29, 30, 31, 32, 38, 50, 51, 52, 53, 54, 56, 59, 60, 67, 68, 81, 90, 100, 120,
  124, 130, 133, 134, 137,
]);
