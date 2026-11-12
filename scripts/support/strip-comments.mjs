// Source text with its comments blanked (newlines kept), for scanners that look for imports and path mentions: a path
// named in a comment is documentation, not a dependency (KB-L4-cma).
//
// A small tokenizer, not a regex: strings, template literals (with `${}` nesting) and regex literals are walked past,
// so a `//` inside a URL string or a pattern stays code.

const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^';

/** @param {string} src */
export function stripComments(src) {
  const n = src.length;
  const stack = []; // brace depth to return to when a `${` of a template literal closes
  let out = '';
  let i = 0;
  let prev = ''; // last significant character
  let depth = 0;
  const blank = (text) => text.replace(/[^\n]/g, ' ');

  // Copy a quoted string starting at `i`.
  const quoted = (q) => {
    let j = i + 1;
    while (j < n && src[j] !== q && !(src[j] === '\n' && q !== '`')) j += src[j] === '\\' ? 2 : 1;
    out += src.slice(i, j + 1);
    i = j + 1;
    prev = q;
  };
  // Copy template text from `from` up to the closing backtick, or up to and including the next `${`.
  const template = (from) => {
    let j = from;
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '$' && src[j + 1] === '{') {
        out += src.slice(i, j + 2);
        i = j + 2;
        stack.push(depth);
        depth = 0;
        prev = '{';
        return;
      } else j++;
    }
    out += src.slice(i, j + 1);
    i = j + 1;
    prev = '`';
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === "'" || c === '"') quoted(c);
    else if (c === '`') template(i + 1);
    else if (c === '/' && (prev === '' || REGEX_AFTER.includes(prev))) {
      // A regex literal: skip to its closing slash, ignoring slashes inside a character class.
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = '/';
    } else if (c === '}' && stack.length && depth === 0) {
      // The end of a template's `${ }`: the template text carries on.
      depth = stack.pop();
      template(i + 1);
      // template() copied from `i`, which is the brace itself.
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c;
      i++;
      if (!/\s/.test(c)) prev = c;
    }
  }
  return out;
}
