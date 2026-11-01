// A package's own `npm test` runs its test files by name or by glob. A script that names files misses every file added
// later: packages/exporters named one of its 42 and the other 41 only ran in the root `test:all`.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const packagesDir = join(import.meta.dirname, '..', 'packages');

/** The packages still naming some files and missing others (docs/known-bugs.md). This list only shrinks. */
const STILL_MISSING_FILES = new Set([
  'animation',
  'audio',
  'clustered',
  'creative',
  'culling',
  'decoders',
  'environment',
  'ifc',
  'lines',
  'loaders',
  'materials',
  'physics',
  'points',
  'splats',
]);

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/** The package's `tests/*.test.js` and `test/*.test.js` files (what `test:all` runs) its test script does not reach. */
function filesNotRun(name) {
  const dir = join(packagesDir, name);
  const script = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.test ?? '';
  const reached = script
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ''))
    .filter((word) => word.endsWith('.test.js'))
    .map(globToRegExp);
  return ['tests', 'test']
    .filter((folder) => existsSync(join(dir, folder)))
    .flatMap((folder) =>
      readdirSync(join(dir, folder))
        .filter((file) => file.endsWith('.test.js'))
        .map((file) => `${folder}/${file}`),
    )
    .filter((file) => !reached.some((pattern) => pattern.test(file)));
}

const packages = readdirSync(packagesDir).filter((name) => existsSync(join(packagesDir, name, 'package.json')));

test('every package test script runs all of its test files', () => {
  const missing = packages
    .filter((name) => !STILL_MISSING_FILES.has(name))
    .map((name) => [name, filesNotRun(name)])
    .filter(([, files]) => files.length);
  assert.deepEqual(missing, [], 'use tests/*.test.js in the package test script so new files run');
});

test('a package fixed on the still-missing list leaves the list', () => {
  const fixed = [...STILL_MISSING_FILES].filter((name) => !filesNotRun(name).length);
  assert.deepEqual(fixed, [], 'take these names off STILL_MISSING_FILES');
});
