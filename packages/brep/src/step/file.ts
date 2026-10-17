// ISO 10303-21 ("STEP physical file") reader, written from the standard's grammar. One pass indexes every entity
// instance of the DATA sections (its id, type and text span); its parameters are parsed only when asked for, so a
// 10 MB file is not turned into millions of objects to read its product structure.

/** A reference to another entity instance (`#12`). */
export class Ref {
  constructor(readonly id: number) {}
}
/** An enumeration value (`.T.`, `.MILLI.`); its name without the dots. */
export class Enum {
  constructor(readonly name: string) {}
}
/** A typed parameter (`LENGTH_MEASURE(25.4)`). */
export class Typed {
  constructor(
    readonly type: string,
    readonly value: Value,
  ) {}
}
/** `*`: an attribute whose value a supertype derives. */
export const DERIVED: unique symbol = Symbol('derived');
/** A parameter: number, string, `$` (null), reference, enumeration, typed value, list, or derived. */
export type Value = number | string | null | Ref | Enum | Typed | typeof DERIVED | Value[];

/** One entity instance. A complex instance (`#5=(A(..)B(..));`) has `type` 'COMPLEX' and its partial types in `parts`. */
export interface Entity {
  readonly id: number;
  readonly type: string;
  readonly args: readonly Value[];
  readonly parts?: ReadonlyMap<string, readonly Value[]>;
}

/** The HEADER section's file description, name and schema. */
export interface STEPHeader {
  readonly description: readonly string[];
  readonly name: string;
  readonly timeStamp: string;
  readonly author: readonly string[];
  readonly organization: readonly string[];
  readonly preprocessor: string;
  readonly system: string;
  /** FILE_SCHEMA names, for example 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'. */
  readonly schema: readonly string[];
}

const at = (text: string, i: number) => text.charCodeAt(i);
const HASH = 35,
  QUOTE = 39,
  DQUOTE = 34,
  OPEN = 40,
  CLOSE = 41,
  SEMI = 59,
  EQUALS = 61,
  SLASH = 47,
  STAR = 42,
  DOLLAR = 36,
  DOT = 46,
  COMMA = 44;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isName = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigit(c) || c === 95;

function malformed(message: string, text: string, i: number): TypeError {
  const line = text.slice(0, i).split('\n').length;
  return new TypeError(`Invalid STEP file: ${message} at line ${line}; export it again from the CAD tool`);
}

/** Skips spaces and comments from `i`; returns the next significant index. */
function skip(text: string, i: number): number {
  for (;;) {
    while (i < text.length && isSpace(at(text, i))) i++;
    if (at(text, i) === SLASH && at(text, i + 1) === STAR) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw malformed('unterminated comment', text, i);
      i = end + 2;
    } else return i;
  }
}

// Text escapes (ISO 10303-21 section 6.4.3): '' is ', \\ is \, \S\c is c + 128 (ISO 8859-1), \P?\ selects a code page
// (ignored: the decoder already reads bytes as ISO 8859-1), \X\hh is one ISO 8859-1 byte, \X2\hhhh..\X0\ UCS-2 and
// \X4\hhhhhhhh..\X0\ UCS-4 characters.
function decodeString(raw: string): string {
  if (!raw.includes('\\') && !raw.includes("''")) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && raw[i + 1] === "'") {
      out += "'";
      i++;
    } else if (c !== '\\') out += c;
    else if (raw[i + 1] === '\\') {
      out += '\\';
      i++;
    } else if (raw[i + 1] === 'S' && raw[i + 2] === '\\') {
      out += String.fromCharCode(raw.charCodeAt(i + 3) + 128);
      i += 3;
    } else if (raw[i + 1] === 'P' && raw[i + 3] === '\\') i += 3;
    else if (raw[i + 1] === 'X' && raw[i + 2] === '\\') {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 3, i + 5), 16));
      i += 4;
    } else if (raw[i + 1] === 'X' && (raw[i + 2] === '2' || raw[i + 2] === '4') && raw[i + 3] === '\\') {
      const width = raw[i + 2] === '2' ? 4 : 8,
        end = raw.indexOf('\\X0\\', i + 4);
      const hex = end < 0 ? '' : raw.slice(i + 4, end);
      for (let k = 0; k + width <= hex.length; k += width)
        out += String.fromCodePoint(Number.parseInt(hex.slice(k, k + width), 16));
      i = end < 0 ? raw.length : end + 3;
    } else out += c;
  }
  return out;
}

