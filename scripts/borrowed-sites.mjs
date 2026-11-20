// Finds every public member that can hold a caller's GPU object (docs/conventions.md, "Borrowed GPU objects"): a
// property in an api/*.api.md report whose type admits GPUTexture, GPUTextureView, GPUSampler or GPUBuffer outside a
// function type, directly or through a type alias of the same package. Keys are `<package>:<Type>.<member>`.
// tests/borrowed-gpu.test.js holds the result against scripts/borrowed-registry.json.
// `node scripts/borrowed-sites.mjs` prints the members the registry does not list and the rows it lists that are gone.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GPU = ['GPUTexture', 'GPUTextureView', 'GPUSampler', 'GPUBuffer'];

// A head opens a scope: an interface or class holds members, a namespace holds declarations, an enum holds values.
const HEAD = /^(?:export )?(?:declare )?(?:abstract )?(interface|class|namespace|enum) (\w+)\b.*\{$/;
// A line that starts a declaration. One the scan cannot place throws, since reading past it would swallow, without a
// word, every declaration after it (a head with a type parameter default once hid three sites).
const DECLARATION =
  /^(?:export )?(?:declare )?(?:abstract )?(?:const )?(interface|class|namespace|module|enum|type|function) /;

/** Splits a report into its declarations and members, each on one line, with the type or class that holds it. */
function statements(text, file = 'report') {
  const out = [],
    scopes = [];
  let buffer = '',
    depth = 0,
    quote = null,
    fenced = false;
  const lines = text.split('\n');
  const fail = (n, why) => {
    throw new Error(`${file}:${n}: ${why}; scripts/borrowed-sites.mjs cannot read it, so it would skip what follows`);
  };
  for (let n = 1; n <= lines.length; n++) {
    const line = lines[n - 1].trim();
    if (quote) {
      // Inside a template literal that spans lines (a shader source constant): text, not declarations.
      buffer += `\n${line}`;
      [depth, quote] = nesting(line, depth, quote);
    } else {
      if (line.startsWith('```')) {
        if (fenced && buffer) fail(n, `the fence closes inside "${buffer.slice(0, 60)}"`);
        if (fenced && scopes.length) fail(n, `the fence closes inside ${scopes.at(-1).name}`);
        fenced = line === '```ts';
        continue;
      }
      // A comment line is no part of a statement: kept in the buffer, it once hid the declaration after it.
      if (!fenced || !line || /^(?:\/\/|\/\*|\*)/.test(line)) continue;
      if (!buffer) {
        if (line === '}' || line === '};') {
          if (!scopes.pop()) fail(n, 'a } closes nothing');
          continue;
        }
        if (scopes.at(-1)?.kind === 'enum') continue;
        const head = HEAD.exec(line) ?? /^(?:export )?declare (global) \{$/.exec(line)?.toSpliced(1, 0, 'namespace');
        if (head) {
          scopes.push({ kind: head[1], name: head[2] });
          continue;
        }
        const kind = DECLARATION.exec(line)?.[1];
        if (kind && kind !== 'type' && kind !== 'function') fail(n, `cannot read the head "${line}"`);
      } else if (DECLARATION.test(line)) fail(n, `"${line}" starts before "${buffer.slice(0, 60)}" ends`);
      buffer = buffer ? `${buffer} ${line}` : line;
      [depth, quote] = nesting(line, depth, null);
    }
    if (!quote && depth <= 0 && line.endsWith(';')) {
      const top = scopes.at(-1),
        held = top && (top.kind === 'interface' || top.kind === 'class');
      out.push({ container: held ? scopes.map((scope) => scope.name).join('.') : null, text: buffer });
      buffer = '';
      depth = 0;
    }
  }
  if (buffer || scopes.length || quote) fail(lines.length, 'the report ends inside a declaration');
  return out;
}

/**
 * Bracket depth after a line, and the quote still open at its end (a template literal can span lines). Brackets
 * inside a string literal (a shader source constant) do not count.
 */
function nesting(text, depth, quote) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (`'"\``.includes(c)) quote = c;
    else if ('({[<'.includes(c)) depth++;
    else if (')}]'.includes(c) || (c === '>' && text[i - 1] !== '=')) depth--;
  }
  return [depth, quote];
}

