import { LoaderError } from './types.js';

// Read against Extensible Markup Language (XML) 1.0, Fifth Edition (W3C Recommendation, 2008),
// https://www.w3.org/TR/xml/: section numbers below are that document's.
const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
/** Default for {@link XMLReadOptions.maxExpansion}: characters entity references may bring in, in one document. */
const MAX_EXPANSION = 1 << 20;
/** A text declaration (4.3.1) at the start of an external parsed entity, and a byte order mark. */
const TEXT_DECLARATION = /^﻿?(?:<\?xml\s[\s\S]*?\?>)?/;
/** One entity or character reference in content or an attribute value (4.1). */
const REFERENCE = /&(#x[0-9a-fA-F]+|#\d+|[^\s&;<>"']+);/g;
/** The characters a DTD name runs to (looser than the Name production, as before). */
const NAME = /[^\s%&;<>"'()|,=[\]]+/y;

/** The Char production (section 2.2): what a character reference may name. */
const legalChar = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

/**
 * The texts of external entities, the external DTD subset among them, keyed by system identifier as resolved
 * against the entity that declares it (the document's own `base`, or the identifier as written without one). Make
 * it with {@link resolveDTD}, or by hand.
 */
export type XMLExternal = ReadonlyMap<string, string>;

/**
 * The option every format parser that reads XML takes to read a document with an external DTD: the result of
 * {@link resolveDTD}. Nothing is fetched while parsing.
 */
export interface XMLExternalOptions {
  /**
   * External DTD subset and external entities, from {@link resolveDTD}. Default: none, so an entity that only the
   * external DTD declares throws code `unsupported`.
   */
  external?: XMLExternal;
}

/** Options of {@link readXML} and {@link readXMLTree}. */
export interface XMLReadOptions extends XMLExternalOptions {
  /**
   * External DTD subset and external entities to use, from {@link resolveDTD}. Default: none. Nothing is ever
   * fetched while reading: without this, the external subset and external entities are not read, as a
   * non-validating processor may (5.1), and a reference to an entity they could declare throws code `unsupported`.
   */
  external?: XMLExternal;
  /** The document's own system identifier (its URL or path), against which relative identifiers resolve (4.2.2). */
  base?: string;
  /** Deepest element nesting. Default 256. */
  maxDepth?: number;
  /** Most characters entity and parameter entity references may bring in. Default 1,048,576 (1 Mi). */
  maxExpansion?: number;
}

/** Options of {@link resolveDTD}. */
export interface XMLResolveOptions {
  /**
   * Reads one external entity: the DTD file of a `<!DOCTYPE ... SYSTEM "x.dtd">` or of an external entity
   * declaration. `id` is the system identifier, resolved against the declaring entity's identifier. In a browser
   * `fetch(new URL(id, documentURL), {signal})`; return its text or bytes.
   */
  resolve(
    id: string,
    request: { publicId?: string; signal?: AbortSignal },
  ): Promise<string | Uint8Array | ArrayBuffer> | string | Uint8Array | ArrayBuffer;
  /** The document's own system identifier, passed to `resolve` as the base of relative identifiers. */
  base?: string;
  /** Aborts the reads; resolveDTD then throws a `LoaderError` with code `aborted`. */
  signal?: AbortSignal;
  /** Most external entities read. Default 64. */
  maxFiles?: number;
  /** Most characters read in all. Default 16,777,216 (16 Mi). */
  maxCharacters?: number;
}

/** An entity declaration (4.2): internal with a `value`, or external with a resolved `system` identifier. */
interface Entity {
  value?: string;
  system?: string;
  publicId?: string;
  /** An unparsed entity (NDATA), which a reference may not name. */
  unparsed?: boolean;
  /** Declared in the external subset or an external parameter entity. */
  inExternal: boolean;
  /** Identifier of the entity holding the declaration, the base for an internal entity's own declarations. */
  base: string | undefined;
}

/** An attribute declaration (3.3): whether its type is CDATA and its normalized default value. */
interface Attribute {
  cdata: boolean;
  value?: string;
}

/** What the DTD declared, and how much of it was read. */
interface DTD {
  format: string;
  general: Map<string, Entity>;
  parameter: Map<string, Entity>;
  /** Attribute declarations by element name as written (prefix included). */
  attributes: Map<string, Map<string, Attribute>>;
  /** Characters entity references may still bring in. */
  left: number;
  /** Some declarations were not read (an external subset or parameter entity): undeclared names are not errors. */
  incomplete: boolean;
  /** After a parameter entity that was not read, entity and attribute declarations are not processed (5.1). */
  skipping: boolean;
  standalone: boolean;
  external: XMLExternal | undefined;
  /** External entities that were needed and not in `external`, by identifier, with their public identifiers. */
  missing: Map<string, string | undefined>;
}

/** Where declarations are being read: in the external subset (or an entity of it), and the open entities. */
interface Context {
  external: boolean;
  base: string | undefined;
  open: string[];
}

function newDTD(format: string, options: XMLReadOptions, standalone: boolean): DTD {
  const left = options.maxExpansion ?? MAX_EXPANSION;
  if (!(left >= 0)) throw new LoaderError(format, 'range', 'maxExpansion must be 0 or more');
  return {
    format,
    general: new Map(),
    parameter: new Map(),
    attributes: new Map(),
    left,
    incomplete: false,
    skipping: false,
    standalone,
    external: options.external,
    missing: new Map(),
  };
}

const syntax = (dtd: DTD, message: string): LoaderError => new LoaderError(dtd.format, 'syntax', message);

function characterReference(match: string, name: string, format: string): string {
  const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  if (!legalChar(code)) throw new LoaderError(format, 'syntax', `invalid character reference ${match.slice(0, 32)}`);
  return String.fromCodePoint(code);
}

/** A relative system identifier against the identifier of the entity that declares it (4.2.2). */
function resolveId(system: string, base: string | undefined): string {
  if (!base) return system;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(base)) return new URL(system, base).href;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(system) || system.startsWith('/')) return system;
  return base.slice(0, base.lastIndexOf('/') + 1) + system;
}

