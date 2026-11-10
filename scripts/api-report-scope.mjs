import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  return { entries: counts.length, exports: counts.reduce((sum, count) => sum + count, 0) };
}

function packageName(row) {
  return row.split('|')[1]?.trim() ?? '';
}
