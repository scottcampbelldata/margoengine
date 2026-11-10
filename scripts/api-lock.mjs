// Clean-room report comparison. See docs/conventions.md, API lock, for the policy and sources.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isUmbrellaAlias } from './umbrella.mjs';

// Strings (including template literal types) are opaque: their punctuation is not declaration structure.
function tokens(text) {
  const pattern =
    /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[\w$]+|[^\s]/g;
  return [...text.matchAll(pattern)]
    .filter(([value]) => !/^\s|^\/\//.test(value) && !value.startsWith('/*'))
    .map((match) => ({ value: match[0], start: match.index }));
}

const canonical = (text) =>
  tokens(text)
    .map((t) => t.value)
    .join(' ');
export const declarationHash = (text) =>
  createHash('sha1').update(text.replaceAll('\r\n', '\n').trim()).digest('hex').slice(0, 8);

// Split only at the current brace/parenthesis/bracket depth, never inside an object or callback type.
function split(text, container = false, enumBody = false) {
  const ts = tokens(text),
    result = [];
  let start = 0,
    braces = 0,
    parens = 0,
    brackets = 0;
  for (let i = 0; i < ts.length; i++) {
    const v = ts[i].value;
    if (v === '{') braces++;
    if (v === '}') braces--;
    if (v === '(') parens++;
    if (v === ')') parens--;
    if (v === '[') brackets++;
    if (v === ']') brackets--;
    if (braces < 0 || parens < 0 || brackets < 0)
      throw new Error(
        `Malformed API declaration delimiters near ${text.slice(Math.max(0, ts[i].start - 100), ts[i].start + 40)}`,
      );
    const next = ts[i + 1]?.value;
    const blockEnd =
      !container &&
      v === '}' &&
      (!next ||
        [
          'export',
          'declare',
          'abstract',
          'class',
          'interface',
          'namespace',
          'type',
          'const',
          'let',
          'var',
          'function',
          'enum',
          'import',
        ].includes(next));
    if (!braces && !parens && !brackets && (v === ';' || (enumBody && v === ',') || blockEnd)) {
      result.push(text.slice(ts[start].start, ts[i].start + v.length).trim());
      start = i + 1;
    }
  }
  if (braces || parens || brackets) throw new Error('Unclosed API declaration delimiters');
  if (start < ts.length) result.push(text.slice(ts[start].start).trim());
  return result;
}

function memberName(text) {
  const ts = tokens(text).map((t) => t.value);
  while (
    ['public', 'protected', 'static', 'abstract', 'readonly', 'get', 'set', 'export', 'declare'].includes(ts[0]) &&
    !['(', ':', '?', '<', '='].includes(ts[1])
  )
    ts.shift();
  if (ts[0] === '[') return ts.slice(0, ts.indexOf(']') + 1).join(' ');
  return ts[0] === '(' || ts[0] === '<' ? '(call)' : ts[0];
}

function declaration(text) {
  const match = text.match(
    /^(?:(?:export|default|declare|abstract)\s+)*(class|interface|function|type|const|let|var|enum|namespace|global)\b\s*([\w$]+)?/,
  );
  const alias = text.match(/^export\s*\{\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*\}/);
  if (!match && !alias) return undefined;
  const kind = alias ? 'alias' : match[1];
  const name = alias ? (alias[2] ?? alias[1]) : kind === 'global' ? 'global' : match[2];
  if (!name) return undefined;
  const item = {
    name,
    kind,
    text,
    exported: /^export\b/.test(text),
    signature: canonical(text.replace(/^(?:(?:export|declare)\s+)+/, '')),
  };
  if (['class', 'interface', 'enum'].includes(kind)) {
    // Report container bodies start at the first depth-zero opening brace after any generic constraints.
    const ts = tokens(text);
    let angles = 0;
    const open = ts.find((token, i) => {
      if (token.value === '<') angles++;
      if (token.value === '>' && ts[i - 1]?.value !== '=') angles--;
      return token.value === '{' && !angles;
    });
    if (!open) return undefined;
    item.header = canonical(text.slice(0, open.start).replace(/^(?:(?:export|declare)\s+)+/, ''));
    item.members = new Map();
    for (const block of split(text.slice(open.start + 1, text.lastIndexOf('}')), true, kind === 'enum')) {
      const key = memberName(block);
      const group = item.members.get(key) ?? [];
      group.push(block.replace(/,$/, ''));
      item.members.set(key, group);
    }
  }
  return item;
}

/** Parse all TypeScript fences, including the Not exported section. Unrecognised text is never silently dropped. */
export function parseReport(text) {
  const items = new Map(),
    leftover = [];
  const fences = [...text.replaceAll('\r\n', '\n').matchAll(/```ts\n([\s\S]*?)```/g)];
  if (!fences.length) leftover.push('missing TypeScript block');
  for (const [, body] of fences) {
    for (const block of split(body)) {
      if (/^import\b/.test(block)) continue;
      const item = declaration(block);
      if (!item) {
        leftover.push(block);
        continue;
      }
      const key = `${item.kind}:${item.name}`;
      const group = items.get(key) ?? [];
      group.push(item);
      items.set(key, group);
    }
  }
  return { items, leftover };
}

// Only policy-approved relaxations, not general subtype inference. All other edits are conservative breaks.
function relaxationSites(ts) {
  const optional = new Set();
  let braces = 0,
    brackets = 0,
    parens = 0,
    angles = 0,
    open,
    close,
    propertyType = false;
  for (let i = 0; i < ts.length; i++) {
    const v = ts[i];
    if (v === ':' && !braces && !brackets && !angles) {
      if (!parens && open === undefined && !propertyType) optional.add(i);
      if (parens === 1 && open !== undefined && close === undefined) optional.add(i);
      if (!parens) propertyType = true;
    }
    if (v === '(' && !braces && !brackets && !parens && !angles && !propertyType && open === undefined) open = i;
    if (v === '{') braces++;
    if (v === '}') braces--;
    if (v === '[') brackets++;
    if (v === ']') brackets--;
    if (v === '<') angles++;
    if (v === '>' && ts[i - 1] !== '=') angles--;
    if (v === '(') parens++;
    if (v === ')') {
      parens--;
      if (!parens && open !== undefined && close === undefined) close = i;
    }
  }
  return { optional, close };
}

function relaxed(oldText, newText) {
  const a = tokens(oldText).map((t) => t.value),
    b = tokens(newText).map((t) => t.value);
  const sites = relaxationSites(a);
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (b[j] === '?' && a[i] === ':' && b[j + 1] === ':' && sites.optional.has(i)) {
      j++;
      continue;
    }
    // An appended optional parameter must be in an actual parameter list, not a tuple or union type.
    if (
      i === sites.close &&
      a[i] === ')' &&
      (b[j] === ',' || a[i - 1] === '(') &&
      b.slice(0, j).filter((v) => v === '(').length > b.slice(0, j).filter((v) => v === ')').length
    ) {
      const begin = b[j] === ',' ? j + 1 : j;
      let end = begin,
        depth = 0;
      for (; end < b.length; end++) {
        if (['(', '{', '[', '<'].includes(b[end])) depth++;
        if ([')', '}', ']', '>'].includes(b[end]) && b[end - 1] !== '=') {
          if (!depth && b[end] === ')') break;
          depth--;
        }
      }
      const added = b.slice(begin, end).join(' ');
      // Validate each added parameter at its own nesting depth.
      const parameters = splitParameters(added);
      if (parameters.length && parameters.every((p) => /^[\w$]+\s*\?\s*:/.test(p))) {
        j = end;
        continue;
      }
    }
    return false;
  }
  return i === a.length && j === b.length;
}

