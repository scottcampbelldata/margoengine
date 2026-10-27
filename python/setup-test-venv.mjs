// One-command setup of the Python venv the Jupyter check runs on (`npm run setup:python-test`): makes
// test-results/.venv-data (in the main checkout) from the pinned python/requirements-notebook.txt with the Python on
// PATH, or says it is ready. `npm run test:python:browser` runs the same setup by itself when the venv is missing.
// Needs Python 3 and network access to PyPI once; see python/tests/venv.mjs for the options.
import { ensureVenv, venvDir } from './tests/venv.mjs';

const venv = venvDir(),
  result = ensureVenv({ venv });
if (!result.ok) {
  console.error(`setup:python-test: ${result.reason}`);
  process.exit(1);
}
console.log(`setup:python-test: ${result.made ? 'made' : 'ready'}: ${venv} (jupyter ${result.tools.jupyter})`);