/** Counts `count` characters an entity reference brings in against the document's limit. */
function charge(dtd: DTD, count: number): void {
  if ((dtd.left -= count) < 0)
    throw new LoaderError(dtd.format, 'limit', 'entities expand past the limit of maxExpansion characters');
}

/** The text of an external entity from `external`, its text declaration removed; undefined and noted if absent. */
function externalText(dtd: DTD, id: string, publicId: string | undefined): string | undefined {
  const text = dtd.external?.get(id);
  if (text === undefined) {
    dtd.missing.set(id, publicId);
    return undefined;
  }
  return text.replace(/\r\n?/g, '\n').replace(TEXT_DECLARATION, '');
}

/** Marks part of the DTD unread; later entity and attribute declarations are then skipped unless standalone (5.1). */
function unread(dtd: DTD): void {
  dtd.incomplete = true;
  if (!dtd.standalone) dtd.skipping = true;
}

/** The replacement text of parameter entity `name` and the context it is read in, or undefined when not read. */
function parameter(name: string, dtd: DTD, ctx: Context): { text: string; ctx: Context } | undefined {
  const entity = dtd.parameter.get(name);
  if (!entity) {
    // Entity Declared (4.1) binds only a DTD read in full; otherwise a part not read may declare it.
    if (dtd.incomplete || ctx.external) {
      unread(dtd);
      return undefined;
    }
    throw syntax(dtd, `unknown parameter entity %${name.slice(0, 64)};`);
  }
  if (ctx.open.includes(`%${name}`)) throw syntax(dtd, `parameter entity %${name.slice(0, 64)}; refers to itself`);
  const text = entity.value ?? externalText(dtd, entity.system as string, entity.publicId);
  if (text === undefined) {
    unread(dtd);
    return undefined;
  }
  charge(dtd, text.length);
  return {
    text,
    ctx: {
      external: ctx.external || entity.inExternal || entity.value === undefined,
      base: entity.value === undefined ? entity.system : entity.base,
      open: [...ctx.open, `%${name}`],
    },
  };
}

/** A small reader over one markup declaration's text. */
class Cursor {
  i = 0;
  constructor(
    readonly s: string,
    readonly dtd: DTD,
  ) {}
  fail(message: string): never {
    throw syntax(this.dtd, `${message} in a declaration, at ${JSON.stringify(this.s.slice(this.i, this.i + 32))}`);
  }
  /** Skips whitespace; true when there was some. */
  skip(): boolean {
    const from = this.i;
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
    return this.i > from;
  }
  space(): void {
    if (!this.skip()) this.fail('whitespace expected');
  }
  name(): string {
    NAME.lastIndex = this.i;
    const match = NAME.exec(this.s);
    if (!match) this.fail('a name expected');
    this.i = NAME.lastIndex;
    return match[0];
  }
  literal(): string {
    const quote = this.s[this.i];
    if (quote !== '"' && quote !== "'") this.fail('a quoted literal expected');
    const end = this.s.indexOf(quote, this.i + 1);
    if (end < 0) this.fail('an unterminated literal');
    const value = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return value;
  }
  /** Skips a parenthesized enumeration or notation list. */
  group(): void {
    const end = this.s.indexOf(')', this.i);
    if (this.s[this.i] !== '(' || end < 0) this.fail('a list in parentheses expected');
    this.i = end + 1;
  }
  peek(): string {
    return this.s[this.i] ?? '';
  }
  done(): boolean {
    this.skip();
    return this.i >= this.s.length;
  }
}