function splitParameters(text) {
  let depth = 0,
    start = 0;
  const parts = [];
  const ts = tokens(text);
  for (let i = 0; i < ts.length; i++) {
    const v = ts[i].value;
    if (['(', '{', '[', '<'].includes(v)) depth++;
    if ([')', '}', ']', '>'].includes(v) && ts[i - 1]?.value !== '=') depth--;
    if (v === ',' && !depth) {
      parts.push(text.slice(start, ts[i].start).trim());
      start = ts[i].start + 1;
    }
  }
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}

/** Compare by name and kind, then match overloads as a multiset; member order is irrelevant. */
export function classify(oldText, newText) {
  const old = parseReport(oldText),
    next = parseReport(newText);
  if (old.leftover.length || next.leftover.length)
    throw new Error(`Unparsed API report: ${[...old.leftover, ...next.leftover].join('\n')}`);
  const breaking = [],
    additive = [];
  const change = (list, item, symbol, text, type) =>
    list.push({ symbol, kind: item.kind, change: type, was: declarationHash(text) });
  for (const [key, before] of old.items) {
    const after = [...(next.items.get(key) ?? [])];
    // Match identical overloads first, so a changed overload cannot consume a later exact match.
    const pending = before.filter((item) => {
      const index = after.findIndex((n) => n.signature === item.signature && (!item.exported || n.exported));
      if (index < 0) return true;
      after.splice(index, 1);
      return false;
    });
    for (const item of pending) {
      const index = after.findIndex(
        (n) =>
          (!item.exported || n.exported) &&
          (item.members ? n.header === item.header : item.kind === 'function' && relaxed(item.signature, n.signature)),
      );
      if (index < 0) {
        change(breaking, item, item.name, item.text, next.items.has(key) ? 'signature' : 'removed');
        continue;
      }
      const n = after.splice(index, 1)[0];
      if (!item.members) {
        change(additive, item, item.name, item.text, 'signature');
        continue;
      }
      for (const [name, blocks] of item.members) {
        const candidates = [...(n.members.get(name) ?? [])];
        const rest = blocks.filter((block) => {
          const at = candidates.findIndex((c) => canonical(c) === canonical(block));
          if (at < 0) return true;
          candidates.splice(at, 1);
          return false;
        });
        for (const block of rest) {
          const at = candidates.findIndex((c) => relaxed(block, c));
          if (at < 0)
            change(breaking, item, `${item.name}.${name}`, block, n.members.has(name) ? 'signature' : 'removed');
          else {
            candidates.splice(at, 1);
            change(additive, item, `${item.name}.${name}`, block, 'signature');
          }
        }
        for (const block of candidates) change(additive, item, `${item.name}.${name}`, block, 'added');
      }
      for (const [name, blocks] of n.members)
        if (!item.members.has(name))
          for (const block of blocks) change(additive, n, `${n.name}.${name}`, block, 'added');
    }
    for (const item of after) change(additive, item, item.name, item.text, 'added');
  }
  for (const [key, items] of next.items)
    if (!old.items.has(key)) for (const item of items) change(additive, item, item.name, item.text, 'added');
  return { breaking, additive };
}

