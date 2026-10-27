// The Python virtual environment the Jupyter check runs on (python/tests/jupyter-browser.mjs): found, or made from the
// pinned python/requirements-notebook.txt with the Python on PATH, so a fresh clone needs one command (or none: the check
// makes it on first run). When Python is missing or the install fails (no network), the caller gets a reason and the fix
// instead of a hang: every step has a hard time limit.
//   npm run setup:python-test               make it (or report it ready)
//   MARGO_JUPYTER_VENV=<dir>                use another folder (default: test-results/.venv-data in the main checkout)
//   MARGO_PYTHON=<python>                   make it with this Python (default: python, python3, then py -3 on PATH)
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
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

const run = (command, args, ms) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', windowsHide: true });
const tail = (text, lines = 12) => (text ?? '').trim().split('\n').slice(-lines).join('\n');

/** The first working Python 3 as `[command, ...args]` with its version, or undefined. MARGO_PYTHON (one command) wins;
 * otherwise python, python3, py -3. (Windows' python.exe store alias only prints a hint and fails, so it is skipped.) */
export function findPython({ env = process.env, exec = run } = {}) {
  const candidates = env.MARGO_PYTHON ? [[env.MARGO_PYTHON]] : [['python'], ['python3'], ['py', '-3']];
  for (const [command, ...args] of candidates) {
    const probe = exec(command, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], 30_000);
    const version = probe.status === 0 && /^3\.\d+\.\d+$/.exec(probe.stdout?.trim() ?? '')?.[0];
    if (version) return { command: [command, ...args], version };
  }
}

/**
 * Makes the venv at `venv` from `requirements` (pinned versions) unless it is ready. Returns `{ ok: true, tools, made }`,
 * or `{ ok: false, reason }` with what failed and the fix; a half-made venv is removed so the next run starts clean.
 * `exec(command, args, ms)` runs a process (spawnSync by default; tests pass a fake, so no network is needed).
 */
export function ensureVenv({ venv = venvDir(), env = process.env, exec = run, log = console.error } = {}) {
  const ready = venvTools(venv);
  if (ready) return { ok: true, tools: ready, made: false };
  const fix = `run \`${SETUP}\` with Python 3 on PATH and network access to PyPI (or set MARGO_PYTHON), then run the check again`;
  const python = findPython({ env, exec });
  if (!python)
    return {
      ok: false,
      reason: `no Python 3 found (${env.MARGO_PYTHON ? `MARGO_PYTHON=${env.MARGO_PYTHON}` : 'python, python3 and py -3 on PATH'}): install Python 3 from https://www.python.org/downloads/ and ${fix}`,
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
  const pip = exec(
    tools().python,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--timeout', '30', '--retries', '2', '-r', requirements],
    25 * 60_000,
  );
  if (pip.status !== 0) return fail('installing python/requirements-notebook.txt', pip);
  const done = venvTools(venv);
  if (!done) {
    rmSync(venv, { recursive: true, force: true });
    return { ok: false, reason: `python/requirements-notebook.txt installed, but ${venv} has no jupyter executable: ${fix}` };
  }
  return { ok: true, tools: done, made: true };
}