/**
 * The replacement text of an entity value literal (4.5): character references expand now, general entity
 * references are kept for later, and in the external subset parameter entity references are included in the
 * literal (4.4.5); in the internal subset they are not allowed there (WFC PEs in Internal Subset, 2.8).
 */
function entityValue(raw: string, dtd: DTD, ctx: Context): string | undefined {
  let out = '',
    last = 0;
  const reference = /&#x[0-9a-fA-F]+;|&#\d+;|%([^\s%&;<>"']+);/g;
  for (let match = reference.exec(raw); match; match = reference.exec(raw)) {
    out += raw.slice(last, match.index);
    last = reference.lastIndex;
    if (match[1] === undefined) {
      out += characterReference(match[0], match[0].slice(1, -1), dtd.format);
      continue;
    }
    if (!ctx.external)
      throw syntax(
        dtd,
        `parameter entity reference ${match[0].slice(0, 64)} inside a declaration of the internal subset`,
      );
    const included = parameter(match[1], dtd, ctx);
    const value = included && entityValue(included.text, dtd, included.ctx);
    if (value === undefined) return undefined;
    out += value;
  }
  return out + raw.slice(last);
}

/**
 * A markup declaration's text with the parameter entity references outside its literals replaced, each with a
 * space either side (4.4.8); undefined when one was not read. In the internal subset such a reference is not
 * allowed inside a declaration (WFC PEs in Internal Subset).
 */
