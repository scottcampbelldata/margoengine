// The --current proofs that guard the package whose tests are running (ongoing.js), run from baselines/ as verify runs
// them. Appended to a package's `test` script (`node --test ... ../../examples/package-benchmarks/proofs/package-guard.mjs`),
// so the package's CPU tests fail when a change moves a GPU call log one of them pins. Not named *.test.js: verify runs
// every proof once in its own step, and its test globs must not run them again. Needs `npm run build:packages` (the
// proofs import @margoengine/core from dist), as the package tests do.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import test from 'node:test';
import { guarding } from './ongoing.js';

const name = basename(process.cwd()),
  manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')),
  proofs = guarding(name);

test(`${manifest.name}: the --current proofs that pin its GPU calls pass`, { timeout: 15 * 60_000 }, () => {
  assert.equal(manifest.name, `@margoengine/${name}`, 'run from a package folder (its npm test script)');
  assert.ok(proofs.length, `no ongoing proof names ${name}; drop the guard from its test script or list it in ongoing.js`);
  const run = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'run.mjs'), '--current', `--only=${proofs.join(',')}`],
    { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 14 * 60_000, killSignal: 'SIGKILL' },
  );
  assert.equal(
    run.status,
    0,
    `proofs --current --only=${proofs.join(',')} failed. A changed GPU call log is a regression to fix, or an ` +
      `intended change whose golden is captured again (capture.mjs) with the reason in docs/whitepaper/claims.md:\n` +
      `${(run.stdout + run.stderr).slice(-6000)}${run.error ? `\n${run.error}` : ''}`,
  );
});
