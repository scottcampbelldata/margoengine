import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseApiReportArguments(arguments_) {
  let update = false;
  let packageSelector;
  let entrySelector;

  for (const argument of arguments_) {
    if (argument === '--update') update = true;
    else if (argument.startsWith('--package=')) packageSelector = value(argument, '--package=');
    else if (argument.startsWith('--entry=')) entrySelector = value(argument, '--entry=');
    else
      throw new RangeError(
        `Unknown API report argument ${argument}; use --update, --package=<name>, or --entry=<subpath>`,
      );
  }

  if (entrySelector && !packageSelector)
    throw new RangeError('--entry requires --package so an entry can never expand to a repository-wide update');

  return { update, packageSelector, entrySelector };
}

export function packageMatchesApiReportScope(packageSelector, directory, packageName) {
  return !packageSelector || packageSelector === directory || packageSelector === packageName;
}

function value(argument, prefix) {
  const result = argument.slice(prefix.length).trim();
  if (!result) throw new RangeError(`${prefix.slice(0, -1)} requires a value`);
  return result;
}

export function mergeScopedApiSurface(current, replacement) {
  const lines = current.replaceAll('\r\n', '\n').split('\n');
  if (lines.some((line) => /^(?:<{7}|>{7})(?:\s|$)/.test(line)))
    throw new Error(
      'docs/api-surface.md contains an unresolved merge boundary; run npm run api:update to regenerate the complete summary before a scoped update',
    );
  const summaryIndex = lines.findIndex((line) => /\d+ packages, \d+ entries, \d+ exported names\./.test(line));
  if (summaryIndex < 0) throw new Error('docs/api-surface.md has no package summary line');

  const summary = lines[summaryIndex].match(/^(\d+) packages, (\d+) entries, (\d+) exported names\.$/);
  if (!summary) throw new Error(`Unrecognized API surface summary: ${lines[summaryIndex]}`);

  const headerIndex = lines.indexOf('| Package | Exports per entry | Unexported | `any` | Gzip |');
  if (headerIndex < 0) throw new Error('docs/api-surface.md has no package table');
  const firstRow = headerIndex + 2;
  let endRow = firstRow;
  while (lines[endRow]?.startsWith('| ')) endRow++;

  const prefix = `| ${replacement.packageName} |`;
  const rowIndex = lines.findIndex((line, index) => index >= firstRow && index < endRow && line.startsWith(prefix));
  const previous = rowIndex < 0 ? { entries: 0, exports: 0 } : rowCounts(lines[rowIndex]);

  if (rowIndex >= 0) lines[rowIndex] = replacement.row;
  else {
    const insertAt = lines.findIndex(
      (line, index) => index >= firstRow && index < endRow && packageName(line) > replacement.packageName,
    );
    lines.splice(insertAt < 0 ? endRow : insertAt, 0, replacement.row);
  }

  const packageCount = Number(summary[1]) + (rowIndex < 0 ? 1 : 0);
  const entryCount = Number(summary[2]) - previous.entries + replacement.entries;
  const exportCount = Number(summary[3]) - previous.exports + replacement.exports;
  lines[summaryIndex] = `${packageCount} packages, ${entryCount} entries, ${exportCount} exported names.`;
  return lines.join('\n');
}

/**
 * `ours` docs/api-surface.md with the rows a branch changed (`theirs` against `base`) merged in entry by entry, the
 * totals line following the rows. scripts/rebase-main.mjs uses it in place of an API report run (KB-REBASE-SLOW1).
 */
export function mergeApiSurfaceRows(base, ours, theirs) {
  const rows = (text) =>
    new Map(
      text
        .replaceAll('\r\n', '\n')
        .split('\n')
        .filter((line) => /^\| (?:@margoengine\/|margoengine )/.test(line))
        .map((line) => [packageName(line), line]),
    );
  const [b, o, t] = [base, ours, theirs].map(rows);
  let merged = ours.replaceAll('\r\n', '\n');
  for (const name of new Set([...b.keys(), ...t.keys()])) {
    if (b.get(name) === t.get(name)) continue;
    if (!t.has(name)) throw new Error(`${API_SURFACE}: the branch removed the ${name} row; run npm run api:update`);
    const row = o.has(name) ? mergeRow(b.get(name), o.get(name), t.get(name)) : t.get(name);
    merged = mergeScopedApiSurface(merged, {
      packageName: name,
      row,
      ...rowCounts(row),
    });
  }
  return merged;
}

