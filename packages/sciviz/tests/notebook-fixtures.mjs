// The notebook browser suite (notebook-browser.mjs) reads test-results/sciviz-notebook/{mri,exo}.json and their
// buffers, which only python/tests/notebook-fixtures.py writes (it runs the shipped notebook). Run alone, as
// check:gpu-packages runs it, nothing had made them and the page's fetch read an empty body (amd-gpu-hunt row 18).
// The suite now makes them itself, before any GPU work: the Python AFM bundle (python/build-notebook.mjs), then the
// fixtures in the notebook test venv (python/tests/venv.mjs, made or updated from the pinned requirements). Without
// Python or network the suite fails here with the reason and the fix instead.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureVenv } from '../../../python/tests/venv.mjs';

export const root = resolve(import.meta.dirname, '../../..');
export const folder = join(root, 'test-results/sciviz-notebook');
export const FIXTURES = ['mri.json', 'exo.json', 'mri.html', 'exo.html'];

const run = (command, args, ms) =>
  spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', windowsHide: true });
const tail = (text, lines = 12) => (text ?? '').trim().split('\n').slice(-lines).join('\n');
const failed = (what, result) =>
  new Error(
    `${what} ${result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL' ? 'passed its time limit' : `failed (exit ${result.status})`}\n${tail(result.stderr || result.stdout)}`,
  );

/**
 * Writes the notebook fixtures afresh: old ones are removed first, so a failed run never leaves a stale set behind.
 * `ensure`, `exec` and `dir` are for tests (a fake venv, process runner and folder). Throws with the reason and the fix.
 */
export function prepareNotebookFixtures({ ensure = ensureVenv, exec = run, dir = folder } = {}) {
  for (const name of FIXTURES) rmSync(join(dir, name), { force: true });
  const venv = ensure();
  if (!venv.ok) throw new Error(`sciviz notebook fixtures need the notebook test venv: ${venv.reason}`);
  const bundle = exec(process.execPath, ['python/build-notebook.mjs'], 5 * 60_000);
  if (bundle.status !== 0) throw failed('node python/build-notebook.mjs (run npm run build:packages first)', bundle);
  const fixtures = exec(venv.tools.python, ['python/tests/notebook-fixtures.py'], 5 * 60_000);
  if (fixtures.status !== 0) throw failed('python/tests/notebook-fixtures.py', fixtures);
  const missing = FIXTURES.filter((name) => !existsSync(join(dir, name)));
  if (missing.length) throw new Error(`python/tests/notebook-fixtures.py ran but wrote no ${missing.join(', ')} in ${dir}`);
}
