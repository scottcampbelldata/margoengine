// The Jupyter check's venv bootstrap (python/tests/venv.mjs) on a machine without the venv, offline: a fresh clone once
// failed `npm run test:python:browser` with "no jupyter in test-results/.venv-data", a venv that existed only on one PC.
// Now a missing venv is made from the pinned requirements, and when that cannot work the check says SKIP, why, and
// the fix, in seconds: never a silent pass, never a hang. Processes are faked here (no Python or network needed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ensureVenv, findPython, pythonCandidates, SETUP } from '../python/tests/venv.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = () => mkdtempSync(join(tmpdir(), 'margo-venv-test-'));
const quiet = () => {};
/** A fake process runner: `answers(command, args)` returns { status, stdout, stderr }; every call is recorded. */
const fake = (answers) => {
  const calls = [];
  const exec = (command, args, ms) => {
    calls.push({ command, args, ms });
    return { status: 1, stdout: '', stderr: '', ...answers(command, args) };
  };
  return { exec, calls };
};
const version = (args) => args.includes('-c') && { status: 0, stdout: '3.13.0\n' };

test('an existing venv is used as it is, with no process started', () => {
  const venv = scratch();
  try {
    const bin = process.platform === 'win32' ? 'Scripts' : 'bin',
      ext = process.platform === 'win32' ? '.exe' : '';
    mkdirSync(join(venv, bin));
    for (const name of ['python', 'jupyter']) writeFileSync(join(venv, bin, name + ext), '');
    const { exec, calls } = fake(() => ({}));
    const result = ensureVenv({ venv, env: {}, exec, log: quiet });
    assert.equal(result.ok, true);
    assert.equal(result.made, false);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(venv, { recursive: true, force: true });
  }
});

test('no Python: the reason names what was tried and the one-command fix, without waiting', () => {
  const venv = join(scratch(), 'venv');
  const { exec, calls } = fake(() => ({ status: null, error: new Error('spawn python ENOENT') }));
  const result = ensureVenv({ venv, env: {}, exec, log: quiet });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no supported Python found .*install Python 3.12 or 3.13.*MARGO_PYTHON/);
  assert.ok(result.reason.includes(SETUP), result.reason);
  assert.deepEqual(
    calls.map((c) => [c.command, ...c.args.slice(0, -2)].join(' ')),
    pythonCandidates().map((c) => c.join(' ')),
  );
  assert.ok(
    calls.every((c) => c.ms > 0),
    'every probe has a time limit',
  );
});

test("Windows' python.exe store alias (prints a hint, exits 9009) is not taken for Python", () => {
  const { exec } = fake((command, args) =>
    command === 'py' && args[0] === '-3.13'
      ? { status: 9009, stdout: 'Python was not found; run without arguments to install' }
      : version(args) || {},
  );
  assert.deepEqual(findPython({ env: {}, exec, platform: 'win32' }), { command: ['py', '-3.12'], version: '3.13.0' });
});

test('offline: pip fails, the half-made venv is removed and the reason says so with the fix', () => {
  const venv = join(scratch(), 'venv');
  const { exec, calls } = fake((command, args) => {
    if (version(args)) return version(args);
    if (args.includes('venv')) {
      mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
      writeFileSync(join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), '');
      return { status: 0 };
    }
    return {
      status: 1,
      stderr: 'ERROR: Could not find a version that satisfies the requirement anyio==4.15.1 (from versions: none)',
    };
  });
  const result = ensureVenv({ venv, env: { MARGO_PYTHON: 'py-fake' }, exec, log: quiet });
  assert.equal(result.ok, false);
  assert.match(result.reason, /installing python\/requirements-notebook\.txt failed \(exit 1\)/);
  assert.match(result.reason, /anyio==4\.15\.1/);
  assert.match(result.reason, /offline/);
  assert.ok(result.reason.includes(SETUP));
  assert.equal(existsSync(venv), false, 'the half-made venv is gone, so the next run starts clean');
  const pip = calls.at(-1);
  assert.ok(pip.args.includes('-r') && pip.args.at(-1).endsWith('requirements-notebook.txt'), 'pinned file');
  assert.ok(pip.args.includes('--timeout') && pip.ms > 0, 'pip has network and hard time limits');
  assert.equal(calls[0].command, 'py-fake', 'MARGO_PYTHON is the only Python tried');
});

test('a hung pip install is reported as passing its time limit', () => {
  const venv = join(scratch(), 'venv');
  const { exec } = fake((command, args) => {
    if (version(args)) return version(args);
    if (args.includes('venv')) {
      mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
      writeFileSync(join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), '');
      return { status: 0 };
    }
    return {
      status: null,
      signal: 'SIGKILL',
      error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    };
  });
  const result = ensureVenv({ venv, env: { MARGO_PYTHON: 'python' }, exec, log: quiet });
  assert.equal(result.ok, false);
  assert.match(result.reason, /passed its time limit/);
  assert.equal(existsSync(venv), false);
});

