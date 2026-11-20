import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endRecorder } from './support/end-recorder.js';

// `--help` and `-h` print the usage and exit 0 before any build or browser starts (bug: gpu-package-tests started
// `npm run build:packages` on --help; check-merge and visual-regression ran their full work).
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scripts = {
  'gpu-package-tests.mjs': ['--select=', '<dir>/<script>', '--no-build', '--only=', '--list'],
  'check-merge.mjs': ['--full', '--base='],
  'visual-regression.js': ['--only=', '--update'],
};

for (const [name, mentions] of Object.entries(scripts))
  for (const flag of ['--help', '-h'])
    test(`${name} ${flag} prints usage and exits before any build or browser`, () => {
      const started = Date.now(),
        run = spawnSync(process.execPath, [join(root, 'scripts', name), flag], {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
        }),
        out = `${run.stdout}${run.stderr}`;
      assert.equal(run.error, undefined, run.error?.message);
      assert.equal(run.status, 0, out);
      assert.match(run.stdout, /^usage: /, out);
      for (const text of mentions) assert.ok(run.stdout.includes(text), `usage mentions ${text}`);
      assert.doesNotMatch(out, /build:packages|vite v|check:merge: (FULL|AFFECTED)/);
      // wall-clock: --help printed and left; a script that started its work runs for minutes.
      assert.ok(Date.now() - started < 20_000, 'returned quickly');
    });

// KB-OWN-EXIT2 part 5: every script that offers --help prints it through showHelp (scripts/support/help.mjs) and skips
// its work in `if (!showHelp(usage)) { ... }`, so a help run ends by its event loop with code 0, never process.exit.
test('every --help run ends by its event loop with code 0', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'script-help-end-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { env, lines } = endRecorder(folder);
  const callers = readdirSync(join(root, 'scripts')).filter(
    (name) => /\.m?js$/.test(name) && /\bshowHelp\(/.test(readFileSync(join(root, 'scripts', name), 'utf8')),
  );
  assert.ok(callers.length >= 13, `only ${callers.length} scripts call showHelp`);
  for (const name of callers) {
    const run = spawnSync(process.execPath, [join(root, 'scripts', name), '--help'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(run.status, 0, `${name}: ${run.stdout}${run.stderr}`);
    assert.ok(run.stdout.trim().length > 0, `${name} printed no usage`);
    const ends = lines();
    assert.equal(ends.at(-1), '--help loop 0', `${name} did not end by its event loop: ${ends.join(' | ')}`);
  }
});