/** One package row: the branch's entry changes applied to `ours`, its count changes added, a Gzip cell it set kept. */
function mergeRow(base = '||||||', ours, theirs) {
  const [b, o, t] = [base, ours, theirs].map((row) => row.split('|'));
  const entries = (cell) => new Map([...cell.matchAll(/(`[^`]+`)\s+(\d+)/g)].map((match) => [match[1], match[2]]));
  const [before, mine, branch] = [b, o, t].map((cells) => entries(cells[2]));
  const list = [...mine].filter(([entry]) => branch.has(entry) || !before.has(entry));
  const order = [...branch.keys()];
  for (const [index, entry] of order.entries()) {
    if (branch.get(entry) === before.get(entry)) continue;
    const held = (name) => list.findIndex(([listed]) => listed === name);
    if (held(entry) >= 0) list[held(entry)] = [entry, branch.get(entry)];
    else {
      // Where the branch has it: before the first of its following entries that the merged row holds.
      const next = order
        .slice(index + 1)
        .map(held)
        .find((position) => position >= 0);
      list.splice(next ?? list.length, 0, [entry, branch.get(entry)]);
    }
  }
  const sum = (column) => Number(o[column]) + Number(t[column]) - Number(b[column] ?? 0) || '';
  o[2] = ` ${list.map(([entry, count]) => `${entry} ${count}`).join(', ')} `;
  o[3] = ` ${sum(3)} `;
  o[4] = ` ${sum(4)} `;
  if (t[5] !== b[5]) o[5] = t[5];
  return o.join('|');
}

// The Gzip column of docs/api-surface.md is the root entry's min+gzip bytes from the committed entry-sizes.json, not a
// figure of its own. Bug (2026-11-10): a scoped report kept every old Gzip cell (its own row's too) and entry-sizes.mjs
// rewrote the record without touching the column, so a lane that measured sizes after its api:check, or checked one
// package, pushed stale cells (72 of them in f235e21f0) and main's own api:check failed. Now both write the column from
// the record, the same way the full report does.
export const ENTRY_SIZES = 'examples/package-benchmarks/results/entry-sizes.json';
export const API_SURFACE = 'docs/api-surface.md';

/** A package row's Gzip cell: its root entry's gzip bytes in `sizes` (entry-sizes.json), or empty. */
export function gzipCell(sizes, packageName) {
  const gzip = sizes?.packages?.[packageName]?.['.']?.gzip;
  return gzip ? gzip.toLocaleString('en-US') : '';
}

/** docs/api-surface.md text with every package row's Gzip cell set from `sizes`; everything else (line ends too) kept. */
export function refreshSurfaceGzip(text, sizes) {
  return text
    .split('\n')
    .map((line) => {
      if (!/^\| (?:@margoengine\/[^|]+|margoengine) \|/.test(line)) return line;
      const cells = line.split('|');
      if (cells.length !== 7) throw new Error(`Unrecognized API surface package row: ${line}`);
      cells[5] = ` ${gzipCell(sizes, cells[1].trim())} `;
      return cells.join('|');
    })
    .join('\n');
}

/** Rewrites the Gzip column of `root`/docs/api-surface.md from `root`'s entry-sizes.json; no write when it matches. */
export function refreshApiSurfaceGzip(root) {
  const surfacePath = join(root, API_SURFACE),
    sizesPath = join(root, ENTRY_SIZES);
  if (!existsSync(surfacePath) || !existsSync(sizesPath)) return;
  const text = readFileSync(surfacePath, 'utf8'),
    refreshed = refreshSurfaceGzip(text, JSON.parse(readFileSync(sizesPath, 'utf8')));
  if (refreshed !== text) writeFileSync(surfacePath, refreshed);
}

function rowCounts(row) {
  const exportsCell = row.split('|')[2] ?? '';
  const counts = [...exportsCell.matchAll(/`[^`]+`\s+(\d+)/g)].map((match) => Number(match[1]));
  if (!counts.length) throw new Error(`Unrecognized API surface package row: ${row}`);
  return {
    entries: counts.length,
    exports: counts.reduce((sum, count) => sum + count, 0),
  };
}

function packageName(row) {
  return row.split('|')[1]?.trim() ?? '';
}

/**
 * The workspace packages whose node_modules link resolves outside this checkout, as `{ name, dir, target }`.
 * A worktree that borrows another checkout's node_modules (one junction to the main checkout's folder) resolves every
 * `@margoengine/*` import to that checkout's packages: the checker read the other checkout's declarations, no file
 * matched a package of this one, and every cross-package re-export came out as `from "undefined"` with its import lines
 * gone, so api:check failed on 15 reports nobody changed (KB-API-FOREIGN1). `packages` holds `{ name, dir }` with `dir`
 * the folder under packages/; a package with no link (not installed) is not listed.
 */
export function foreignWorkspaceLinks(root, packages) {
  const real = (path) => {
    const p = realpathSync.native(path).replaceAll('\\', '/');
    return process.platform === 'win32' ? p.toLowerCase() : p;
  };
  const foreign = [];
  for (const { name, dir } of packages) {
    const link = join(root, 'node_modules', ...name.split('/'));
    if (!existsSync(link)) continue;
    const target = realpathSync.native(link);
    if (real(link) !== real(join(root, 'packages', dir))) foreign.push({ name, dir, target });
  }
  return foreign;
}

// The package a module specifier names: `@scope/name` or `name`, without its subpath.
const packageOf = (specifier) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

/**
 * Map of package directory -> the package names its sources augment with `declare module '@margoengine/...'` (scene
 * augments core). Read with `git grep` over packages/<dir>/src, untracked files included: reading every source file
 * from Node took over a minute on a loaded laptop, the index lookup about ten seconds.
 */
export function moduleAugmentations(root) {
  let out;
  try {
    out = execFileSync(
      'git',
      // POSIX classes, not \s: Git for Windows drops a backslash from its arguments.
      [
        'grep',
        '-I',
        '--untracked',
        '-E',
        `^[[:space:]]*declare[[:space:]]+module[[:space:]]+['"]@margoengine/`,
        '--',
        'packages/*/src/**',
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 },
    );
  } catch (error) {
    if (error.status === 1) return new Map(); // git grep exits 1 when nothing matches
    throw error;
  }
  const augments = new Map();
  for (const line of out.split('\n')) {
    const match = line.match(/^packages\/([^/]+)\/[^:]*:\s*declare\s+module\s+['"]([^'"]+)['"]/);
    if (!match) continue;
    if (!augments.has(match[1])) augments.set(match[1], new Set());
    augments.get(match[1]).add(packageOf(match[2]));
  }
  return augments;
}

/**
 * The package directories a scoped API report loads and keeps current (KB-TOOL-APISCOPE1): the selected one, the
 * workspace packages it imports (dependencies and peerDependencies, followed transitively; a published declaration can
 * import nothing else, and api-report.js refuses one that does), and every package whose sources augment one of those
 * with `declare module`, with what that package imports in turn. No other package's declarations can reach the
 * selected one's symbols, so a program over these reports it as the full program does. `manifests`: Map of directory
 * -> parsed package.json; `augments`: what moduleAugmentations returns.
 */
export function apiReportScope(selected, manifests, augments = new Map()) {
  const byName = new Map([...manifests].map(([dir, manifest]) => [manifest.name, dir]));
  const scope = new Set(),
    wanted = [selected];
  while (wanted.length) {
    const dir = wanted.pop();
    if (!scope.has(dir)) {
      scope.add(dir);
      const { dependencies, peerDependencies } = manifests.get(dir);
      for (const name of Object.keys({ ...dependencies, ...peerDependencies }))
        if (byName.has(name)) wanted.push(byName.get(name));
    }
    if (!wanted.length)
      for (const [other, targets] of augments)
        if (!scope.has(other) && manifests.has(other) && [...targets].some((name) => scope.has(byName.get(name))))
          wanted.push(other);
  }
  return scope;
}