/** Parses one parameter at `i`; returns it and the index after it. */
function value(text: string, i: number): [Value, number] {
  i = skip(text, i);
  const c = at(text, i);
  if (c === HASH) {
    let j = i + 1;
    while (isDigit(at(text, j))) j++;
    if (j === i + 1) throw malformed('reference without a number', text, i);
    return [new Ref(Number(text.slice(i + 1, j))), j];
  }
  if (c === QUOTE) {
    let j = i + 1;
    for (;;) {
      j = text.indexOf("'", j);
      if (j < 0) throw malformed('unterminated string', text, i);
      if (at(text, j + 1) === QUOTE) j += 2;
      else break;
    }
    return [decodeString(text.slice(i + 1, j)), j + 1];
  }
  if (c === DQUOTE) {
    const j = text.indexOf('"', i + 1);
    if (j < 0) throw malformed('unterminated binary', text, i);
    return [text.slice(i + 1, j), j + 1];
  }
  if (c === DOT) {
    const j = text.indexOf('.', i + 1);
    if (j < 0) throw malformed('unterminated enumeration', text, i);
    return [new Enum(text.slice(i + 1, j).trim()), j + 1];
  }
  if (c === DOLLAR) return [null, i + 1];
  if (c === STAR) return [DERIVED, i + 1];
  if (c === OPEN) return list(text, i);
  if (isDigit(c) || c === 45 || c === 43) {
    let j = i + 1;
    while (j < text.length) {
      const d = at(text, j);
      if (isDigit(d) || d === DOT || d === 69 || d === 101 || d === 45 || d === 43) j++;
      else break;
    }
    const number = Number(text.slice(i, j));
    if (!Number.isFinite(number)) throw malformed(`bad number '${text.slice(i, j)}'`, text, i);
    return [number, j];
  }
  if (isName(c)) {
    let j = i;
    while (isName(at(text, j))) j++;
    const type = text.slice(i, j).toUpperCase(),
      k = skip(text, j);
    if (at(text, k) !== OPEN) throw malformed(`typed parameter ${type} without a value`, text, i);
    const [inner, end] = list(text, k);
    return [new Typed(type, inner.length === 1 ? inner[0] : inner), end];
  }
  throw malformed(`unexpected '${text[i] ?? 'end of file'}'`, text, i);
}

/** Parses `( value, value, ... )` at `i` (which must be '('); returns the values and the index after ')'. */
function list(text: string, i: number): [Value[], number] {
  const out: Value[] = [];
  i = skip(text, i + 1);
  if (at(text, i) === CLOSE) return [out, i + 1];
  for (;;) {
    const [v, j] = value(text, i);
    out.push(v);
    i = skip(text, j);
    const c = at(text, i);
    if (c === COMMA) i++;
    else if (c === CLOSE) return [out, i + 1];
    else throw malformed(`expected ',' or ')' but found '${text[i] ?? 'end of file'}'`, text, i);
  }
}

/** Parses `NAME(args)` records from `i` until `stop` (')' of a complex instance, or ';' of a header record). */
function records(text: string, i: number, stop: number): [Array<[string, Value[]]>, number] {
  const out: Array<[string, Value[]]> = [];
  for (;;) {
    i = skip(text, i);
    if (at(text, i) === stop) return [out, i + 1];
    let j = i;
    while (isName(at(text, j))) j++;
    if (j === i) throw malformed(`expected an entity name but found '${text[i] ?? 'end of file'}'`, text, i);
    const name = text.slice(i, j).toUpperCase(),
      k = skip(text, j);
    if (at(text, k) !== OPEN) throw malformed(`${name} without parameters`, text, k);
    const [args, end] = list(text, k);
    out.push([name, args]);
    i = end;
    if (stop === SEMI) {
      i = skip(text, i);
      if (at(text, i) !== SEMI) throw malformed(`expected ';' after ${name}`, text, i);
      return [out, i + 1];
    }
  }
}

