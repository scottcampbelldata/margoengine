// Quiet first run: `npm run build:packages` prints one success line instead of about 140 lines of size JSON. The full
// record is always written to test-results/modern-bundle-sizes.json (what the checks read) and is printed with --sizes or
// MARGO_BUILD_VERBOSE=1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { SIZES_FILE, sizeReport, wantsFullSizes } from '../scripts/support/size-report.mjs';

const sizes = { kernel: { raw: 9082, gzip: 3484 }, base: { raw: 61345, gzip: 24848 } };

test('the default size report is one short line naming the record file and the flag for more', () => {
  const line = sizeReport(sizes, { full: false });
  assert.ok(!line.includes('\n'), 'one line');
  assert.ok(line.includes('24,848 B gzip'));
  assert.ok(line.includes(SIZES_FILE));
  assert.ok(line.includes('--sizes'));
});

test('the full size report is the same JSON the record file holds', () => {
  assert.deepEqual(JSON.parse(sizeReport(sizes, { full: true })), sizes);
});

test('--sizes and MARGO_BUILD_VERBOSE=1 ask for the full report, nothing else does', () => {
  assert.equal(wantsFullSizes(['node', 'build', '--precompiled'], {}), false);
  assert.equal(wantsFullSizes(['node', 'build', '--sizes'], {}), true);
  assert.equal(wantsFullSizes(['node', 'build'], { MARGO_BUILD_VERBOSE: '1' }), true);
  assert.equal(wantsFullSizes(['node', 'build'], { MARGO_BUILD_VERBOSE: '0' }), false);
});

test('build-modern writes the full record to its file whatever it prints', () => {
  const source = readFileSync(resolve(import.meta.dirname, '..', 'scripts', 'build-modern.js'), 'utf8');
  assert.ok(source.includes('writeFile(SIZES_FILE, JSON.stringify(sizes, null, 2))'));
  assert.ok(!/console\.\w+\(JSON\.stringify\(sizes/.test(source), 'sizes must go through sizeReport');
});
