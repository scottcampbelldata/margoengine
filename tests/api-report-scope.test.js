import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mergeScopedApiSurface,
  packageMatchesApiReportScope,
  parseApiReportArguments,
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
  assert.match(after, /^\| @margoengine\/biomes \| `\.` 4, `\.\/disturbance` 12 \| 2 \|  \| 100 \|$/m);
  assert.equal(after.split('\n').filter((line) => line === scatter).length, 1);
});
