// WGSL lexer, written from the W3C WGSL specification, section 3 ("Textual Structure"): blankspace and line breaks,
// nested block comments, identifiers (Unicode XID), keywords and reserved words, numeric literals with suffixes, and
// the template-list discovery algorithm that tells `<` and `>` of `vec3<f32>` from less-than and greater-than.
import { SourceMap, WGSL_LIMITS } from './errors.js';

/** Token kinds. Template brackets are `<` / `>` punctuation with {@link Token.template} set. */
type TokenKind = 'ident' | 'keyword' | 'int' | 'float' | 'punct' | 'eof';

/** One token. `value` is the source text (for literals too); offsets are UTF-16 code units. */
export interface Token {
  readonly kind: TokenKind;
  value: string;
  readonly start: number;
  end: number;
  /** For `<` and `>`: true when the template-list discovery made it a template bracket. */
  template?: boolean;
}

/** Keywords (WGSL section 15.1). */
const KEYWORDS: ReadonlySet<string> = new Set(
  'alias break case const const_assert continue continuing default diagnostic discard else enable false fn for if let loop override requires return struct switch true var while'.split(
    ' ',
  ),
);

/** Reserved words (WGSL section 15.2): an identifier may not spell one. */
const RESERVED: ReadonlySet<string> = new Set(
  (
    'NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become cast catch class ' +
    'co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval ' +
    'constexpr constinit crate debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export ' +
    'extends extern external fallthrough filter final finally friend from fxgroup get goto groupshared highp impl ' +
    'implements import inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move ' +
    'mut mutable namespace new nil noexcept noinline nointerpolation non_coherent noncoherent noperspective null ' +
    'nullptr of operator package packoffset partition pass patch pixelfragment precise precision premerge priv ' +
    'protected pub public readonly ref regardless register reinterpret_cast require resource restrict self set shared ' +
    'sizeof smooth snorm static static_assert static_cast std subroutine super target template this thread_local ' +
    'throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using varying virtual ' +
    'volatile wgsl where with writeonly yield'
  ).split(' '),
);

// Longest first. `<` and `>` stay single: template discovery decides them, then `join` merges the rest.
const PUNCT = [
  '->',
  '&&',
  '||',
  '==',
  '!=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '++',
  '--',
  '&',
  '|',
  '^',
  '~',
  '!',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  '.',
  ':',
  ';',
  '@',
];

const IDENT = /[\p{XID_Start}_]\p{XID_Continue}*/uy;
const HEX_FLOAT =
  /0[xX](?:(?:[0-9a-fA-F]*\.[0-9a-fA-F]+|[0-9a-fA-F]+\.[0-9a-fA-F]*)(?:[pP][+-]?[0-9]+[fh]?)?|[0-9a-fA-F]+[pP][+-]?[0-9]+[fh]?)/y;
const HEX_INT = /0[xX][0-9a-fA-F]+[iu]?/y;
const DEC_FLOAT =
  /(?:[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?[fh]?|[0-9]+\.[0-9]*(?:[eE][+-]?[0-9]+)?[fh]?|[0-9]+[eE][+-]?[0-9]+[fh]?|(?:0|[1-9][0-9]*)[fh])/y;
const DEC_INT = /(?:0|[1-9][0-9]*)[iu]?/y;
const IDENT_TAIL = /[\p{XID_Continue}]/uy;

const isBlank = (c: number) =>
  c === 32 || (c >= 9 && c <= 13) || c === 0x85 || c === 0x200e || c === 0x200f || c === 0x2028 || c === 0x2029;

/** Splits WGSL source into tokens (comments and blankspace dropped), with template brackets marked. */
export function tokenize(text: string, map: SourceMap = new SourceMap(text)): Token[] {
  if (text.length > WGSL_LIMITS.sourceLength)
    throw map.error(
      'limit',
      `WGSL source is ${text.length} characters, over the ${WGSL_LIMITS.sourceLength} limit; split the module`,
      0,
    );
  const out: Token[] = [];
  let i = 0;
  const sticky = (re: RegExp) => {
    re.lastIndex = i;
    const m = re.exec(text);
    return m ? m[0] : undefined;
  };
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (isBlank(c)) {
      i++;
      continue;
    }
    if (c === 47 /* / */) {
      const n = text.charCodeAt(i + 1);
      if (n === 47) {
        i += 2;
        while (i < text.length) {
          const d = text.charCodeAt(i);
          if (d === 10 || d === 11 || d === 12 || d === 13 || d === 0x85 || d === 0x2028 || d === 0x2029) break;
          i++;
        }
        continue;
      }
      if (n === 42) {
        const open = i;
        let depth = 1;
        i += 2;
        while (i < text.length && depth) {
          if (text.charCodeAt(i) === 47 && text.charCodeAt(i + 1) === 42) {
            depth++;
            i += 2;
          } else if (text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47) {
            depth--;
            i += 2;
          } else i++;
        }
        if (depth) throw map.error('syntax', 'Block comment is never closed; add */', open);
        continue;
      }
    }
    if ((c >= 48 && c <= 57) || (c === 46 && /[0-9]/.test(text[i + 1] ?? ''))) {
      const isHex = c === 48 && (text[i + 1] === 'x' || text[i + 1] === 'X');
      const float = isHex ? sticky(HEX_FLOAT) : sticky(DEC_FLOAT);
      const int = isHex ? sticky(HEX_INT) : sticky(DEC_INT);
      const value = float && (!int || float.length >= int.length) ? float : int;
      if (!value) throw map.error('syntax', `Malformed number '${text.slice(i, i + 8)}'`, i);
      const end = i + value.length;
      IDENT_TAIL.lastIndex = end;
      if (end < text.length && IDENT_TAIL.test(text))
        throw map.error(
          'syntax',
          `Malformed number '${text.slice(i, end + 1)}': a literal may end only in i, u, f or h, and decimal integers have no leading zero`,
          i,
        );
      out.push({ kind: value === float ? 'float' : 'int', value, start: i, end });
      i = end;
      continue;
    }
    const word = sticky(IDENT);
    if (word) {
      if (word === '_') out.push({ kind: 'punct', value: '_', start: i, end: i + 1 });
      else {
        if (word.startsWith('__'))
          throw map.error(
            'syntax',
            `Identifier '${word}' starts with two underscores, which WGSL reserves; rename it`,
            i,
          );
        if (RESERVED.has(word)) throw map.error('syntax', `'${word}' is a reserved word in WGSL; rename it`, i);
        out.push({ kind: KEYWORDS.has(word) ? 'keyword' : 'ident', value: word, start: i, end: i + word.length });
      }
      i += word.length;
      continue;
    }
    const p = PUNCT.find((s) => text.startsWith(s, i));
    if (!p) {
      const cp = text.codePointAt(i) ?? 0;
      throw map.error(
        'syntax',
        `Unexpected character '${String.fromCodePoint(cp)}' (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`,
        i,
      );
    }
    out.push({ kind: 'punct', value: p, start: i, end: i + p.length });
    i += p.length;
  }
  out.push({ kind: 'eof', value: '', start: text.length, end: text.length });
  discoverTemplates(out);
  return join(out);
}

