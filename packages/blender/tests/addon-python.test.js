// The Blender add-on's pure-Python tests (tools/blender-addon/tests/test_*.py: the .margo writer, the live link server
// and the archive) need no Blender, so they run with the package tests. Before 2026-11-15 only the GitHub workflow ran
// them, and that workflow is off, so nothing ran them at all. Each runs isolated (python -I).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findPython } from '../../../scripts/support/find-python.mjs';

const folder = fileURLToPath(new URL('../../../tools/blender-addon/tests/', import.meta.url));
const scripts = readdirSync(folder).filter((name) => /^test_.*\.py$/.test(name));

test('the add-on has its pure-Python tests', () => {
  assert.deepEqual(scripts.sort(), ['test_format.py', 'test_live.py', 'test_package.py']);
});

for (const name of scripts)
  test(`add-on ${name} passes`, () => {
    const python = findPython();
    assert.ok(python, 'no Python on this machine: the add-on tests did not run (this is not a pass)');
    const run = spawnSync(python, ['-I', name], { cwd: folder, encoding: 'utf8', timeout: 5 * 60_000 });
    assert.equal(run.error, undefined, `${python}: ${run.error?.message}`);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /\nOK\s*$/);
  });
