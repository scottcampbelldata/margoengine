// Recounts docs/rapier-parity.md and checks its Summary table against the rows, so the summary cannot drift from them.
// Part 1 rows count by the first word of their Status cell; Part 2 rows, which have no Status, by the first word of their
// Batch cell when it is a status (PLANNED 131), and as MISSING, owned by the batch named, otherwise. Tables without a Status or a Batch column (the rows where
// Margo already does more) are not counted.
//   node scripts/check-rapier-parity.mjs    print the counts, exit 1 when the summary disagrees
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const COLUMNS = ['DONE', 'PARTIAL', 'BUILDING', 'PLANNED', 'MISSING', 'N/A'];

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());

/** Counts per part: { 1: {rows, DONE, ...}, 2: {...} }. */
export function countParity(text) {
  const counts = {};
  let part = 0,
    header = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^# Part (\d+)/.exec(line);
    if (heading) part = +heading[1];
    if (/^## Summary/.test(line)) part = 0;
    if (!line.startsWith('|')) {
      header = null;
      continue;
    }
    const row = cells(line);
    if (!header) {
      header = row;
      continue;
    }
    if (/^-+$/.test(row[0]) || !part) continue;
    const status = header.indexOf('Status'),
      batch = header.indexOf('Batch');
    let kind;
    if (status >= 0) kind = /^(DONE|PARTIAL|BUILDING|PLANNED|MISSING|N\/A)\b/.exec(row[status])?.[1];
    else if (batch >= 0) kind = /^(DONE|PARTIAL|BUILDING|PLANNED|MISSING|N\/A)\b/.exec(row[batch])?.[1] ?? 'MISSING';
    else continue;
    if (!kind) throw new Error(`rapier-parity: row ${row[0]} has a Status that starts with none of ${COLUMNS.join(', ')}: ${row[status]}`);
    counts[part] ??= Object.fromEntries([['rows', 0], ...COLUMNS.map((c) => [c, 0])]);
    counts[part].rows++;
    counts[part][kind]++;
  }
  return counts;
}

/** The Summary table's numbers per part, read from the leading number of each cell. */
export function readSummary(text) {
  const at = text.search(/^## Summary/m);
  if (at < 0) throw new Error('rapier-parity: no ## Summary section');
  const lines = text.slice(at).split(/\r?\n/).filter((line) => line.startsWith('|')),
    header = cells(lines[0]),
    summary = {};
  for (const line of lines.slice(2)) {
    const row = cells(line),
      part = /^(\d+)/.exec(row[0]);
    if (!part) continue;
    const entry = {};
    header.forEach((name, i) => {
      if (!i) return;
      const key = name === 'Rows' ? 'rows' : COLUMNS.find((c) => name.startsWith(c));
      if (key) entry[key] = Number(/^\d+/.exec(row[i])?.[0] ?? NaN);
    });
    summary[part[1]] = entry;
  }
  return summary;
}

/** Each place where the summary and the rows disagree, as text; empty when they agree. */
export function checkParity(text) {
  const counted = countParity(text),
    summary = readSummary(text),
    errors = [];
  for (const part of new Set([...Object.keys(counted), ...Object.keys(summary)]))
    for (const key of ['rows', ...COLUMNS]) {
      const want = counted[part]?.[key] ?? 0,
        have = summary[part]?.[key];
      if (have !== want) errors.push(`Part ${part} ${key}: the summary says ${have}, the rows count ${want}`);
    }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = readFileSync(new URL('../docs/rapier-parity.md', import.meta.url), 'utf8');
  console.log(JSON.stringify(countParity(text)));
  const errors = checkParity(text);
  for (const error of errors) console.error(error);
  process.exit(errors.length ? 1 : 0);
}