const isPunct = (t: Token | undefined, v: string) => t?.kind === 'punct' && t.value === v;
const adjacent = (a: Token, b: Token | undefined) => b !== undefined && a.end === b.start;

/**
 * The template-list discovery of the WGSL specification (section 3.9), on tokens: marks each `<` that opens a template
 * list after an identifier, and the `>` that closes it.
 */
function discoverTemplates(tokens: Token[]): void {
  const pending: { token: Token; depth: number }[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Keywords are identifier-shaped too, so `var<storage>` opens a template list.
    if (t.kind === 'ident' || t.kind === 'keyword') {
      const next = tokens[i + 1];
      if (isPunct(next, '<')) {
        const after = tokens[i + 2];
        // `a<<b` and `a<=b` are operators, not template lists.
        if (adjacent(next, after) && (isPunct(after, '<') || isPunct(after, '=') || isPunct(after, '=='))) {
          i += 2;
          continue;
        }
        pending.push({ token: next, depth });
        i++;
      }
      continue;
    }
    if (t.kind !== 'punct') continue;
    switch (t.value) {
      case '>': {
        const top = pending[pending.length - 1];
        if (top && top.depth === depth) {
          pending.pop();
          top.token.template = true;
          t.template = true;
        } else if (adjacent(t, tokens[i + 1]) && (isPunct(tokens[i + 1], '>') || isPunct(tokens[i + 1], '='))) i++;
        break;
      }
      case '(':
      case '[':
        depth++;
        break;
      case ')':
      case ']':
        while (pending.length && pending[pending.length - 1].depth >= depth) pending.pop();
        depth = Math.max(0, depth - 1);
        break;
      case '=':
      case ';':
      case '{':
      case ':':
        depth = 0;
        pending.length = 0;
        break;
      case '&&':
      case '||':
        while (pending.length && pending[pending.length - 1].depth === depth) pending.pop();
        break;
    }
  }
}

/** Merges adjacent non-template `<`, `>` and `=` into `<<`, `>>`, `<=`, `>=`, `<<=` and `>>=`. */
function join(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct' && (t.value === '<' || t.value === '>') && !t.template) {
      const next = tokens[i + 1];
      if (adjacent(t, next) && next.kind === 'punct' && !next.template) {
        if (next.value === t.value) {
          const third = tokens[i + 2];
          if (adjacent(next, third) && isPunct(third, '=')) {
            out.push({ kind: 'punct', value: `${t.value}${t.value}=`, start: t.start, end: third.end });
            i += 2;
          } else {
            out.push({ kind: 'punct', value: `${t.value}${t.value}`, start: t.start, end: next.end });
            i++;
          }
          continue;
        }
        if (next.value === '=' || next.value === '==') {
          out.push({ kind: 'punct', value: `${t.value}=`, start: t.start, end: t.start + 2 });
          if (next.value === '==') out.push({ kind: 'punct', value: '=', start: next.start + 1, end: next.end });
          i++;
          continue;
        }
      }
    }
    out.push(t);
  }
  return out;
}
