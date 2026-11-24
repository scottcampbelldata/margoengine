// scripts/support/package-records.mjs, run by scripts/hygiene.js on every push. Bug (2026-11-16): @margoengine/scenes
// landed with docs/README.md, docs/releasing.md, docs/whitepaper/claims.md and the white paper still stating 104
// packages, no row in entry-sizes.json (sizes.html could not be built), THIRD-PARTY-NOTICES.md a package behind and
// examples/dune-coast in no type-check project. Only local CI's full root tests failed, after the push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertPackageRecordsCurrent,
  foldersInNoProject,
  packageRecordProblems,
} from '../scripts/support/package-records.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test("the repository's package records are current", () => {
  assert.deepEqual(packageRecordProblems(root), []);
  assert.doesNotThrow(() => assertPackageRecordsCurrent(root));
});

test('a package added without its records is reported, each with the command that brings it up to date', (t) => {
  const fake = mkdtempSync(join(tmpdir(), 'package-records-'));
  t.after(() => rmSync(fake, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(fake, path)), { recursive: true });
    writeFileSync(join(fake, path), text);
  };
  const catalog = JSON.parse(read('docs/catalog.json'));
  for (const entry of catalog) write(`packages/${entry.id}/package.json`, read(`packages/${entry.id}/package.json`));
  // The new package is in the catalog, but nothing else was regenerated.
  const added = { ...catalog.at(-1), id: 'new-scene', package: '@margoengine/new-scene', name: '@margoengine/new-scene' };
  write('packages/new-scene/package.json', JSON.stringify({ name: added.package, version: '0.0.0' }));
  write('docs/catalog.json', JSON.stringify([...catalog, added]));
  for (const record of ['entry-sizes.json', 'basic-scene-network.json'])
    write(`examples/package-benchmarks/results/${record}`, read(`examples/package-benchmarks/results/${record}`));
  write('README.md', `Search all ${catalog.length} packages by task.\n`);
  write('examples/new-scene/main.ts', 'export {};\n');
  write('examples/vite/tsconfig.json', '{}');
  write('examples/vite/src/main.ts', 'export {};\n');

  assert.deepEqual(foldersInNoProject(fake), ['new-scene'], 'a folder with a project tsconfig counts as in a project');
  const problems = packageRecordProblems(fake);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(
    problems[0],
    new RegExp(`README\\.md: states ${catalog.length} packages, the catalog has ${catalog.length + 1}.*npm run catalog:build`),
  );
  assert.match(problems[1], /sizes\.html cannot be built: .*no sizes for @margoengine\/new-scene.*entry-sizes\.mjs/);
  assert.match(problems[2], /examples\/new-scene is in no type-check project: add it in scripts\/support\/example-projects/);
});