/** Index of the ';' that ends the entity instance whose text starts at `i` (nesting, strings and comments skipped). */
function instanceEnd(text: string, i: number): number {
  let depth = 0;
  for (; i < text.length; i++) {
    const c = at(text, i);
    if (c === QUOTE) {
      i = text.indexOf("'", i + 1);
      while (i >= 0 && at(text, i + 1) === QUOTE) i = text.indexOf("'", i + 2);
      if (i < 0) break;
    } else if (c === DQUOTE) {
      i = text.indexOf('"', i + 1);
      if (i < 0) break;
    } else if (c === SLASH && at(text, i + 1) === STAR) {
      i = text.indexOf('*/', i + 2) + 1;
      if (i <= 0) break;
    } else if (c === OPEN) depth++;
    else if (c === CLOSE) depth--;
    else if (c === SEMI && depth === 0) return i;
  }
  throw malformed('unterminated entity instance', text, text.length);
}

const asText = (v: Value | undefined) => (typeof v === 'string' ? v : '');
const asTexts = (v: Value | undefined) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/**
 * A STEP file's entity table. `get(id)` parses an instance on first use and caches it; `ids(type)` lists the
 * instances whose type (or, for a complex instance, one of whose partial types) is `type`.
 */
export class STEPFile {
  readonly header: STEPHeader;
  private readonly slots = new Map<number, number>();
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly types: string[] = [];
  private readonly byType = new Map<string, number[]>();
  private readonly cache = new Map<number, Entity>();

  constructor(private readonly text: string) {
    let i = skip(text, 0);
    if (!text.startsWith('ISO-10303-21', i)) throw malformed("missing 'ISO-10303-21;' at the start", text, i);
    const headerAt = text.indexOf('HEADER;', i);
    if (headerAt < 0) throw malformed('no HEADER section', text, i);
    const [header, afterHeader] = this.headerSection(headerAt + 7);
    this.header = header;
    i = afterHeader;
    let sections = 0;
    for (;;) {
      const data = text.indexOf('DATA', i);
      if (data < 0) break;
      // DATA; or DATA('name',(schema)); (edition 3)
      let j = skip(text, data + 4);
      if (at(text, j) === OPEN) j = list(text, j)[1];
      j = skip(text, j);
      if (at(text, j) !== SEMI) {
        i = data + 4;
        continue;
      }
      sections++;
      i = this.dataSection(j + 1);
    }
    if (!sections) throw malformed('no DATA section', text, text.length);
  }

  private headerSection(i: number): [STEPHeader, number] {
    const fields = new Map<string, Value[]>();
    for (;;) {
      i = skip(this.text, i);
      if (this.text.startsWith('ENDSEC', i)) {
        const end = skip(this.text, i + 6);
        if (at(this.text, end) !== SEMI) throw malformed("expected ';' after ENDSEC", this.text, end);
        break;
      }
      const [[record], next] = records(this.text, i, SEMI);
      fields.set(record[0], record[1]);
      i = next;
    }
    const d = fields.get('FILE_DESCRIPTION') ?? [],
      n = fields.get('FILE_NAME') ?? [],
      s = fields.get('FILE_SCHEMA') ?? [];
    return [
      {
        description: asTexts(d[0]),
        name: asText(n[0]),
        timeStamp: asText(n[1]),
        author: asTexts(n[2]),
        organization: asTexts(n[3]),
        preprocessor: asText(n[4]),
        system: asText(n[5]),
        schema: asTexts(s[0]),
      },
      i,
    ];
  }

