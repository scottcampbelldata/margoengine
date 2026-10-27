// The margoengine Python package's own suite (python/tests): binary encoding, the Jupyter widget protocol against a
// stand-in comm, the plot specification and the example notebook. Runs with MARGO_PYTHON, else the data venv
// (test-results/.venv-data in the main checkout, or MARGO_JUPYTER_VENV), which python/tests/venv.mjs makes from the
// pinned python/requirements-notebook.txt when it is missing (`npm run setup:python-test`). A fresh clone once failed
// here: the suite ran the bare `python` on PATH, which has no traitlets. When the venv cannot be made (no Python, no
// network) the test is skipped with a loud message naming the fix, or fails with MARGO_REQUIRE_PYTHON=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { colormapNames } from '@margoengine/sciviz/colormaps';
import { join } from 'node:path';
import { ensureVenv, SETUP } from '../python/tests/venv.mjs';

test('the Python package suite passes', (t) => {
  let python = process.env.MARGO_PYTHON;
  if (!python) {
    const venv = ensureVenv();
    if (!venv.ok) {
      const message = `the margoengine Python package suite did not run (this is not a pass): ${venv.reason}\nFix: ${SETUP}`;
      console.error(`\n==== ${process.env.MARGO_REQUIRE_PYTHON === '1' ? 'FAIL' : 'SKIP'}: ${message}\n====\n`);
      assert.notEqual(process.env.MARGO_REQUIRE_PYTHON, '1', message);
      t.skip(message);
      return;
    }
    python = venv.tools.python;
  }
  const run = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'python/tests', '-v'], {
    encoding: 'utf8',
    timeout: 10 * 60_000,
  });
  assert.equal(run.error, undefined, `${python}: ${run.error?.message}`);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});

test('the Python package accepts exactly the colour maps @margoengine/sciviz has', () => {
  const source = readFileSync(join(import.meta.dirname, '../python/margoengine/_figure.py'), 'utf8');
  const names = [.../COLORMAPS = \(([^)]*)\)/.exec(source)[1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, colormapNames);
});