function expandDeclaration(body: string, dtd: DTD, ctx: Context): string | undefined {
  let out = '',
    quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '%') {
      const end = body.indexOf(';', i);
      const name = end < 0 ? '' : body.slice(i + 1, end);
      NAME.lastIndex = 0;
      if (name && NAME.exec(name)?.[0] === name) {
        if (!ctx.external)
          throw syntax(
            dtd,
            `parameter entity reference %${name.slice(0, 64)}; inside a declaration of the internal subset`,
          );
        const included = parameter(name, dtd, ctx);
        const text = included && expandDeclaration(included.text, dtd, included.ctx);
        if (text === undefined) return undefined;
        out += ` ${text} `;
        i = end;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** `<!ENTITY ...>` (4.2): the first declaration of a name binds; none bind after an unread parameter entity. */
function entityDeclaration(cursor: Cursor, dtd: DTD, ctx: Context): void {
  cursor.space();
  let isParameter = false;
  if (cursor.peek() === '%') {
    cursor.i++;
    cursor.space();
    isParameter = true;
  }
  const name = cursor.name();
  cursor.space();
  let entity: Entity | undefined;
  if (cursor.peek() === '"' || cursor.peek() === "'") {
    const value = entityValue(cursor.literal(), dtd, ctx);
    if (value !== undefined) entity = { value, inExternal: ctx.external, base: ctx.base };
  } else {
    const keyword = cursor.name();
    let publicId: string | undefined;
    if (keyword === 'PUBLIC') {
      cursor.space();
      publicId = cursor.literal();
    } else if (keyword !== 'SYSTEM') cursor.fail('SYSTEM, PUBLIC or a quoted value expected');
    cursor.space();
    entity = { system: resolveId(cursor.literal(), ctx.base), publicId, inExternal: ctx.external, base: ctx.base };
    if (cursor.skip() && !isParameter && cursor.peek() === 'N') {
      if (cursor.name() !== 'NDATA') cursor.fail('NDATA expected');
      cursor.space();
      cursor.name();
      entity.unparsed = true;
    }
  }
  if (!cursor.done()) cursor.fail('unexpected text');
  if (!entity || dtd.skipping) return;
  const map = isParameter ? dtd.parameter : dtd.general;
  if (map.has(name) || (!isParameter && Object.hasOwn(PREDEFINED, name))) return;
  map.set(name, entity);
}

const TYPES = new Set(['CDATA', 'ID', 'IDREF', 'IDREFS', 'ENTITY', 'ENTITIES', 'NMTOKEN', 'NMTOKENS']);

/** Normalization of a tokenized or enumerated attribute (3.3.3): spaces collapse and trim; CDATA stays. */
const tokens = (value: string, cdata: boolean): string => (cdata ? value : value.replace(/ +/g, ' ').trim());

/** `<!ATTLIST ...>` (3.3): types and default values; the first declaration of an attribute binds. */
function attributeDeclaration(cursor: Cursor, dtd: DTD): void {
  cursor.space();
  const element = cursor.name();
  while (!cursor.done()) {
    const name = cursor.name();
    cursor.space();
    let cdata = false;
    if (cursor.peek() === '(') cursor.group();
    else {
      const type = cursor.name();
      if (type === 'NOTATION') {
        cursor.space();
        cursor.group();
      } else if (!TYPES.has(type)) cursor.fail(`unknown attribute type ${type.slice(0, 32)}`);
      cdata = type === 'CDATA';
    }
    cursor.space();
    let value: string | undefined;
    if (cursor.peek() === '#') {
      const keyword = cursor.name();
      if (keyword === '#FIXED') {
        cursor.space();
        value = cursor.literal();
      } else if (keyword !== '#REQUIRED' && keyword !== '#IMPLIED')
        cursor.fail(`unknown default ${keyword.slice(0, 32)}`);
    } else value = cursor.literal();
    if (dtd.skipping) continue;
    let declared = dtd.attributes.get(element);
    if (!declared) dtd.attributes.set(element, (declared = new Map()));
    if (declared.has(name)) continue;
    declared.set(name, { cdata, value: value === undefined ? undefined : tokens(attributeValue(value, dtd), cdata) });
  }
}

/** One markup declaration, `body` being its text between `<!` and `>`. ELEMENT and NOTATION are not needed. */
function markup(body: string, dtd: DTD, ctx: Context): void {
  const text = expandDeclaration(body, dtd, ctx);
  if (text === undefined) return;
  const keyword = /^[A-Z]+/.exec(text)?.[0];
  const cursor = new Cursor(text, dtd);
  cursor.i = keyword?.length ?? 0;
  if (keyword === 'ENTITY') entityDeclaration(cursor, dtd, ctx);
  else if (keyword === 'ATTLIST') attributeDeclaration(cursor, dtd);
  else if (keyword !== 'ELEMENT' && keyword !== 'NOTATION') cursor.fail('unknown declaration');
}

/** The index of the `>` that ends the declaration at `at`, outside quoted literals. */
function declarationEnd(text: string, at: number, dtd: DTD): number {
  let quote = 0;
  for (let i = at + 2; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) quote = code;
    else if (code === 62) return i;
  }
  throw new LoaderError(dtd.format, 'truncated', 'unterminated declaration in the DTD');
}

/** A conditional section (3.4) at `at`, allowed only in the external subset; returns the index past its `]]>`. */
function conditional(text: string, at: number, dtd: DTD, ctx: Context): number {
  if (!ctx.external) throw syntax(dtd, 'a conditional section outside the external subset');
  let i = at + 3;
  while (/\s/.test(text[i] ?? '')) i++;
  let keyword: string | undefined;
  if (text[i] === '%') {
    const end = text.indexOf(';', i);
    if (end < 0) throw syntax(dtd, 'an unterminated parameter entity reference');
    keyword = parameter(text.slice(i + 1, end), dtd, ctx)?.text.trim();
    i = end + 1;
  } else {
    const match = /^[A-Z]+/.exec(text.slice(i, i + 8));
    keyword = match?.[0];
    if (keyword !== 'INCLUDE' && keyword !== 'IGNORE') throw syntax(dtd, 'INCLUDE or IGNORE expected');
    i += keyword.length;
  }
  while (/\s/.test(text[i] ?? '')) i++;
  if (text[i] !== '[') throw syntax(dtd, '[ expected after INCLUDE or IGNORE');
  const start = i + 1;
  let depth = 1;
  for (i = start; depth; ) {
    const open = text.indexOf('<![', i),
      close = text.indexOf(']]>', i);
    if (close < 0) throw new LoaderError(dtd.format, 'truncated', 'unterminated conditional section');
    if (open >= 0 && open < close) {
      depth++;
      i = open + 3;
    } else {
      depth--;
      i = close + 3;
    }
  }
  // An unread parameter entity as the keyword: the section's contents cannot be known.
  if (keyword === 'INCLUDE') declarations(text.slice(start, i - 3), dtd, ctx);
  else if (keyword !== 'IGNORE' && keyword !== undefined) throw syntax(dtd, 'INCLUDE or IGNORE expected');
  return i;
}

/** Reads a run of markup declarations, parameter entity references, comments and processing instructions (2.8). */
function declarations(text: string, dtd: DTD, ctx: Context): void {
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) i++;
    else if (code === 37 /* % */) {
      const end = text.indexOf(';', i);
      if (end < 0) throw syntax(dtd, 'a % in the DTD that is not a parameter entity reference');
      const included = parameter(text.slice(i + 1, end), dtd, ctx);
      // Included as PE (4.4.8): it must hold whole declarations (WFC PE Between Declarations).
      if (included) declarations(included.text, dtd, included.ctx);
      i = end + 1;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) throw new LoaderError(dtd.format, 'truncated', 'unterminated comment in the DTD');
      i = end + 3;
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) throw new LoaderError(dtd.format, 'truncated', 'unterminated processing instruction in the DTD');
      i = end + 2;
    } else if (text.startsWith('<![', i)) i = conditional(text, i, dtd, ctx);
    else if (text.startsWith('<!', i)) {
      const end = declarationEnd(text, i, dtd);
      markup(text.slice(i + 2, end), dtd, ctx);
      i = end + 1;
    } else throw syntax(dtd, `unexpected ${JSON.stringify(text.slice(i, i + 16))} in the DTD`);
  }
}