  /** Indexes `#id=...;` instances from `i` to ENDSEC; returns the index after it. */
  private dataSection(i: number): number {
    const t = this.text;
    for (;;) {
      i = skip(t, i);
      if (t.startsWith('ENDSEC', i)) return i + 6;
      if (at(t, i) !== HASH) throw malformed(`expected '#' or ENDSEC but found '${t[i] ?? 'end of file'}'`, t, i);
      let j = i + 1;
      while (isDigit(at(t, j))) j++;
      const id = Number(t.slice(i + 1, j));
      j = skip(t, j);
      if (j === i + 1 || at(t, j) !== EQUALS) throw malformed('expected #id=', t, i);
      const start = skip(t, j + 1),
        end = instanceEnd(t, start);
      if (this.slots.has(id)) throw malformed(`#${id} is defined twice`, t, i);
      const slot = this.starts.length;
      this.slots.set(id, slot);
      this.starts.push(start);
      this.ends.push(end);
      if (at(t, start) === OPEN) {
        this.types.push('COMPLEX');
        // Complex instances are few (units, contexts, rational B-splines, transformed relationships): parse now to
        // index their partial types.
        for (const name of this.get(id).parts!.keys()) this.index(name, id);
      } else {
        let k = start;
        while (isName(at(t, k))) k++;
        const type = t.slice(start, k).toUpperCase();
        this.types.push(type);
        this.index(type, id);
      }
      i = end + 1;
    }
  }

  private index(type: string, id: number): void {
    const list = this.byType.get(type);
    if (list) list.push(id);
    else this.byType.set(type, [id]);
  }

  /** Number of entity instances. */
  get size(): number {
    return this.starts.length;
  }
  /** Whether `#id` exists. */
  has(id: number): boolean {
    return this.slots.has(id);
  }
  /** Ids of the instances of `type` (upper case), including complex instances that have it as a partial type. */
  ids(type: string): readonly number[] {
    return this.byType.get(type) ?? [];
  }
  /** Every type present and its instance count. */
  census(): Map<string, number> {
    return new Map([...this.byType].map(([type, ids]) => [type, ids.length]));
  }
  /** Instance `#id`, parsed on first use. Throws when it does not exist. */
  get(id: number): Entity {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const slot = this.slots.get(id);
    if (slot === undefined) throw new TypeError(`Invalid STEP file: #${id} is referenced but never defined`);
    const t = this.text,
      start = this.starts[slot];
    let entity: Entity;
    if (at(t, start) === OPEN) {
      const [parts, after] = records(t, start + 1, CLOSE);
      if (skip(t, after) !== this.ends[slot]) throw malformed(`#${id}: text after the complex instance`, t, after);
      entity = { id, type: 'COMPLEX', args: [], parts: new Map(parts) };
    } else {
      let k = start;
      while (isName(at(t, k))) k++;
      const open = skip(t, k);
      if (at(t, open) !== OPEN) throw malformed(`#${id}: entity without parameters`, t, open);
      const [args, after] = list(t, open);
      if (skip(t, after) !== this.ends[slot]) throw malformed(`#${id}: text after the parameters`, t, after);
      entity = { id, type: this.types[slot], args };
    }
    this.cache.set(id, entity);
    return entity;
  }
  /** The parameters of `#id` as `type`: its own when it is that type, or that partial type's of a complex instance. */
  args(id: number, type?: string): readonly Value[] {
    const entity = this.get(id);
    if (!type || entity.type === type) return entity.args;
    const part = entity.parts?.get(type);
    if (!part) throw new TypeError(`Invalid STEP file: #${id} is ${entity.type}, expected ${type}`);
    return part;
  }
  /** Whether `#id` is `type`, or a complex instance with that partial type. */
  is(id: number, type: string): boolean {
    const entity = this.get(id);
    return entity.type === type || !!entity.parts?.has(type);
  }
  /** The type name to show for `#id`: its type, or a complex instance's partial types joined with '+'. */
  typeName(id: number): string {
    const entity = this.get(id);
    return entity.parts ? [...entity.parts.keys()].join('+') : entity.type;
  }
}

/** Decodes STEP bytes as ISO 8859-1 (the standard's character set; non-ASCII text uses the escapes above). */
export function stepText(input: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof input === 'string') return input;
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new TextDecoder('latin1').decode(bytes);
}
