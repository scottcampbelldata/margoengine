import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES, prepareNotebookFixtures } from './notebook-fixtures.mjs';

// Regression (amd-gpu-hunt row 18, 2026-11-11): notebook-browser.mjs fetched test-results/sciviz-notebook/*.json that
// only python/tests/notebook-fixtures.py writes, so run alone (as check:gpu-packages runs it) the page read an empty
// body. The suite now writes the fixtures itself before any browser opens, and fails with the reason when it cannot.
test('the notebook browser suite makes its fixtures before it opens a browser', () => {
  const text = readFileSync(new URL('./notebook-browser.mjs', import.meta.url), 'utf8'),
    prepare = text.indexOf('prepareNotebookFixtures();'),
    open = text.indexOf('await openBrowser(');
  assert.ok(prepare >= 0, 'notebook-browser.mjs calls prepareNotebookFixtures()');
  assert.ok(open > prepare, 'the fixtures are made before a browser opens');
});

test('the fixtures run the AFM build, then the shipped notebook in the venv, and stale fixtures never survive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sciviz-notebook-')),
    stale = join(dir, 'mri.json'),
    calls = [];
  writeFileSync(stale, '{}');
  assert.throws(
    () =>
      prepareNotebookFixtures({
        dir,
        ensure: () => ({ ok: false, reason: 'no supported Python found: install Python 3.12' }),
        exec: () => assert.fail('nothing runs without the venv'),
      }),
    /need the notebook test venv: no supported Python found/,
  );
  assert.equal(existsSync(stale), false, 'a failed preparation leaves no stale fixture');
  assert.throws(
    () =>
      prepareNotebookFixtures({
        dir,
        ensure: () => ({ ok: true, tools: { python: 'venv-python' } }),
        exec: (command, args) => {
          calls.push([command, ...args]);
          return { status: args[0].endsWith('.py') ? 1 : 0, stderr: 'ModuleNotFoundError: anywidget' };
        },
      }),
    /notebook-fixtures\.py failed \(exit 1\)\nModuleNotFoundError: anywidget/,
  );
  assert.deepEqual(calls, [
    [process.execPath, 'python/build-notebook.mjs'],
    ['venv-python', 'python/tests/notebook-fixtures.py'],
  ]);
  assert.throws(
    () =>
      prepareNotebookFixtures({
        dir,
        ensure: () => ({ ok: true, tools: { python: 'venv-python' } }),
        exec: () => ({ status: 0 }),
      }),
    new RegExp(`wrote no ${FIXTURES.join(', ')}`),
  );
  rmSync(dir, { recursive: true, force: true });
});
