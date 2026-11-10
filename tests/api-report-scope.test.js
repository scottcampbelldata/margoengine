import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  gzipCell,
  mergeScopedApiSurface,
  packageMatchesApiReportScope,
  parseApiReportArguments,
  refreshApiSurfaceGzip,
  refreshSurfaceGzip,
} from '../scripts/api-report-scope.mjs';

test('API report scope requires an explicit package for an entry and rejects unknown arguments', () => {
  assert.deepEqual(parseApiReportArguments(['--update', '--package=biomes', '--entry=./disturbance']), {
    update: true,
    packageSelector: 'biomes',
    entrySelector: './disturbance',
  });
  assert.throws(() => parseApiReportArguments(['--entry=./disturbance']), /requires --package/);
  assert.throws(() => parseApiReportArguments(['--all']), /Unknown API report argument/);
  assert.equal(packageMatchesApiReportScope('biomes', 'biomes', '@margoengine/biomes'), true);
  assert.equal(packageMatchesApiReportScope('@margoengine/biomes', 'biomes', '@margoengine/biomes'), true);
  assert.equal(packageMatchesApiReportScope('biomes', 'scatter', '@margoengine/scatter'), false);
});

test('a scoped API update changes only its package row and the aggregate summary', () => {
  const before = [
    '# Public API surface',
    '',
    '2 packages, 3 entries, 10 exported names.',
    '',
    '| Package | Exports per entry | Unexported | `any` | Gzip |',
    '| --- | --- | ---: | ---: | ---: |',
    '| @margoengine/biomes | `.` 4 | 1 |  | 100 |',
    '| @margoengine/scatter | `.` 3, `./tiles` 3 | 9 |  | 200 |',
    '',
  ].join('\n');
  const scatter = '| @margoengine/scatter | `.` 3, `./tiles` 3 | 9 |  | 200 |';

  const after = mergeScopedApiSurface(before, {
    packageName: '@margoengine/biomes',
    row: '| @margoengine/biomes | `.` 4, `./disturbance` 12 | 2 |  | 999 |',
    entries: 2,
    exports: 16,
  });

  assert.match(after, /^2 packages, 4 entries, 22 exported names\.$/m);
  // The row is the one the full run writes, Gzip included (it once kept the old figure, so a scoped check passed on it).
  assert.match(after, /^\| @margoengine\/biomes \| `\.` 4, `\.\/disturbance` 12 \| 2 \|  \| 999 \|$/m);
  assert.equal(after.split('\n').filter((line) => line === scatter).length, 1);
});

// Regression (2026-11-10): the Gzip column is entry-sizes.json's root-entry figure, but entry-sizes.mjs rewrote that
// record without touching docs/api-surface.md and a scoped report kept every old Gzip cell. A lane that measured sizes
// after its api:check pushed 72 stale cells (f235e21f0) and main's own api:check failed until someone regenerated it.
test('the Gzip column follows entry-sizes.json, and measuring sizes rewrites it', (t) => {
  const surface = [
    '2 packages, 2 entries, 7 exported names.',
    '',
    '| Package | Exports per entry | Unexported | `any` | Gzip |',
    '| --- | --- | ---: | ---: | ---: |',
    '| @margoengine/biomes | `.` 4 | 1 |  | 100 |',
    '| @margoengine/scatter | `.` 3 | 9 |  | 200 |',
    '',
  ].join('\n');
  const sizes = { packages: { '@margoengine/biomes': { '.': { gzip: 1234 } }, '@margoengine/scatter': {} } };
  assert.equal(gzipCell(sizes, '@margoengine/biomes'), '1,234');
  assert.equal(gzipCell(sizes, '@margoengine/scatter'), '');
  const refreshed = refreshSurfaceGzip(surface, sizes);
  assert.match(refreshed, /^\| @margoengine\/biomes \| `\.` 4 \| 1 \|  \| 1,234 \|$/m);
  assert.match(refreshed, /^\| @margoengine\/scatter \| `\.` 3 \| 9 \|  \|  \|$/m);
  assert.equal(refreshSurfaceGzip(refreshed.replaceAll('\n', '\r\n'), sizes), refreshed.replaceAll('\n', '\r\n'));

  const root = mkdtempSync(join(tmpdir(), 'margo-surface-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'examples/package-benchmarks/results'), { recursive: true });
  writeFileSync(join(root, 'docs/api-surface.md'), surface);
  writeFileSync(join(root, 'examples/package-benchmarks/results/entry-sizes.json'), JSON.stringify(sizes));
  refreshApiSurfaceGzip(root);
  assert.equal(readFileSync(join(root, 'docs/api-surface.md'), 'utf8'), refreshed);

  const measure = readFileSync(new URL('../examples/package-benchmarks/entry-sizes.mjs', import.meta.url), 'utf8')
    .replaceAll('\r\n', '\n');
  assert.match(
    measure,
    /await writeFile\(resolve\(import\.meta\.dirname, 'results\/entry-sizes\.json'\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*refreshApiSurfaceGzip\(root\);/,
    'entry-sizes.mjs rewrites the Gzip column right after it writes the record',
  );
});

test('scoped API updates reject unresolved boundaries before they can split the table and duplicate package rows', () => {
  const header = '| Package | Exports per entry | Unexported | `any` | Gzip |';
  const row = '| @margoengine/biomes | `.` 4 | 1 |  | 100 |';
  const before = [
    '1 packages, 1 entries, 4 exported names.',
    '',
    header,
    '| --- | --- | ---: | ---: | ---: |',
    row,
    '',
  ].join('\n');
  const replacement = { packageName: '@margoengine/biomes', row, entries: 1, exports: 4 };
  for (const target of ['1 packages, 1 entries, 4 exported names.', header, row]) {
    const conflict = before.replace(target, `<<<<<<< HEAD\n${target}\n=======\n${target}\n>>>>>>> lane`);
    for (const text of [conflict, conflict.replaceAll('\n', '\r\n')])
      assert.throws(() => mergeScopedApiSurface(text, replacement), /unresolved merge boundary.*npm run api:update/);
  }
});
test('committed API totals include every package table row and the umbrella exports', () => {
  const text = readFileSync(new URL('../docs/api-surface.md', import.meta.url), 'utf8');
  const summary = text.match(/^(\d+) packages, (\d+) entries, (\d+) exported names\.$/m);
  assert.ok(summary);
  const rows = text.split(/\r?\n/).filter((line) => /^\| (?:@margoengine\/[^|]+|margoengine) \|/.test(line));
  assert.ok(rows.some((row) => row.startsWith('| margoengine |')));
  const counts = rows.flatMap((row) =>
    [...row.split('|')[2].matchAll(/`[^`]+`\s+(\d+)/g)].map((match) => Number(match[1])),
  );
  assert.deepEqual(summary.slice(1).map(Number), [rows.length, counts.length, counts.reduce((a, b) => a + b, 0)]);
});
