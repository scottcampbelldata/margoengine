// The Python virtual environment the Jupyter check runs on (python/tests/jupyter-browser.mjs): found, or made from the
// pinned python/requirements-notebook.txt with the Python on PATH, so a fresh clone needs one command (or none: the check
// makes it on first run). When Python is missing or the install fails (no network), the caller gets a reason and the fix
// instead of a hang: every step has a hard time limit.
//   npm run setup:python-test               make it (or report it ready)
//   MARGO_JUPYTER_VENV=<dir>                use another folder (default: test-results/.venv-data in the main checkout)
//   MARGO_PYTHON=<python>                   make it with this Python (default: Python 3.12 or 3.13 found by py -3.13 / py -3.12 / python3.13 / python3.12 / python3 / python)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
/** The checkout that owns test-results/.venv-data: the main one when this runs in a worktree under .claude/worktrees. */
export const mainCheckout = root.replace(/[\\/]\.[\w-]+[\\/]worktrees[\\/][^\\/]+$/, '');
export const requirements = join(root, 'python/requirements-notebook.txt');
export const SETUP = 'npm run setup:python-test';

/** The venv folder: MARGO_JUPYTER_VENV, else test-results/.venv-data in the main checkout. */
export const venvDir = (env = process.env) => env.MARGO_JUPYTER_VENV || join(mainCheckout, 'test-results/.venv-data');

/** `{ python, jupyter }` executables in `venv`, or undefined when either is missing. */
export function venvTools(venv) {
  const find = (names) => names.map((p) => join(venv, p)).find(existsSync);
  const python = find(['Scripts/python.exe', 'bin/python']),
    jupyter = find(['Scripts/jupyter.exe', 'bin/jupyter']);
  return python && jupyter ? { python, jupyter } : undefined;
}

const PIP_ARGS = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--timeout', '30', '--retries', '2', '-r', requirements];
const run = (command, args, ms) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', windowsHide: true });
const tail = (text, lines = 12) => (text ?? '').trim().split('\n').slice(-lines).join('\n');

/** The Python minor versions the pinned python/requirements-notebook.txt has wheels for (PyYAML has none for newer ones). */
export const SUPPORTED_PYTHON = ['3.13', '3.12'];
export const PYTHON_FIX = 'install Python 3.12 or 3.13 from https://www.python.org/downloads/, or set MARGO_PYTHON to one';

/** Where to look for a supported Python, best first: the py launcher on Windows, python3.13 and python3.12 elsewhere, then plain names. */
export const pythonCandidates = (platform = process.platform) => [
  ...SUPPORTED_PYTHON.map((v) => (platform === 'win32' ? ['py', `-${v}`] : [`python${v}`])),
  ['python3'],
  ['python'],
];

/**
 * The first working supported Python (3.12 or 3.13) as `[command, ...args]` with its version, or undefined.
 * MARGO_PYTHON (one command) wins and is used as given. Newer Pythons are skipped: the pinned PyYAML has no wheel for
 * them and the install would die needing a C compiler. (Windows' python.exe store alias only prints a hint and fails,
 * so it is skipped too.)
 */
export function findPython({ env = process.env, exec = run, platform = process.platform } = {}) {
  const candidates = env.MARGO_PYTHON ? [[env.MARGO_PYTHON]] : pythonCandidates(platform);
  for (const [command, ...args] of candidates) {
    const probe = exec(command, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], 30_000);
    const version = probe.status === 0 && /^3\.\d+\.\d+$/.exec(probe.stdout?.trim() ?? '')?.[0];
    if (version && (env.MARGO_PYTHON || SUPPORTED_PYTHON.includes(version.split('.').slice(0, 2).join('.'))))
      return { command: [command, ...args], version };
  }
}

/** Stamp file inside the venv: the hash of the requirements file the venv was last installed from. */
export const STAMP = '.requirements-sha256';
/** SHA-256 of the requirements file. */
export const requirementsHash = (file = requirements) => createHash('sha256').update(readFileSync(file)).digest('hex');
const stampOf = (venv) => {
  try {
    return readFileSync(join(venv, STAMP), 'utf8').trim();
  } catch {
    return undefined;
  }
};

/** Packages the Jupyter check opens or imports itself: each must be pinned in the requirements and installed in the venv. */
export const NEEDED_PACKAGES = ['jupyterlab', 'notebook'];

/** The needed packages missing from `installed` (normalised name to version or null), as sentences naming the fix. */
export function missingNeeded(installed, needed = NEEDED_PACKAGES) {
  return needed.filter((n) => !installed.get(normaliseName(n))).map((n) => `${n} is not installed in the check's venv: run ${SETUP}`);
}

/**
 * Makes the venv at `venv` from `requirements` (pinned versions) unless it is ready. A venv whose stamp (the hash of the
 * requirements file it was installed from) differs from the file now, or has none, is updated in place with
 * `pip install -r`: nothing is deleted, so a failed update (say offline) leaves the old venv as it was. Returns `{ ok: true, tools, made }`,
 * or `{ ok: false, reason }` with what failed and the fix; a half-made venv is removed so the next run starts clean.
 * `exec(command, args, ms)` runs a process (spawnSync by default; tests pass a fake, so no network is needed).
 */