/**
 * The `<!DOCTYPE` at `lt` (2.8): reads the internal subset, then the external subset when `external` holds it, and
 * returns the index past the declaration.
 */
function doctype(xml: string, lt: number, dtd: DTD, base: string | undefined): number {
  const truncated = () => new LoaderError(dtd.format, 'truncated', 'unterminated DOCTYPE');
  const cursor = new Cursor(xml, dtd);
  cursor.i = lt + 9;
  cursor.space();
  cursor.name();
  let system: string | undefined, publicId: string | undefined;
  if (cursor.skip() && (cursor.peek() === 'S' || cursor.peek() === 'P')) {
    const keyword = cursor.name();
    if (keyword === 'PUBLIC') {
      cursor.space();
      publicId = cursor.literal();
    } else if (keyword !== 'SYSTEM') cursor.fail('SYSTEM or PUBLIC expected');
    cursor.space();
    system = cursor.literal();
    cursor.skip();
  }
  let subset = '';
  if (cursor.peek() === '[') {
    // The internal subset ends at the first ] outside literals, comments and processing instructions.
    let quote = 0,
      i = cursor.i + 1;
    for (; i < xml.length; i++) {
      const code = xml.charCodeAt(i);
      if (quote) {
        if (code === quote) quote = 0;
      } else if (code === 34 || code === 39) quote = code;
      else if (code === 93 /* ] */) break;
      else if (code === 60 /* < */ && xml.startsWith('<![', i))
        throw syntax(dtd, 'a conditional section outside the external subset');
      else if (code === 60 /* < */ && (xml.startsWith('<!--', i) || xml.startsWith('<?', i))) {
        const end = xml.indexOf(xml[i + 1] === '!' ? '-->' : '?>', i + 2);
        if (end < 0) throw truncated();
        i = end + 1;
      }
    }
    if (i >= xml.length) throw truncated();
    subset = xml.slice(cursor.i + 1, i);
    cursor.i = i + 1;
    cursor.skip();
  }
  if (cursor.i >= xml.length) throw truncated();
  if (cursor.peek() !== '>') cursor.fail('> expected');
  declarations(subset, dtd, { external: false, base, open: [] });
  // The external subset is read after the internal one, whose declarations therefore bind first.
  if (system !== undefined) {
    const id = resolveId(system, base);
    const text = externalText(dtd, id, publicId);
    if (text === undefined) dtd.incomplete = true;
    else declarations(text, dtd, { external: true, base: id, open: [] });
  }
  return cursor.i + 1;
}

/**
 * The replacement text of general entity `name` in content or (`attribute`) an attribute value, checked against the
 * well-formedness constraints of 4.1: declared, not recursive, parsed, and not external inside an attribute value.
 */
function general(name: string, dtd: DTD, open: readonly string[], attribute: boolean): string {
  const shown = `&${name.slice(0, 64)};`;
  const entity = dtd.general.get(name);
  if (!entity) {
    if (dtd.incomplete && !dtd.standalone)
      throw new LoaderError(
        dtd.format,
        'unsupported',
        `entity ${shown} is not declared in the part of the DTD that was read; read the external DTD with resolveDTD and pass the result as external`,
      );
    throw syntax(dtd, `unknown entity ${shown}`);
  }
  if (open.includes(name)) throw syntax(dtd, `entity ${shown} refers to itself`);
  if (entity.unparsed) throw syntax(dtd, `entity ${shown} is an unparsed (NDATA) entity, which may not be referenced`);
  let text = entity.value;
  if (text === undefined) {
    if (attribute) throw syntax(dtd, `an attribute value refers to the external entity ${shown}`);
    text = externalText(dtd, entity.system as string, entity.publicId);
    if (text === undefined)
      throw new LoaderError(
        dtd.format,
        'unsupported',
        `entity ${shown} is external (${(entity.system as string).slice(0, 128)}) and was not read; read it with resolveDTD and pass the result as external`,
      );
  }
  charge(dtd, text.length);
  return text;
}

/**
 * Attribute-value normalization (3.3.3): each literal tab, line feed and carriage return becomes a space, character
 * references expand, and entity references expand with the same normalization applied to their replacement text.
 */
