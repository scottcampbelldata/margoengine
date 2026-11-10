// Text USD (.usda) read in full: composition arcs, list edits, variant sets, time samples and value blocks, into the
// same spec map the Crate reader makes in its full mode. Written from the public USD file format documentation and the
// output of `usdcat`. The static subset of @margoengine/loaders stays the base reader; this one is only in the bundle
// of an app that imports /compose.
import { LoaderError } from '@margoengine/loaders/common';
import type { ListOp, Specs, TimeSamples } from './crate.js';

const fail = (code: 'syntax' | 'limit', message: string): never => {
  throw new LoaderError('USD', code, message);
};
const LIST_EDITS: Record<string, keyof ListOp<unknown>> = {
  prepend: 'prepend',
  append: 'append',
  add: 'add',
  delete: 'delete',
  reorder: 'order',
};
/** Prim metadata with list edits, by the name of the field the spec holds it in. */
const LIST_FIELDS: Record<string, string> = {
  references: 'references',
  payload: 'payload',
  inherits: 'inheritPaths',
  specializes: 'specializes',
  variantSets: 'variantSetNames',
  apiSchemas: 'apiSchemas',
  clipSets: 'clipSets',
};
const WORD = /[\p{L}\p{N}_:.!|-]/u;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isDigitStart = (c: number) => (c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46;

/** One absolute path from a path as written, which may be relative to the prim that holds it. */
export function absolutePath(path: string, prim: string): string {
  if (path.startsWith('/') || !path) return path;
  let base = prim;
  let rest = path;
  while (rest.startsWith('../')) {
    base = base.slice(0, Math.max(base.lastIndexOf('/'), 0));
    rest = rest.slice(3);
  }
  if (rest === '..') return base.slice(0, Math.max(base.lastIndexOf('/'), 0)) || '/';
  if (rest === '.') return base;
  if (rest.startsWith('./')) rest = rest.slice(2);
  return rest.startsWith('.') ? base + rest : (base === '/' ? '' : base) + '/' + rest;
}

/** Reads a whole text layer. `maxDepth` bounds the prim hierarchy; `signal` is checked at each prim. */
export function readTextLayer(text: string, maxDepth: number, signal?: AbortSignal): Specs {
  if (!text.startsWith('#usda ')) fail('syntax', 'expected #usda');
  const end = text.length;
  let at = text.indexOf('\n');
  if (at < 0) at = end;
  const specs: Specs = Object.create(null);

  const skip = () => {
    for (;;) {
      const c = text.charCodeAt(at);
      if (isSpace(c)) at++;
      else if (c === 35) {
        const line = text.indexOf('\n', at);
        at = line < 0 ? end : line;
      } else if (c === 47 && text.charCodeAt(at + 1) === 47) {
        const line = text.indexOf('\n', at);
        at = line < 0 ? end : line;
      } else if (c === 47 && text.charCodeAt(at + 1) === 42) {
        const close = text.indexOf('*/', at + 2);
        at = close < 0 ? end : close + 2;
      } else return;
    }
  };
  const peek = () => {
    skip();
    return text[at] ?? '';
  };
  const accept = (s: string) => {
    if (peek() === s) {
      at++;
      return true;
    }
    return false;
  };
  const expect = (s: string) => {
    if (!accept(s)) fail('syntax', `expected ${s} at offset ${at}`);
  };
  const word = (): string => {
    skip();
    const start = at;
    while (at < end) {
      const c = text.charCodeAt(at);
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 46)
        at++;
      else if (c === 33 || c === 124 || (c === 45 && at > start)) at++;
      else if (c > 127 && WORD.test(String.fromCodePoint(text.codePointAt(at)!)))
        at += text.codePointAt(at)! > 0xffff ? 2 : 1;
      else break;
    }
    if (at === start) fail('syntax', `expected a name at offset ${at}`);
    return text.slice(start, at);
  };
  const string = (): string => {
    skip();
    const quote = text[at];
    if (quote !== '"' && quote !== "'") fail('syntax', `expected a string at offset ${at}`);
    const triple = text.startsWith(quote.repeat(3), at);
    const mark = triple ? quote.repeat(3) : quote;
    let i = at + mark.length,
      out = '',
      from = i;
    for (;;) {
      if (i >= end) fail('syntax', 'unterminated string');
      if (text[i] === '\\') {
        out += text.slice(from, i);
        const e = text[i + 1];
        const escapes: Record<string, string> = {
          n: '\n',
          t: '\t',
          r: '\r',
          '\\': '\\',
          '"': '"',
          "'": "'",
          '0': '\0',
        };
        out += escapes[e] ?? e;
        i += 2;
        from = i;
      } else if (text.startsWith(mark, i)) {
        out += text.slice(from, i);
        at = i + mark.length;
        return out;
      } else i++;
    }
  };
  const asset = (): string => {
    const mark = text.startsWith('@@@', at) ? '@@@' : '@';
    const close = text.indexOf(mark, at + mark.length);
    if (close < 0) fail('syntax', 'unterminated asset path');
    const value = text.slice(at + mark.length, close);
    at = close + mark.length;
    return value;
  };
  const pathValue = (): string => {
    const close = text.indexOf('>', at);
    if (close < 0) fail('syntax', 'unterminated path');
    const value = text.slice(at + 1, close);
    at = close + 1;
    return value;
  };
  const number = (): number => {
    const start = at;
    while (at < end) {
      const c = text.charCodeAt(at);
      if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46 || c === 101 || c === 69) at++;
      else break;
    }
    const n = Number(text.slice(start, at));
    if (Number.isNaN(n)) fail('syntax', `invalid number at offset ${start}`);
    return n;
  };

  /** Numbers of an array or tuple at any nesting, appended in order; false when something else is inside. */
  const flat = (out: number[]): boolean => {
    const start = at;
    let depth = 0;
    for (;;) {
      skip();
      const c = text.charCodeAt(at);
      if (c === 91 || c === 40) {
        depth++;
        at++;
      } else if (c === 93 || c === 41) {
        depth--;
        at++;
        if (!depth) return true;
      } else if (c === 44) at++;
      else if (isDigitStart(c) && !text.startsWith('-inf', at)) out.push(number());
      else if (text.startsWith('inf', at) || text.startsWith('-inf', at)) {
        const negative = text[at] === '-';
        at += negative ? 4 : 3;
        out.push(negative ? -Infinity : Infinity);
      } else if (text.startsWith('nan', at)) {
        at += 3;
        out.push(NaN);
      } else {
        at = start;
        out.length = 0;
        return false;
      }
    }
  };

  /** Any value. Numbers in brackets come back flat; `null` is the `None` of a blocked value. */
  function value(owner: string, depth = 0): unknown {
    if (depth > 64) fail('limit', 'nested value exceeds the depth limit');
    skip();
    const c = text[at];
    if (c === '[' || c === '(') {
      const numbers: number[] = [];
      if (flat(numbers)) return numbers;
      const close = c === '[' ? ']' : ')',
        out: unknown[] = [];
      at++;
      while (peek() !== close) {
        if (at >= end) fail('syntax', 'unterminated list');
        out.push(value(owner, depth + 1));
        if (peek() === '(') skipParens();
        if (!accept(',') && peek() !== close) fail('syntax', `expected a comma at offset ${at}`);
      }
      at++;
      return out;
    }
    if (c === '{') return dictionary(owner, depth + 1);
    if (c === '"' || c === "'") return string();
    if (c === '@') {
      const assetPath = asset();
      // A reference or payload item may follow its asset with a prim path.
      return peek() === '<' ? { assetPath, primPath: absolutePath(pathValue(), owner) } : { assetPath };
    }
    if (c === '<') return { path: absolutePath(pathValue(), owner) };
    if (isDigitStart(text.charCodeAt(at)) && !text.startsWith('-inf', at)) return number();
    const name = word();
    if (name === 'None') return null;
    if (name === 'true' || name === 'True') return true;
    if (name === 'false' || name === 'False') return false;
    if (name === 'inf') return Infinity;
    if (name === '-inf') return -Infinity;
    if (name === 'nan') return NaN;
    return name;
  }
  function skipParens() {
    expect('(');
    while (!accept(')')) {
      if (at >= end) fail('syntax', 'unterminated metadata');
      const c = peek();
      if (c === '(') skipParens();
      else if (c === '"' || c === "'") string();
      else if (c === '@') asset();
      else if (c === '<') pathValue();
      else if (c === '{') dictionary('', 1);
      else if (c === '[') value('');
      else at++;
    }
  }
  /** A `{ type name = value }` dictionary. Keys may be quoted. */
  function dictionary(owner: string, depth: number): Record<string, unknown> {
    expect('{');
    const out: Record<string, unknown> = Object.create(null);
    while (!accept('}')) {
      if (at >= end) fail('syntax', 'unterminated dictionary');
      const type = word();
      if (accept('[')) expect(']');
      const key = peek() === '"' || peek() === "'" ? string() : word();
      expect('=');
      out[key] = value(owner, depth);
      accept(';');
      accept(',');
    }
    return out;
  }
  /** `{ 0: value, 1.5: None }`, with times and values in file order. */
  function timeSamples(owner: string): TimeSamples {
    expect('{');
    const times: number[] = [],
      values: unknown[] = [];
    while (!accept('}')) {
      if (at >= end) fail('syntax', 'unterminated time samples');
      skip();
      times.push(number());
      expect(':');
      values.push(value(owner));
      accept(',');
    }
    return { times, values };
  }

  /** A list-edit value as a plain list: `None` is the empty list, one item a list of one. */
  const listOf = (raw: unknown): unknown[] =>
    raw === null ? [] : Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  /** Adds `items` to the field's list op under `edit`, or as its explicit list. */
  function edit(fields: Record<string, unknown>, name: string, edit: string | undefined, items: unknown[]) {
    const op = (fields[name] ??= {}) as ListOp<unknown>;
    if (edit) op[LIST_EDITS[edit]] = items;
    else op.explicit = items;
  }
  /** One item of a reference or payload list, with its layer offset when the file gives one. */
  function arcItems(owner: string): unknown[] {
    const item = () => {
      skip();
      const c = text[at];
      let out: { assetPath: string; primPath: string; offset: number; scale: number };
      if (c === '@') {
        const assetPath = asset();
        out = {
          assetPath,
          primPath: peek() === '<' ? absolutePath(pathValue(), owner) : '',
          offset: 0,
          scale: 1,
        };
      } else if (c === '<') out = { assetPath: '', primPath: absolutePath(pathValue(), owner), offset: 0, scale: 1 };
      else return fail('syntax', `invalid composition arc at offset ${at}`);
      if (peek() === '(') {
        at++;
        while (!accept(')')) {
          if (at >= end) fail('syntax', 'unterminated layer offset');
          const key = word();
          if (key === 'customData') {
            expect('=');
            dictionary(owner, 1);
          } else {
            expect('=');
            const v = value(owner);
            if (key === 'offset' && typeof v === 'number') out.offset = v;
            if (key === 'scale' && typeof v === 'number') out.scale = v;
          }
          accept(';');
        }
      }
      return out;
    };
    skip();
    if (text.startsWith('None', at)) {
      at += 4;
      return [];
    }
    if (!accept('[')) return [item()];
    const out: unknown[] = [];
    while (!accept(']')) {
      if (at >= end) fail('syntax', 'unterminated composition list');
      out.push(item());
      accept(',');
    }
    return out;
  }
  const plain = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? 'path' in v
        ? (v as { path: string }).path
        : 'assetPath' in v
          ? (v as { assetPath: string }).assetPath
          : v
      : Array.isArray(v)
        ? v.map(plain)
        : v;

  /** The `( ... )` of the pseudo root or a prim, into `fields`. */
  function primMetadata(fields: Record<string, unknown>, owner: string) {
    expect('(');
    while (!accept(')')) {
      if (at >= end) fail('syntax', 'unterminated metadata');
      if (peek() === '"' || peek() === "'") {
        fields.documentation = string();
        accept(';');
        continue;
      }
      let key = word(),
        list: string | undefined;
      if (key in LIST_EDITS) {
        list = key;
        key = word();
      }
      expect('=');
      if (key === 'references' || key === 'payload') edit(fields, key, list, arcItems(owner));
      else if (key === 'subLayers') {
        const items = arcItems(owner) as { assetPath: string; offset: number; scale: number }[];
        fields.subLayers = items.map((item) => item.assetPath);
        fields.subLayerOffsets = items.map(({ offset, scale }) => ({ offset, scale }));
      } else if (key in LIST_FIELDS) edit(fields, LIST_FIELDS[key], list, listOf(plain(value(owner))));
      else if (key === 'variants') fields.variantSelection = value(owner);
      else fields[key] = plain(value(owner));
      accept(';');
    }
  }
  /** The `( ... )` of a property. */
  function propertyMetadata(fields: Record<string, unknown>, owner: string) {
    expect('(');
    while (!accept(')')) {
      if (at >= end) fail('syntax', 'unterminated metadata');
      if (peek() === '"' || peek() === "'") {
        fields.documentation = string();
        accept(';');
        continue;
      }
      const key = word();
      expect('=');
      fields[key] = plain(value(owner));
      accept(';');
    }
  }
  const spec = (path: string, specType: number): Record<string, unknown> => {
    const existing = specs[path];
    if (existing) return existing.fields;
    const fields: Record<string, unknown> = Object.create(null);
    specs[path] = { specType, fields };
    return fields;
  };
  function property(prim: string) {
    let first = word(),
      list: string | undefined;
    if (first in LIST_EDITS) {
      list = first;
      first = word();
    }
    let custom = false;
    if (first === 'custom') {
      custom = true;
      first = word();
    }
    let variability: string | undefined;
    if (first === 'varying' || first === 'uniform' || first === 'config') {
      variability = first;
      first = word();
    }
    if (first === 'rel') {
      const name = word(),
        bare = name.endsWith('.default') ? name.slice(0, -8) : name,
        path = prim + '.' + bare,
        fields = spec(path, 8);
      if (custom) fields.custom = true;
      if (accept('=')) {
        const targets = listOf(plain(value(prim))) as string[];
        edit(fields, 'targetPaths', list, targets);
      }
      if (peek() === '(') propertyMetadata(fields, prim);
      return;
    }
    let type = first;
    if (peek() === '[') {
      at++;
      expect(']');
      type += '[]';
    }
    const raw = word();
    const suffix = /\.(connect|timeSamples|default|spline)$/.exec(raw)?.[1],
      name = suffix ? raw.slice(0, -suffix.length - 1) : raw,
      fields = spec(prim + '.' + name, 1);
    fields.typeName = type;
    if (custom) fields.custom = true;
    if (variability) fields.variability = variability;
    if (accept('=')) {
      if (suffix === 'connect') edit(fields, 'connectionPaths', list, listOf(plain(value(prim))));
      else if (suffix === 'timeSamples') fields.timeSamples = timeSamples(prim);
      else if (suffix === 'spline') skipBraces();
      else fields.default = plain(value(prim));
    }
    if (peek() === '(') propertyMetadata(fields, prim);
  }
  function skipBraces() {
    expect('{');
    for (let open = 1; open; ) {
      const c = peek();
      if (at >= end) fail('syntax', 'unterminated block');
      if (c === '"' || c === "'") string();
      else {
        at++;
        if (c === '{') open++;
        if (c === '}') open--;
      }
    }
  }
  function body(prim: string, depth: number) {
    while (!accept('}')) {
      if (at >= end) fail('syntax', 'unterminated prim');
      const start = at;
      skip();
      const first = word();
      if (first === 'def' || first === 'over' || first === 'class') {
        at = start;
        primSpec(prim, depth + 1);
      } else if (first === 'variantSet') {
        const set = string();
        expect('=');
        expect('{');
        const owner = spec(prim, 6);
        (owner.variantSetChildren ??= [] as string[]) as string[];
        while (!accept('}')) {
          if (at >= end) fail('syntax', 'unterminated variant set');
          const name = string(),
            path = `${prim}{${set}=${name}}`,
            fields = spec(path, 10);
          if (peek() === '(') primMetadata(fields, path);
          expect('{');
          body(path, depth);
        }
      } else if (first === 'reorder' && /^(nameChildren|properties)$/.test(peekWord())) {
        word();
        expect('=');
        value(prim);
      } else {
        at = start;
        property(prim);
      }
      accept(';');
    }
  }
  function peekWord(): string {
    const saved = at,
      name = word();
    at = saved;
    return name;
  }
  function primSpec(parent: string, depth: number) {
    if (depth > maxDepth) fail('limit', 'prim hierarchy exceeds maxDepth');
    signal?.throwIfAborted();
    const specifier = word(),
      code =
        specifier === 'def'
          ? 0
          : specifier === 'over'
            ? 1
            : specifier === 'class'
              ? 2
              : fail('syntax', 'expected a prim');
    let typeName = '';
    if (peek() !== '"' && peek() !== "'") typeName = word();
    const name = string(),
      path = (parent === '/' ? '' : parent) + '/' + name,
      fields = spec(path, 6);
    fields.specifier = code;
    if (typeName) fields.typeName = typeName;
    if (peek() === '(') primMetadata(fields, path);
    expect('{');
    body(path, depth);
  }

  const root = spec('/', 7);
  if (peek() === '(') primMetadata(root, '/');
  while (peek()) primSpec('/', 1);
  return specs;
}
