// The margoengine Python package's own suite (python/tests): binary encoding, the Jupyter widget protocol against a
// stand-in comm, the plot specification and the example notebook. Runs with MARGO_PYTHON, else the data venv of the
// main checkout (test-results/.venv-data, python/requirements-test.txt), else python3 or python on PATH; the NumPy and
// pandas cases need those packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { colormapNames } from '@margoengine/sciviz/colormaps';
import { join, resolve } from 'node:path';

const main = resolve(import.meta.dirname, '..').replace(/[\\/]\.[\w-]+[\\/]worktrees[\\/][^\\/]+$/, '');
const venv = ['Scripts/python.exe', 'bin/python'].map((p) => join(main, 'test-results/.venv-data', p)).find(existsSync);
const python = [process.env.MARGO_PYTHON, venv, 'python3', 'python'].find(
  (cmd) => cmd && spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0,
);

test('the Python package suite passes', () => {
  assert.ok(python, 'Python 3.9+ must be on PATH to test the margoengine Python package');
  const run = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'python/tests', '-v'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});

test('the Python package accepts exactly the colour maps @margoengine/sciviz has', () => {
  const source = readFileSync(join(import.meta.dirname, '../python/margoengine/_figure.py'), 'utf8');
  const names = [.../COLORMAPS = \(([^)]*)\)/.exec(source)[1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, colormapNames);
});