function attributeValue(raw: string, dtd: DTD, open: readonly string[] = []): string {
  const value = raw.replace(/[\t\n\r]/g, ' ');
  if (value.indexOf('&') < 0) return value;
  return value.replace(REFERENCE, (match, name: string) => {
    if (name[0] === '#') return characterReference(match, name, dtd.format);
    if (Object.hasOwn(PREDEFINED, name)) return PREDEFINED[name];
    const text = general(name, dtd, open, true);
    // Well-formedness constraint No < in Attribute Values (3.1).
    if (text.includes('<')) throw syntax(dtd, `entity ${match.slice(0, 64)} puts < in an attribute value`);
    return attributeValue(text, dtd, [...open, name]);
  });
}

// The lookbehind starts a name only at a token boundary, so a long run with no `=` is scanned once, not once per
// character (quadratic, ReDoS).
const ATTRIBUTE = /(?<![^\s=/"'])([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** What `readXML` calls as it walks a document: `open` and `close` per element and `text` per run of text. */
export interface XMLHandler {
  /** Element names are local names (namespace prefix removed). */
  open(name: string, attributes: Record<string, string>): void;
  close(name: string): void;
  text?(text: string): void;
}

/**
 * Non-validating streaming XML reader (XML 1.0 Fifth Edition, 5.1). Skips comments and processing instructions,
 * keeps CDATA as text, normalizes line ends and attribute whitespace, and checks that tags nest. From the DOCTYPE it
 * reads the internal subset in full: general and parameter entities (parameter entity references between and, in
 * the external subset, inside declarations), attribute defaults and types, and conditional sections in the external
 * subset. An entity holding markup is read as content and must hold whole elements. The external subset and
 * external entities are read only from `options.external` ({@link resolveDTD}); nothing is fetched here. At most
 * `maxExpansion` characters (default 1 Mi) come from entity references.
 *
 * @param maxDepth Deepest element nesting (default 256), or the options.
 */
export function readXML(
  xml: string,
  handler: XMLHandler,
  format = 'XML',
  maxDepth: number | XMLReadOptions = 256,
): void {
  const options: XMLReadOptions = typeof maxDepth === 'number' ? { maxDepth } : maxDepth;
  const depthLimit = options.maxDepth ?? 256;
  // End-of-line handling (2.11): CR LF and a lone CR read as LF.
  if (xml.indexOf('\r') >= 0) xml = xml.replace(/\r\n?/g, '\n');
  const standalone = /^﻿?<\?xml\s[^>]*?\bstandalone\s*=\s*["']yes["']/.test(xml);
  const dtd = newDTD(format, options, standalone);
  const stack: string[] = [];

  /** A run of character data: references expand; an entity holding markup or references is read as content. */
  const characters = (raw: string, open: readonly string[]): void => {
    if (!stack.length) return;
    if (raw.indexOf('&') < 0) {
      if (raw && handler.text) handler.text(raw);
      return;
    }
    let out = '',
      last = 0;
    const flush = (): void => {
      if (out && handler.text) handler.text(out);
      out = '';
    };
    // Its own copy: reading an entity's content below runs this function again.
    const reference = new RegExp(REFERENCE);
    for (let match = reference.exec(raw); match; match = reference.exec(raw)) {
      out += raw.slice(last, match.index);
      last = reference.lastIndex;
      const name = match[1];
      if (name[0] === '#') out += characterReference(match[0], name, format);
      else if (Object.hasOwn(PREDEFINED, name)) out += PREDEFINED[name];
      else {
        const text = general(name, dtd, open, false);
        if (text.indexOf('<') < 0 && text.indexOf('&') < 0) out += text;
        else {
          flush();
          // Included (4.4.2): the replacement text is read as content, and must be well-formed on its own (4.3.2).
          content(text, [...open, name]);
        }
      }
    }
    out += raw.slice(last);
    flush();
  };

  /** Reads `text` as content: the document itself, or the replacement text of entity `open.at(-1)`. */
  const content = (text: string, open: readonly string[]): void => {
    const base = stack.length,
      length = text.length,
      inEntity = open.length > 0;
    let pos = 0;
    while (pos < length) {
      const lt = text.indexOf('<', pos);
      if (lt < 0) {
        characters(text.slice(pos), open);
        break;
      }
      if (lt > pos) characters(text.slice(pos, lt), open);
      const next = text.charCodeAt(lt + 1);
      if (next === 33 /* ! */) {
        if (text.startsWith('<!DOCTYPE', lt)) {
          if (inEntity || stack.length) throw new LoaderError(format, 'syntax', 'a DOCTYPE inside the document');
          pos = doctype(text, lt, dtd, options.base);
          continue;
        }
        const terminator = text.startsWith('<!--', lt) ? '-->' : text.startsWith('<![CDATA[', lt) ? ']]>' : '>';
        const end = text.indexOf(terminator, lt + 2);
        if (end < 0) throw new LoaderError(format, 'truncated', 'unterminated comment, CDATA or declaration');
        if (terminator === ']]>' && stack.length && handler.text) handler.text(text.slice(lt + 9, end));
        pos = end + terminator.length;
        continue;
      }
      if (next === 63 /* ? */) {
        const end = text.indexOf('?>', lt + 2);
        if (end < 0) throw new LoaderError(format, 'truncated', 'unterminated processing instruction');
        pos = end + 2;
        continue;
      }
      // Find the closing '>' outside quoted attribute values.
      let end = lt + 1,
        quote = 0;
      for (; end < length; end++) {
        const code = text.charCodeAt(end);
        if (quote) {
          if (code === quote) quote = 0;
        } else if (code === 34 || code === 39) quote = code;
        else if (code === 62) break;
      }
      if (end >= length) throw new LoaderError(format, 'truncated', 'unterminated tag');
      const body = text.slice(lt + 1, end);
      pos = end + 1;
      if (body[0] === '/') {
        const name = local(body.slice(1).trim());
        if (inEntity && stack.length === base)
          throw new LoaderError(
            format,
            'syntax',
            `</${name}> in entity &${open[open.length - 1]}; closes an element opened outside it`,
          );
        const opened = stack.pop();
        if (opened !== name)
          throw new LoaderError(format, 'syntax', `closing tag </${name}> does not match <${opened ?? 'nothing'}>`);
        handler.close(name);
        continue;
      }
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const nameEnd = inner.search(/[\s]/);
      const raw = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
      if (!raw) throw new LoaderError(format, 'syntax', 'empty tag name');
      const name = local(raw);
      // Null prototype: attribute names come from the file (`__proto__="..."`, `constructor="..."`).
      const attributes: Record<string, string> = Object.create(null);
      if (nameEnd >= 0) {
        ATTRIBUTE.lastIndex = 0;
        const rest = inner.slice(nameEnd);
        let match: RegExpExecArray | null;
        while ((match = ATTRIBUTE.exec(rest))) attributes[match[1]] = attributeValue(match[2] ?? match[3], dtd);
      }
      // Declared attributes (3.3): tokenized types normalize further, and defaults fill in missing ones (5.1).
      const declared = dtd.attributes.get(raw);
      if (declared)
        for (const [attribute, declaration] of declared) {
          const value = attributes[attribute];
          if (value !== undefined) attributes[attribute] = tokens(value, declaration.cdata);
          else if (declaration.value !== undefined) attributes[attribute] = declaration.value;
        }
      if (stack.length >= depthLimit) throw new LoaderError(format, 'limit', `elements nest deeper than ${depthLimit}`);
      stack.push(name);
      handler.open(name, attributes);
      if (selfClosing) {
        stack.pop();
        handler.close(name);
      }
    }
    if (inEntity && stack.length !== base)
      throw new LoaderError(
        format,
        'syntax',
        `entity &${open[open.length - 1]}; ends inside <${stack[stack.length - 1]}>, which it opened`,
      );
  };

  content(xml, []);
  if (stack.length) throw new LoaderError(format, 'truncated', `document ends inside <${stack[stack.length - 1]}>`);
}

/** One element of a document read by `readXMLTree`. */
export interface XMLElement {
  name: string;
  attributes: Record<string, string>;
  children: XMLElement[];
  /** The element's own text (not its children's), concatenated. */
  text: string;
}

/** Reads a whole document into elements; returns a nameless root whose children are the top-level elements. */
export function readXMLTree(xml: string, format: string, options: XMLReadOptions = {}): XMLElement {
  const root: XMLElement = { name: '', attributes: Object.create(null), children: [], text: '' },
    stack = [root];
  readXML(
    xml,
    {
      open(name, attributes) {
        const element: XMLElement = { name, attributes, children: [], text: '' };
        stack[stack.length - 1].children.push(element);
        stack.push(element);
      },
      close() {
        stack.pop();
      },
      text(text) {
        stack[stack.length - 1].text += text;
      },
    },
    format,
    options,
  );
  return root;
}

/** The index of the document's `<!DOCTYPE`, past its XML declaration, comments and processing instructions; -1 if none. */
function findDoctype(xml: string): number {
  for (let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0; i < xml.length; ) {
    if (/\s/.test(xml[i])) i++;
    else if (xml.startsWith('<?', i) || xml.startsWith('<!--', i)) {
      const end = xml.indexOf(xml[i + 1] === '?' ? '?>' : '-->', i + 2);
      if (end < 0) return -1;
      i = end + (xml[i + 1] === '?' ? 2 : 3);
    } else return xml.startsWith('<!DOCTYPE', i) ? i : -1;
  }
  return -1;
}

/**
 * Reads what a document's DOCTYPE needs from outside it: the external DTD subset, the external parameter entities it
 * uses, and the external general entities the document references, each through `options.resolve`, until nothing
 * more is needed. Pass the result to `readXML` or `readXMLTree` as `external`. This is the only way external
 * entities are read: fetching is opt-in, as XML from untrusted sources should not make a reader fetch URLs it names.
 *
 * @throws LoaderError with code `limit` past `maxFiles` or `maxCharacters`, `aborted` when `signal` fires, `fetch`
 * when `resolve` fails (its error is the `cause`), and the reader's own codes for a malformed DTD.
 * @example
 * ```ts
 * import { readXMLTree, resolveDTD } from '@margoengine/loaders/xml';
 *
 * const files = new Map([['parts.dtd', '<!ENTITY bolt "M6 bolt"><!ATTLIST part unit CDATA "mm">']]);
 * const xml = '<!DOCTYPE parts SYSTEM "parts.dtd"><parts><part>&bolt;</part></parts>';
 * const external = await resolveDTD(xml, { resolve: (id) => files.get(id) ?? '' });
 * const part = readXMLTree(xml, 'Parts', { external }).children[0].children[0];
 * console.log(part.text, part.attributes.unit); // M6 bolt mm
 * ```
 */
export async function resolveDTD(
  xml: string,
  options: XMLResolveOptions,
  format = 'XML',
): Promise<Map<string, string>> {
  const { signal } = options,
    maxFiles = options.maxFiles ?? 64,
    maxCharacters = options.maxCharacters ?? 1 << 24;
  if (!(maxFiles >= 0) || !(maxCharacters >= 0))
    throw new LoaderError(format, 'range', 'maxFiles and maxCharacters must be 0 or more');
  if (xml.indexOf('\r') >= 0) xml = xml.replace(/\r\n?/g, '\n');
  const external = new Map<string, string>(),
    lt = findDoctype(xml),
    standalone = /^﻿?<\?xml\s[^>]*?\bstandalone\s*=\s*["']yes["']/.test(xml);
  let characters = 0;
  while (lt >= 0) {
    if (signal?.aborted) throw new LoaderError(format, 'aborted', 'aborted');
    const dtd = newDTD(format, { external, maxExpansion: Infinity }, standalone);
    doctype(xml, lt, dtd, options.base);
    const wanted = dtd.missing,
      texts = [xml, ...external.values()];
    for (const [name, entity] of dtd.general)
      if (
        entity.system &&
        !entity.unparsed &&
        !external.has(entity.system) &&
        texts.some((t) => t.includes(`&${name};`))
      )
        wanted.set(entity.system, entity.publicId);
    if (!wanted.size) break;
    if (external.size + wanted.size > maxFiles)
      throw new LoaderError(format, 'limit', `the DTD needs more than maxFiles (${maxFiles}) external entities`);
    const read = await Promise.all(
      [...wanted].map(async ([id, publicId]) => {
        let got: string | Uint8Array | ArrayBuffer;
        try {
          got = await options.resolve(id, { publicId, signal });
        } catch (cause) {
          if (signal?.aborted) throw new LoaderError(format, 'aborted', 'aborted');
          const error = new LoaderError(format, 'fetch', `could not read the external entity ${id.slice(0, 128)}`);
          error.cause = cause;
          throw error;
        }
        return [
          id,
          typeof got === 'string' ? got : decodeXML(got instanceof Uint8Array ? got : new Uint8Array(got)),
        ] as const;
      }),
    );
    if (signal?.aborted) throw new LoaderError(format, 'aborted', 'aborted');
    for (const [id, text] of read) {
      if ((characters += text.length) > maxCharacters)
        throw new LoaderError(format, 'limit', `external entities hold more than maxCharacters (${maxCharacters})`);
      external.set(id, text);
    }
  }
  return external;
}

function local(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/**
 * Decodes XML bytes (4.3.3): UTF-16 when a byte order mark says so, otherwise the `encoding` of the XML
 * declaration (such as ISO-8859-1 or windows-1252), otherwise UTF-8. An encoding this runtime cannot decode
 * throws a LoaderError with code `unsupported`, the fatal error the specification asks for.
 */
export function decodeXML(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  let head = '';
  for (let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0; i < bytes.length && i < 256; i++) {
    head += String.fromCharCode(bytes[i]);
    if (bytes[i] === 0x3e /* > */) break;
  }
  const label = /^<\?xml\s[^>]*?\bencoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["']/.exec(head)?.[1].toLowerCase();
  if (!label || label === 'utf-8' || label === 'utf8' || /^utf-16/.test(label))
    return new TextDecoder('utf-8').decode(bytes);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    throw new LoaderError('XML', 'unsupported', `encoding "${label.slice(0, 40)}" cannot be decoded here`);
  }
  return decoder.decode(bytes);
}
