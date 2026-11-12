import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// KB-FL2 (2026-11-11): this test failed once in a parallel root run and passed alone. Each probe below had a 5 s
// limit of its own, a step deadline rather than a hang bound: a probe takes about 85 ms, but 2.6 s was measured while
// the root suite ran 4 files at once beside another test run, and the 5 s step limit then failed a probe that was only
// slow, with nothing in the message to say so. The probes now run without a step deadline; the test's own limit below
// is the hang bound (only a probe that never ends reaches it), and a failed probe reports how it ended.
const HANG_BOUND_MS = 120_000;

// Runs `command` in a shell in `cwd` and resolves to how it ended.
const shell = (command, cwd) =>
  new Promise((done) =>
    exec(command, { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) =>
      done({ code: error ? (error.code ?? null) : 0, signal: error?.signal ?? null, stdout, stderr }),
    ),
  );

test('GPU package scripts serve repository fixtures from the repository root', { timeout: HANG_BOUND_MS }, async () => {
  for (const directory of ['scene', 'worker']) {
    const packageRoot = fileURLToPath(new URL(`../packages/${directory}/`, import.meta.url));
    const root = resolve(packageRoot, '../..');
    const { scripts } = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    for (const name of Object.keys(scripts).filter((name) => /^test:(gpu|browser)(:|$)/.test(name))) {
      const script = scripts[name];
      if (directory === 'scene')
        assert.match(script, /--compat\b/, `${name} must also cover the compatibility backend`);
      const entry = /\bnode (\S+)/.exec(script)?.[1];
      assert.ok(entry, `${name} must launch its browser fixture`);
      // Execute the actual command's directory setup, replacing only the browser process with a cwd probe.
      const probe = script.replace(/\bnode .*$/, `"${process.execPath}" -p "process.cwd()"`);
      const result = await shell(probe, packageRoot);
      assert.equal(result.code, 0, `${name}: ${JSON.stringify(result)}`);
      const servedRoot = result.stdout.trim();
      assert.equal(resolve(servedRoot), root, name);
      assert.ok(existsSync(resolve(servedRoot, entry)), `${name} must resolve its fixture entry`);
      assert.ok(
        existsSync(resolve(servedRoot, 'tests/modern-extension.html')),
        `${name} must serve the requested page`,
      );
    }
  }
});
