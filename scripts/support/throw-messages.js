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
