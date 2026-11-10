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

  if (rowIndex >= 0) lines[rowIndex] = preserveGzip(lines[rowIndex], replacement.row);
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

function preserveGzip(previousRow, replacementRow) {
  const previous = previousRow.split('|');
  const replacement = replacementRow.split('|');
  if (previous.length !== 7 || replacement.length !== 7)
    throw new Error(`Unrecognized API surface package row: ${previousRow}`);
  replacement[5] = previous[5];
  return replacement.join('|');
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