export function readLock(root) {
  const lock = JSON.parse(readFileSync(join(root, 'api', 'lock.json'), 'utf8'));
  for (const key of ['locked', 'watch', 'internal'])
    if (
      !Array.isArray(lock[key]) ||
      lock[key].some((v) => typeof v !== 'string') ||
      new Set(lock[key]).size !== lock[key].length
    )
      throw new Error(`api/lock.json: ${key} must contain unique names`);
  if (lock.watch.some((name) => lock.locked.includes(name))) throw new Error('api/lock.json: locked and watch overlap');
  return lock;
}

export function allowedBreak(breaks, entry, item) {
  return breaks.some(
    (b) =>
      b.entry === entry &&
      b.symbol === item.symbol &&
      b.was === item.was &&
      b.change === item.change &&
      typeof b.reason === 'string' &&
      b.reason.trim() &&
      /^\d{4}-\d{2}-\d{2}$/.test(b.date) &&
      /^Scott \d{4}-\d{2}-\d{2}$/.test(b.approved),
  );
}

/** New report packages enter watch mode only through api:update, after its breaking-change preflight. */
export function enrollWatch(lock, names) {
  return { ...lock, watch: [...new Set([...lock.watch, ...names.filter((name) => !lock.locked.includes(name))])].sort() };
}

/** The same decision drives check and update; update preflights every entry before writing any report. */
export function assessChange(lock, breaks, packageName, entry, changes, update = false) {
  const locked = lock.locked.includes(packageName),
    watch = lock.watch.includes(packageName);
  const unapproved = changes.breaking.filter((item) => !allowedBreak(breaks, entry, item));
  const lines = changes.breaking.map(
    (item) =>
      `${entry}: ${item.symbol} (${item.kind}) ${item.change}; api/breaks.json: ${JSON.stringify({ entry, ...item, kind: undefined, reason: '<reason>', date: '<YYYY-MM-DD>', approved: 'Scott <YYYY-MM-DD>' })}`,
  );
  if (changes.additive.length) lines.push(`${entry}: additive; run api:update`);
  if (!lines.length) lines.push(`${entry}: compatible report text change; run api:update`);
  return {
    fail: locked ? unapproved.length > 0 || !update : !watch && !update,
    lines: watch ? lines.map((line) => `would fail: ${line}`) : lines,
  };
}

/** Coverage is derived from exports maps, never a hand-maintained list of symbols. */
export function checkCoverage(root, lock, reports) {
  const problems = [],
    expected = new Set();
  for (const dir of readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const path = join(root, 'packages', dir, 'package.json');
    if (lock.internal.includes(`packages/${dir}`)) continue;
    if (!existsSync(path)) {
      problems.push(`packages/${dir}: missing package.json; declare an internal directory in api/lock.json`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (!manifest.exports || !Object.keys(manifest.exports).length) {
      problems.push(`packages/${dir}: missing exports`);
      continue;
    }
    for (const subpath of Object.keys(manifest.exports)) {
      if (isUmbrellaAlias(manifest.name, subpath)) continue;
      const file = `${dir}${subpath === '.' ? '' : '.' + subpath.slice(2).replaceAll('/', '-')}.api.md`;
      expected.add(file);
      const text = reports.get(file);
      if (text === undefined) problems.push(`api/${file}: new entry, no report yet`);
      else if (!/```ts\r?\n/.test(text) || /\/\/ unresolved\b/.test(text))
        problems.push(`api/${file}: missing TypeScript block or unresolved export`);
    }
  }
  for (const file of reports.keys()) if (!expected.has(file)) problems.push(`api/${file}: entry no longer exists`);
  return problems;
}
