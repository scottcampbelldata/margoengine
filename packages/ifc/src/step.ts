// ISO 10303-21 (STEP physical file) syntax check, run before web-ifc sees the bytes. web-ifc 0.0.78 loops forever on
// some malformed parameter lists (two values without a comma: `#11 x`, `.T.x`, `'a'b`, `$x`; or `#-1`, `#1e9`), so
// every statement must parse first: `KEYWORD;`, `KEYWORD(params);`, `#n=KEYWORD(params);`, `#n=(A(..) B(..));`.
// Linear, byte-level, no allocation per token. Returns null or the reason the file is malformed.

const LIST_DEPTH = 64;
const space = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const digit = (c: number) => c >= 48 && c <= 57;
const letter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const word = (c: number) => letter(c) || digit(c) || c === 45;

// Token kinds.
const END = 0,
  WORD = 1,
  REF = 2,
  ATOM = 3,
  OPEN = 4,
  CLOSE = 5,
  COMMA = 6,
  SEMI = 7,
  EQUAL = 8;

export function checkStep(data: Uint8Array): string | null {
  const n = data.length;
  let p = 0,
    kind: number = END,
    at = 0;
  /** Reads the next token into `kind` (and `at`, its offset); returns false with p at the bad byte on a lexical error. */
  const next = (): boolean => {
    for (;;) {
      while (p < n && space(data[p])) p++;
      if (data[p] === 47 && data[p + 1] === 42) {
        let q = data.indexOf(42, p + 2);
        while (q >= 0 && data[q + 1] !== 47) q = data.indexOf(42, q + 1);
        if (q < 0) return false;
        p = q + 2;
        continue;
      }
      break;
    }
    at = p;
    if (p >= n) {
      kind = END;
      return true;
    }
    const c = data[p];
    if (c === 40) (kind = OPEN), p++;
    else if (c === 41) (kind = CLOSE), p++;
    else if (c === 44) (kind = COMMA), p++;
    else if (c === 59) (kind = SEMI), p++;
    else if (c === 61) (kind = EQUAL), p++;
    else if (c === 36 || c === 42) (kind = ATOM), p++;
    else if (c === 35) {
      // #123: an instance name.
      if (!digit(data[++p])) return false;
      while (digit(data[p])) p++;
      kind = REF;
    } else if (c === 39) {
      // 'text' with '' for a quote; any other byte (UTF-8 included) is accepted inside.
      for (p++; ; p++) {
        if (p >= n) return false;
        if (data[p] === 39) {
          if (data[p + 1] !== 39) break;
          p++;
        }
      }
      p++;
      kind = ATOM;
    } else if (c === 34) {
      // "0FF": binary.
      for (p++; p < n && data[p] !== 34; p++)
        if (!digit(data[p]) && !((data[p] | 32) >= 97 && (data[p] | 32) <= 102)) return false;
      if (p++ >= n) return false;
      kind = ATOM;
    } else if (c === 46) {
      // .ENUM.
      if (!letter(data[++p])) return false;
      while (letter(data[p]) || digit(data[p])) p++;
      if (data[p++] !== 46) return false;
      kind = ATOM;
    } else if (digit(c) || c === 43 || c === 45) {
      // 12, -1.5, 1.E-05, 0.
      if (!digit(c)) p++;
      if (!digit(data[p])) return false;
      while (digit(data[p])) p++;
      if (data[p] === 46) while (digit(data[++p]));
      if (data[p] === 69 || data[p] === 101) {
        if (data[p + 1] === 43 || data[p + 1] === 45) p++;
        if (!digit(data[++p])) return false;
        while (digit(data[p])) p++;
      }
      kind = ATOM;
    } else if (letter(c) || c === 33) {
      for (p++; word(data[p]); p++);
      kind = WORD;
    } else return false;
    // Values and words end at a delimiter: `#1e999`, `1.5x`, `.T.x` and `'a'b` are not two tokens.
    const d = data[p];
    if (kind !== OPEN && kind !== CLOSE && kind !== COMMA && kind !== SEMI && kind !== EQUAL)
      if (p < n && !space(d) && d !== 40 && d !== 41 && d !== 44 && d !== 59 && d !== 61 && d !== 47) return false;
    return true;
  };
  // Read through a call: TypeScript would otherwise keep `kind` narrowed across next().
  const k = (): number => kind;
  const bad = (what: string) => `${what} at byte ${at}`;
  /** Parses `(params)` after its OPEN; `complex` lists hold `WORD(params)` records separated by spaces. */
  const list = (complex: boolean): string | null => {
    // Stack of open lists: 1 = parameter list, 2 = complex record list.
    const stack: number[] = [complex ? 2 : 1];
    let expectValue = true,
      first = true;
    while (stack.length) {
      if (!next()) return bad('invalid token');
      const top = stack[stack.length - 1];
      if (top === 2) {
        if (k() === CLOSE) {
          stack.pop();
          expectValue = false;
          first = false;
          continue;
        }
        if (k() !== WORD || !next() || k() !== OPEN) return bad('expected a record in a complex entity');
        if (stack.push(1) > LIST_DEPTH) return bad('lists nest too deeply');
        expectValue = true;
        first = true;
        continue;
      }
      if (expectValue) {
        if (k() === CLOSE && first) {
          stack.pop();
          expectValue = false;
          first = false;
          continue;
        }
        if (k() === ATOM || k() === REF) expectValue = false;
        else if (k() === OPEN) {
          if (stack.push(1) > LIST_DEPTH) return bad('lists nest too deeply');
          first = true;
          continue;
        } else if (k() === WORD) {
          if (!next() || k() !== OPEN) return bad('expected ( after a typed parameter');
          if (stack.push(1) > LIST_DEPTH) return bad('lists nest too deeply');
          first = true;
          continue;
        } else return bad('expected a parameter');
        first = false;
      } else if (k() === COMMA) expectValue = true;
      else if (k() === CLOSE) {
        stack.pop();
        expectValue = false;
        first = false;
      } else return bad('expected , or ) between parameters');
    }
    return null;
  };
  for (;;) {
    if (!next()) return bad('invalid token');
    if (k() === END) return null;
    let error: string | null = null;
    if (k() === REF) {
      if (!next() || k() !== EQUAL) return bad('expected = after an instance name');
      if (!next()) return bad('invalid token');
      if (k() === OPEN) error = list(true);
      else if (k() === WORD) {
        if (!next() || k() !== OPEN) return bad('expected ( after an entity name');
        error = list(false);
      } else return bad('expected an entity after =');
    } else if (k() === WORD) {
      if (!next()) return bad('invalid token');
      if (k() === OPEN) error = list(false);
      else if (k() === SEMI) continue;
      else return bad('expected ( or ; after a keyword');
    } else return bad('expected a statement');
    if (error) return error;
    if (!next() || k() !== SEMI) return bad('expected ; after a statement');
  }
}
