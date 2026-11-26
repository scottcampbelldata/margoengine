// Looks a public name up in the committed API reports (api/*.api.md), so a document that lists Margo names fails
// when one of them is renamed or removed (tests/from-threejs-snippets.test.js). `api:check` keeps the reports equal
// to the built packages.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const KINDS = 'class|interface|function|const|type|namespace|enum';
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The report file of a package specifier: `@margoengine/controls/orbit` is `api/controls.orbit.api.md`. */
export const reportFile = (root, specifier) =>
  join(root, 'api', `${specifier.replace(/^@margoengine\//, '').replaceAll('/', '.')}.api.md`);

/** Every top-level declaration of `name` in a report: [{ exported, kind, head, body }]. */
function declarations(text, name) {
  const lines = text.split(/\r?\n/),
    start = new RegExp(`^(export )?(?:declare )?(?:abstract )?(${KINDS}) ${escape(name)}(?![\\w$])`),
    found = [];
  for (let i = 0; i < lines.length; i++) {
    const match = start.exec(lines[i]);
    if (!match) continue;
    let end = i;
    // A block ends at its closing brace in column 0; a one-line declaration has none.
    if (/[{(<[|&=]\s*$/.test(lines[i])) while (end + 1 < lines.length && !/^[})\]]/.test(lines[end + 1])) end++;
    found.push({
      exported: Boolean(match[1]),
      kind: match[2],
      head: lines[i],
      body: lines.slice(i + 1, end + 1),
    });
  }
  return found;
}

/** The specifier a report imports or re-exports `name` from, if it does. */
function importedFrom(text, name) {
  for (const [, names, from] of text.matchAll(
    /^(?:import|export)(?: type)? \{([^}]*)\} from "(@margoengine\/[^"]+)";/gm,
  ))
    if (
      names.split(',').some(
        (part) =>
          part
            .trim()
            .split(/\s+as\s+/)
            .at(-1) === name,
      )
    )
      return from;
  return undefined;
}

/** True when a declaration (or one it extends or aliases) has the public member `member`. */
function hasMember(root, specifier, name, member, seen) {
  const key = `${specifier}#${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const file = reportFile(root, specifier);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const own = declarations(text, name);
  if (!own.length) {
    const from = importedFrom(text, name);
    return from ? hasMember(root, from, name, member, seen) : false;
  }
  const line = new RegExp(
    `^\\s+(?:(?:static|readonly|abstract|get|set|declare|export|const|function|let) )*${escape(member)}[?!]?\\s*[(:<=;,]`,
  );
  return own.some(({ head, body }) => {
    if (body.some((text) => line.test(text))) return true;
    // `extends A, B<C>` and `type X = Y;` pass the question on.
    const bases = [
      ...(/\bextends ([^{]+)\{/
        .exec(head)?.[1]
        .replace(/<[^<>]*(?:<[^<>]*>)?[^<>]*>/g, '')
        .split(',') ?? []),
      /^export type \w+ = (\w+);/.exec(head)?.[1] ?? '',
    ]
      .map((base) => base.trim())
      .filter((base) => /^\w+$/.test(base));
    return bases.some((base) => hasMember(root, specifier, base, member, seen));
  });
}

/**
 * Why `symbol` (`Name` or `Name.member`) is not a public name of `specifier`, or `undefined` when it is one.
 * `root` is the repository root.
 */
export function missingName(root, specifier, symbol) {
  const file = reportFile(root, specifier);
  if (!existsSync(file)) return `${specifier} has no API report`;
  const text = readFileSync(file, 'utf8');
  const [name, member, ...rest] = symbol.split('.');
  if (rest.length) return `${symbol} is not Name or Name.member`;
  const renamed = new RegExp(`^export \\{ (\\w+) as ${escape(name)} \\};`, 'm').exec(text)?.[1];
  const local = renamed ?? name;
  const own = declarations(text, local);
  const exported =
    renamed !== undefined ||
    own.some((declaration) => declaration.exported) ||
    new RegExp(`^export (?:type )?\\{[^}]*\\b${escape(name)}\\b[^}]*\\}`, 'm').test(text);
  if (!exported) return `${specifier} does not export ${name}`;
  if (member && !hasMember(root, specifier, local, member, new Set()))
    return `${name} of ${specifier} has no ${member}`;
  return undefined;
}