export function ensureVenv({ venv = venvDir(), env = process.env, exec = run, log = console.error } = {}) {
  const ready = venvTools(venv);
  const want = requirementsHash();
  if (ready && stampOf(venv) === want) return { ok: true, tools: ready, made: false };
  const fix = `run \`${SETUP}\` with Python 3 on PATH and network access to PyPI (or set MARGO_PYTHON), then run the check again`;
  if (ready) {
    log(`python venv: ${venv} was not installed from the current ${requirements}; updating it in place`);
    const update = exec(ready.python, PIP_ARGS, 25 * 60_000);
    if (update.status !== 0) {
      const timedOut = update.error?.code === 'ETIMEDOUT' || update.signal === 'SIGKILL';
      return {
        ok: false,
        reason: `updating ${venv} from python/requirements-notebook.txt ${timedOut ? 'passed its time limit' : `failed (exit ${update.status})`}\n${tail(update.stderr || update.stdout)}\nIf this machine is offline, PyPI cannot be reached: ${fix}`,
      };
    }
    writeFileSync(join(venv, STAMP), `${want}\n`);
    return { ok: true, tools: ready, made: false };
  }
  const python = findPython({ env, exec });
  if (!python)
    return {
      ok: false,
      reason: `no supported Python found (${env.MARGO_PYTHON ? `MARGO_PYTHON=${env.MARGO_PYTHON}` : 'Python 3.12 or 3.13 via py -3.13, py -3.12, python3.13, python3.12, python3 or python on PATH'}): ${PYTHON_FIX}, then ${fix}`,
    };
  const [command, ...args] = python.command;
  log(`python venv: making ${venv} with ${python.command.join(' ')} (Python ${python.version}), pinned ${requirements}`);
  rmSync(venv, { recursive: true, force: true });
  const made = exec(command, [...args, '-m', 'venv', venv], 5 * 60_000);
  const tools = () => venvTools(venv) ?? { python: ['Scripts/python.exe', 'bin/python'].map((p) => join(venv, p)).find(existsSync) };
  const fail = (what, result) => {
    rmSync(venv, { recursive: true, force: true });
    const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL';
    return {
      ok: false,
      reason: `${what} ${timedOut ? 'passed its time limit' : `failed (exit ${result.status})`}${result.error && !timedOut ? `: ${result.error.message}` : ''}\n${tail(result.stderr || result.stdout)}\nIf this machine is offline, PyPI cannot be reached: ${fix}`,
    };
  };
  if (made.status !== 0 || !tools().python) return fail(`\`${python.command.join(' ')} -m venv ${venv}\``, made);
  const pip = exec(tools().python, PIP_ARGS, 25 * 60_000);
  if (pip.status !== 0) return fail('installing python/requirements-notebook.txt', pip);
  const done = venvTools(venv);
  if (!done) {
    rmSync(venv, { recursive: true, force: true });
    return { ok: false, reason: `python/requirements-notebook.txt installed, but ${venv} has no jupyter executable: ${fix}` };
  }
  writeFileSync(join(venv, STAMP), `${want}\n`);
  return { ok: true, tools: done, made: true };
}

/** PEP 503 name normalisation: runs of `-`, `_` and `.` become one `-`, lower case. */
export const normaliseName = (name) => name.replace(/[-_.]+/g, '-').toLowerCase();

/** The `name==version` pins in a requirements text as a Map of normalised name to version (comments and blank lines skipped). */
export function parsePins(text) {
  const pins = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s;#]+)/.exec(line);
    if (match) pins.set(normaliseName(match[1]), match[2]);
  }
  return pins;
}

/** Packages reported when installed though the requirements file may not pin them: a name missing here is not an error. */
export const OPTIONAL_REPORTED = ['notebook', 'jupyterlab', 'jupyter-server', 'jupyter-client', 'ipykernel', 'ipywidgets', 'tornado'];

/** Every name whose installed version is wanted: the pins plus the optional names (normalised). */
export const namesToRead = (pins, optional = OPTIONAL_REPORTED) => [...new Set([...pins.keys(), ...optional.map(normaliseName)])];

/**
 * Compares installed versions (`installed`: normalised name to version or null) with the pins. A pinned package that is
 * missing or at another version is a problem naming it; an optional name that is not installed is reported as such.
 * Returns `{ line, problems }`.
 */
export function compareVersions(pins, installed, optional = OPTIONAL_REPORTED) {
  const problems = [];
  for (const [name, pin] of pins) {
    const have = installed.get(name) ?? null;
    if (have === null) problems.push(`${name} ${pin} is pinned but not installed`);
    else if (have !== pin) problems.push(`${name} is ${have} but pinned to ${pin}`);
  }
  const shown = [...new Set(optional.map(normaliseName))];
  const line = shown.map((n) => `${n} ${installed.get(n) ?? 'not installed'}`).join(', ');
  return { line, problems };
}
