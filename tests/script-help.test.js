import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--help` and `-h` print the usage and exit 0 before any build, GPU lock or browser starts (bug: gpu-package-tests
// started `npm run build:packages` and took a GPU slot on --help; gpu-lock threw; check-merge, land-records,
// nightly-full and visual-regression ran their full work).
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scripts = {
  'gpu-package-tests.mjs': ['--select=', '<dir>/<script>', '--no-build', '--only=', '--list'],
  'check-merge.mjs': ['--full', '--base='],
  'visual-regression.js': ['--only=', '--update'],
  'gpu-lock.mjs': ['--owner=', '--exclusive'],
  'land-records.mjs': ['--no-commit'],
  'nightly-full.mjs': ['usage'],
};

for (const [name, mentions] of Object.entries(scripts))
  for (const flag of ['--help', '-h'])
    test(`${name} ${flag} prints usage and exits before any build, lock or browser`, () => {
      const lockDir = mkdtempSync(join(tmpdir(), 'help-lock-'));
      try {
        const started = Date.now(),
          run = spawnSync(process.execPath, [join(root, 'scripts', name), flag], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
            // Any lock taken would appear under this path instead of the real one.
            env: { ...process.env, MARGO_GPU_LOCK: join(lockDir, 'gpu.lock') },
          }),
          out = `${run.stdout}${run.stderr}`;
        assert.equal(run.error, undefined, run.error?.message);
        assert.equal(run.status, 0, out);
        assert.match(run.stdout, /^usage: /, out);
        for (const text of mentions) assert.ok(run.stdout.includes(text), `usage mentions ${text}`);
        assert.doesNotMatch(out, /build:packages|vite v|check:merge: (FULL|AFFECTED)/);
        assert.deepEqual(readdirSync(lockDir), [], 'no lock was taken');
        assert.ok(Date.now() - started < 20_000, 'returned quickly');
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    });
