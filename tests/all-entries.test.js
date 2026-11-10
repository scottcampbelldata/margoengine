// The all-entries type project (integration J5, docs/integration-packaging.md): examples/all-entries/entries.ts imports
// every public entry of every package, so `npm run check:examples-types` (project `all-entries`) type-checks them in one
// program with the library declarations checked too. This fails when the file no longer matches the exports maps.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { OUTPUT, PENDING, allEntries, entriesSource } from '../scripts/generate-all-entries.mjs';
import { PROJECTS } from '../scripts/support/example-projects.mjs';

const root = resolve(import.meta.dirname, '..');

test('examples/all-entries/entries.ts matches the exports maps (run node scripts/generate-all-entries.mjs)', () => {
  assert.equal(readFileSync(join(root, OUTPUT), 'utf8').replace(/\r\n/g, '\n'), entriesSource(root));
});

test('the all-entries project is an example type project that checks library declarations', () => {
  const project = PROJECTS.find((p) => p.id === 'all-entries');
  assert.ok(project, 'scripts/support/example-projects.mjs has an all-entries project');
  const config = JSON.parse(readFileSync(join(root, project.config), 'utf8'));
  assert.equal(config.compilerOptions.skipLibCheck, false, 'library declarations are checked');
  assert.deepEqual(config.include, ['entries.ts']);
  assert.deepEqual(project.entries(root), [OUTPUT]);
});

test('the generator lists every exports key of a public package and leaves out only pending entries', () => {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const dir = mkdtempSync(join(root, 'test-results', 'all-entries-'));
  try {
    const write = (folder, manifest) => {
      mkdirSync(join(dir, 'packages', folder), { recursive: true });
      writeFileSync(join(dir, 'packages', folder, 'package.json'), JSON.stringify(manifest));
    };
    write('a', { name: '@margoengine/a', exports: { '.': {}, './x': {}, './*': {} } });
    write('b', { name: '@margoengine/b', private: true, exports: { '.': {} } });
    write('sciviz', { name: '@margoengine/sciviz', exports: { '.': {}, './flow': {} } });
    write('kit', { name: 'margoengine', exports: { '.': {}, './sciviz': {}, './sciviz/flow': {}, './gltf': {} } });
    assert.deepEqual(
      allEntries(dir).map((e) => e.specifier),
      ['@margoengine/a', '@margoengine/a/x', 'margoengine', 'margoengine/gltf'],
    );
    assert.match(entriesSource(dir), /^export \* as e_margoengine_a_x from '@margoengine\/a\/x';$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const { reason } of PENDING) assert.match(reason, /\S/);
});

test('npm run api:update rewrites the file with the API reports and npm run api:check fails when it is stale', () => {
  const report = readFileSync(join(root, 'scripts/api-report.js'), 'utf8');
  assert.match(report, /writeIfChanged\(join\(root, ALL_ENTRIES\), entriesSource\(root\)\)/, 'api:update writes it');
  assert.match(report, /no longer matches the exports maps/, 'api:check reports it stale');
});