test('the check itself, with a missing venv and no Python: loud SKIP naming the fix, exit 0; exit 1 when required', () => {
  const dir = scratch();
  try {
    const env = {
      ...process.env,
      MARGO_JUPYTER_VENV: join(dir, 'missing-venv'),
      MARGO_PYTHON: join(dir, 'no-such-python'),
      MARGO_JUPYTER_CHILD: '',
    };
    const check = (extra) =>
      spawnSync(process.execPath, [join(root, 'python/tests/jupyter-browser.mjs')], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...env, ...extra },
      });
    const skipped = check({ MARGO_REQUIRE_JUPYTER: '' });
    assert.equal(skipped.error, undefined, 'the check ends by itself');
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stderr, /==== SKIP: test:python:browser did not run \(this is not a pass\) ====/);
    assert.ok(skipped.stderr.includes(`Fix: ${SETUP}`), skipped.stderr);
    assert.ok(skipped.stderr.includes('MARGO_PYTHON='), 'names the Python it tried');
    const required = check({ MARGO_REQUIRE_JUPYTER: '1' });
    assert.equal(required.status, 1);
    assert.match(required.stderr, /==== FAIL: test:python:browser did not run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Python package suite (in verify) with no venv and no Python: loud SKIP naming the fix; FAIL when required', () => {
  const dir = scratch();
  try {
    // No Python anywhere: an empty PATH, no MARGO_PYTHON, a venv folder that does not exist.
    const env = { ...process.env, MARGO_JUPYTER_VENV: join(dir, 'missing-venv'), MARGO_PYTHON: '' };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') env[key] = join(dir, 'empty');
    delete env.NODE_TEST_CONTEXT; // run as its own test file, not as a child of this one
    const suite = (extra) =>
      spawnSync(process.execPath, ['--test', join(root, 'tests/python-package.test.js')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...env, ...extra },
      });
    const skipped = suite({ MARGO_REQUIRE_PYTHON: '' });
    const out = `${skipped.stdout}\n${skipped.stderr}`;
    assert.equal(skipped.error, undefined, 'the suite ends by itself');
    assert.equal(skipped.status, 0, out);
    assert.match(out, /SKIP: the margoengine Python package suite did not run \(this is not a pass\)/);
    assert.ok(out.includes(`Fix: ${SETUP}`), out);
    assert.match(out, /skipped 1/);
    const required = suite({ MARGO_REQUIRE_PYTHON: '1' });
    assert.equal(required.status, 1, `${required.stdout}\n${required.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const probe = (versions) => (command, args) => {
  const key = [command, ...args.filter((a) => a !== '-c' && !a.startsWith('import'))].join(' ');
  return key in versions ? { status: 0, stdout: `${versions[key]}\n` } : { status: 1 };
};

test('picks 3.13 or 3.12, never a newer Python the pinned PyYAML has no wheel for (bug 24b)', () => {
  // Python 3.15 is first on PATH, as on the Beelink; the py launcher also has 3.12.
  const { exec } = fake(probe({ python: '3.15.0', python3: '3.15.0', 'py -3.12': '3.12.7' }));
  assert.deepEqual(findPython({ env: {}, exec, platform: 'win32' }), { command: ['py', '-3.12'], version: '3.12.7' });
  const linux = fake(probe({ python3: '3.15.0', 'python3.12': '3.12.4' }));
  assert.deepEqual(findPython({ env: {}, exec: linux.exec, platform: 'linux' }), {
    command: ['python3.12'],
    version: '3.12.4',
  });
  const plain = fake(probe({ python3: '3.13.1' }));
  assert.deepEqual(findPython({ env: {}, exec: plain.exec, platform: 'linux' }), {
    command: ['python3'],
    version: '3.13.1',
  });
});

test('only Python 3.15 on PATH: stops with one line naming the fix, no venv, no pip (bug 24b)', () => {
  const venv = join(scratch(), 'venv');
  const { exec, calls } = fake(probe({ python: '3.15.0', python3: '3.15.0', 'py -3.13': '3.15.0' }));
  const result = ensureVenv({ venv, env: {}, exec, log: quiet });
  assert.equal(result.ok, false);
  assert.match(result.reason, /install Python 3.12 or 3.13.*set MARGO_PYTHON/);
  assert.doesNotMatch(result.reason, /Visual C\+\+/);
  assert.ok(
    calls.every((c) => c.args.includes('-c')),
    'nothing but version probes ran',
  );
});

test('MARGO_PYTHON overrides the supported-version filter', () => {
  const { exec } = fake(probe({ 'my-python': '3.15.0' }));
  assert.deepEqual(findPython({ env: { MARGO_PYTHON: 'my-python' }, exec }), {
    command: ['my-python'],
    version: '3.15.0',
  });
});
