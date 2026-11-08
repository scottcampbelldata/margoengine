// Reads the whole message argument of a `throw new Error(...)` style call, for the hygiene error-convention gate.
// The message may be a plain string, a template literal with `${...}` substitutions (which may hold strings and
// templates of their own), or literals joined by `+` around variables and calls. The fix sentence often comes after
// the variable ("bad value ${x}; pass a number"), so the checker must read every literal part, not only the prefix.

/** Words and punctuation that mean a message tells the caller how to fix the problem. */
export const FIX =
  /;|\b(must|needs?|expects?|expected|use|call|pass|set|give|create|run|requires?|only|at (most|least)|between|install|enable|add|load|remove|provide|choose|one of|instead|before|after|try|check|should|wait|await|reduce|increase|split|keep|make|within|up to|no more than)\b/i;

const OPEN = '([{';
const CLOSE = ')]}';

/**
 * Scan from `start` (just after a quote or backtick) to its closing quote. Pushes the literal text parts and returns
 * the index after the closing quote. Template substitutions are skipped over, but any string they contain still
 * counts as message text.
 */
function readString(text, start, quote, parts) {
  let i = start;
  let chunk = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      chunk += text.slice(i, i + 2);
      i += 2;
    } else if (c === quote) {
      parts.push(chunk);
      return i + 1;
    } else if (quote === '`' && c === '$' && text[i + 1] === '{') {
      parts.push(chunk);
      chunk = '';
      i = readExpression(text, i + 2, parts, '}');
    } else {
      chunk += c;
      i++;
    }
  }
  parts.push(chunk);
  return i;
}

/**
 * Scan an expression up to the closing `terminator` at depth 0 (`}` for a substitution; for `)` also a top-level `,`).
 * Collects the top-level string literals. Returns the index after the terminator.
 */
function readExpression(text, start, parts, terminator) {
  let i = start;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      // Only strings joined at the top level of the argument are message text; strings inside a substitution or a
      // call's arguments (`join('; ')`) are code, not words said to the caller.
      i = readString(text, i + 1, c, depth === 0 && terminator === ')' ? parts : []);
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (depth === 0 && (c === terminator || (terminator === ')' && c === ','))) return i + 1;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      if (depth === 0) return i + 1;
      depth--;
    }
    i++;
  }
  return i;
}

/**
 * The literal parts of the message argument that starts at `start` (the opening quote of its first literal), joined
 * with a space where a variable or call sat between them.
 * @param {string} text Source text.
 * @param {number} start Index of the message's first quote.
 */
export function messageText(text, start) {
  const parts = [];
  readExpression(text, start, parts, ')');
  return parts.join(' ');
}

/**
 * Count throws in `text` whose literal message names no fix. A `MargoError` or `margoError` call has its code literal
 * first; a message that is only a variable is not counted (nothing to read).
 * @param {string} text Source text.
 */
export function countNoFix(text) {
  let noFix = 0;
  for (const m of text.matchAll(
    /\bthrow (?:new (Error|TypeError|RangeError|MargoError)|(margoError))\(\s*(?:(['"`])[^'"`]*\3\s*,\s*)?(?=(['"`]))/g,
  )) {
    if ((m[1] === 'MargoError' || m[2]) && !m[3]) continue; // a code literal comes first; message is a variable
    if (!FIX.test(messageText(text, m.index + m[0].length))) noFix++;
  }
  return noFix;
}

/**
 * Count throws in `text` that send their fix to a help entry the site does not have: fault(code, message[, anchor]),
 * typeError(message, anchor) and rangeError(message, anchor) from packages/shared/errors.js. A call with no anchor, or
 * an anchor missing from `help`, counts.
 * @param {string} text Source text.
 * @param {Set<string>} help The ids of the entries site/errors.html has.
 */
export function countMissingHelp(text, help) {
  let missing = 0;
  // The arguments are read by the same string-aware reader as the message, so a ")" or ";" inside the message text
  // does not end the call (a regex up to the first ");" once lost the anchor of `'size (in m); pass a number'`).
  const literal = (arg, word) => new RegExp(`^'(${word})'$`).exec(arg.trim())?.[1];
  for (const m of text.matchAll(/\bthrow (fault|typeError|rangeError)\(/g)) {
    const args = callArguments(text, m.index + m[0].length).filter((arg) => arg.trim());
    let anchor;
    if (m[1] === 'fault') {
      const code = literal(args[0] ?? '', '\\w+');
      if (!code) continue; // the code is not a literal: nothing to look up
      anchor = (args.length > 2 && literal(args[args.length - 1], '[\\w-]+')) || code;
    } else anchor = args.length > 1 ? literal(args[args.length - 1], '[\\w-]+') : undefined;
    if (!help.has(anchor)) missing++;
  }
  return missing;
}

/**
 * The source text of each top-level argument of the call whose arguments start at `start` (just after its `(`).
 * Strings, templates, comments and brackets are stepped over, so commas and parentheses inside them do not split.
 * @param {string} text Source text.
 * @param {number} start Index just after the call's opening parenthesis.
 */
function callArguments(text, start) {
  const args = [];
  let i = start,
    from = start,
    depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') i = readString(text, i + 1, c, []);
    else if (c === '/' && text[i + 1] === '/') while (i < text.length && text[i] !== '\n') i++;
    else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
    } else if (depth === 0 && (c === ',' || c === ')')) {
      args.push(text.slice(from, i));
      if (c === ')') return args;
      from = ++i;
    } else {
      if (OPEN.includes(c)) depth++;
      else if (CLOSE.includes(c)) depth--;
      i++;
    }
  }
  args.push(text.slice(from, i));
  return args;
}