/** Top-level union members of a type, with grouping parentheses opened. */
function members(type) {
  const out = [];
  let depth = 0,
    current = '';
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if ('(<[{'.includes(c)) depth++;
    else if (')]}'.includes(c) || (c === '>' && type[i - 1] !== '=')) depth--;
    if (c === '|' && depth === 0) {
      out.push(current);
      current = '';
    } else current += c;
  }
  out.push(current);
  return out
    .map((part) => part.trim())
    .flatMap((part) => (/^\(.*\)$/.test(part) && !part.includes('=>') ? members(part.slice(1, -1)) : [part]));
}

/**
 * True when `type` admits a plain GPU object: a union member that names one and is not a function type. An object
 * type is read member by member, so one callback among its members (`extend?: (code: string) => string`) neither hides
 * a GPU property beside it nor makes a method's GPU parameter count as held.
 */
function admits(type, names) {
  const word = new RegExp(`\\b(${[...GPU, ...names].join('|')})\\b`);
  return (
    word.test(type) &&
    members(type).some((part) =>
      /^\{.*\}$/.test(part)
        ? fields(part.slice(1, -1)).some((field) => {
            const property = /^(?:readonly )?(?:\w+|\[[^\]]+\])\??: (.*)$/.exec(field);
            return !!property && admits(property[1], names);
          })
        : !part.includes('=>') && word.test(part),
    )
  );
}

/** The members of an object type's body, split at its own semicolons. */
function fields(body) {
  const out = [];
  let depth = 0,
    current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ('(<[{'.includes(c)) depth++;
    else if (')]}'.includes(c) || (c === '>' && body[i - 1] !== '=')) depth--;
    if (c === ';' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += c;
  }
  return [...out, current.trim()].filter(Boolean);
}

/** Every member key under `root` with its declared type. */
export function borrowedSites(root) {
  const dir = join(root, 'api'),
    all = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.api.md'))) {
    const pkg = file.split('.')[0];
    for (const statement of statements(readFileSync(join(dir, file), 'utf8'), `api/${file}`))
      all.push({ pkg, ...statement });
  }
  const aliases = new Map();
  for (let grew = true; grew; ) {
    grew = false;
    for (const { pkg, container, text } of all) {
      const alias = !container && /^(?:export )?type (\w+)(?:<[^=]*>)? = (.*);$/.exec(text);
      if (!alias) continue;
      const names = aliases.get(pkg) ?? aliases.set(pkg, new Set()).get(pkg);
      if (!names.has(alias[1]) && admits(alias[2], [...names])) grew = names.add(alias[1]);
    }
  }
  const sites = new Map();
  for (const { pkg, container, text } of all) {
    if (!container || /^(private|protected|static|get|set) /.test(text)) continue;
    const member = /^(?:readonly )?(\w+|\[[^\]]+\])\??: (.*);$/.exec(text);
    if (member && admits(member[2], [...(aliases.get(pkg) ?? [])]))
      sites.set(`${pkg}:${container}.${member[1]}`, member[2]);
  }
  return sites;
}

/** The registry rows: `{ [key]: { status: 'ruled' | 'exempt' | 'pending', source?, reason? } }`. */
export const readRegistry = (root) =>
  JSON.parse(readFileSync(join(root, 'scripts/borrowed-registry.json'), 'utf8')).sites;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..'),
    sites = borrowedSites(root),
    rows = readRegistry(root);
  for (const [key, type] of sites) if (!rows[key]) console.log(`unlisted ${key}: ${type}`);
  for (const key of Object.keys(rows)) if (!sites.has(key)) console.log(`gone ${key}`);
}
