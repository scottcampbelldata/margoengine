// Compacts C# source for embedding: drops //, /* */ and /// comments, collapses whitespace to the single spaces the
// grammar needs, and keeps string, char and verbatim @"" literals byte for byte. Preprocessor lines (#if, #pragma ...)
// stay on lines of their own. Interpolated strings ($"...") are rejected rather than parsed.

const word = /[A-Za-z0-9_@$]/;
// Two of these written together can form a different token (a - -b, a + +b, x / /y, a < <b ...).
const joins = /[-+*/%<>=!&|^?:.]/;

/**
 * Compact C# text. Deterministic: the same input always gives the same output.
 * @param {string} text C# source with LF line endings.
 * @returns {string} The compacted source, ending in one newline.
 * @throws {TypeError} For an interpolated string, an unterminated literal or comment, or a non-string input.
 */
export function compactCSharp(text) {
  if (typeof text !== 'string') throw new TypeError('compactCSharp needs C# source text');
  let out = '';
  // Whitespace or a comment was skipped since the last emitted token.
  let gap = false;
  let lineStart = true;
  const emit = (token) => {
    if (gap && out && !out.endsWith('\n')) {
      const before = out[out.length - 1],
        after = token[0];
      if ((word.test(before) && word.test(after)) || (joins.test(before) && joins.test(after))) out += ' ';
    }
    out += token;
    gap = false;
  };
  const fail = (what, at) => {
    throw new TypeError(`C# ${what} at offset ${at}; fix the support source before generating`);
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '\n') {
      lineStart = true;
      gap = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      gap = true;
      i++;
      continue;
    }
    if (lineStart && c === '#') {
      // A directive owns its whole line; a trailing // comment is dropped.
      let end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
      let line = text.slice(i, end);
      const comment = line.indexOf('//');
      if (comment >= 0) line = line.slice(0, comment);
      if (out && !out.endsWith('\n')) out += '\n';
      out += `${line.trimEnd()}\n`;
      gap = false;
      i = end;
      continue;
    }
    lineStart = false;
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      gap = true;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated block comment', i);
      i = end + 2;
      gap = true;
      continue;
    }
    if ((c === '$' && (text[i + 1] === '"' || text[i + 1] === '@')) || (c === '@' && text[i + 1] === '$'))
      fail('interpolated string is not supported by the compactor', i);
    if (c === '@' && text[i + 1] === '"') {
      // Verbatim string: "" is an escaped quote; backslashes and newlines are literal.
      let j = i + 2;
      for (;;) {
        if (j >= text.length) fail('unterminated verbatim string', i);
        if (text[j] === '"') {
          if (text[j + 1] !== '"') break;
          j += 2;
        } else j++;
      }
      emit(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\n') fail('unterminated literal', i);
        j += text[j] === '\\' ? 2 : 1;
      }
      if (j >= text.length) fail('unterminated literal', i);
      emit(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    let j = i + 1;
    if (word.test(c)) while (j < text.length && word.test(text[j])) j++;
    emit(text.slice(i, j));
    i = j;
  }
  return out.endsWith('\n') ? out : `${out}\n`;
}
