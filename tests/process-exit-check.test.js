// KB-OWN-EXIT2: `process.exit` shuts V8's platform down while the isolate lives, so a background task waiting on a
// main-thread collection can hold the exit for ever (KB-OWN-EXIT1, nodejs/node#54918). The check
// (scripts/support/process-exit.mjs, run by hygiene) fails on a file that calls it without a `// process.exit: <reason>`
// unless scripts/support/exit-owed.json lists that file, and on a listed file that no longer does. The scripts already
// fixed are also run here through tests/support/end-recorder.js, which records whether each ended by its event loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertNoProcessExit,
  exitFailures,
  exitFiles,
  owedFiles,
  trackedScripts,
  unjustifiedExit,
} from '../scripts/support/process-exit.mjs';
import { endRecorder } from './support/end-recorder.js';

const root = resolve(import.meta.dirname, '..');

test('a call counts unless its line gives the reason; comments and strings are not calls', () => {
  assert.equal(unjustifiedExit('  process.exit(1);'), true);
  assert.equal(unjustifiedExit('if (bad) process.exit (2);\r'), true);
  assert.equal(unjustifiedExit('  process.exit(1); // process.exit: the watchdog ends a hung run'), false);
  assert.equal(unjustifiedExit('  process.exitCode = 1;'), false);
  assert.equal(unjustifiedExit('  // then process.exit(1) ended it'), false);
  assert.equal(unjustifiedExit(' * ends through process.exit(1) when'), false);
  assert.equal(unjustifiedExit("spawnSync(node, ['-e', 'process.exit(3)']);"), false);
  assert.equal(unjustifiedExit('const url = "http://x"; process.exit(1);'), true);
});

test('the owed list fails on a new file and on a listed file that no longer calls process.exit', () => {
  const texts = {
    'a.mjs': 'process.exit(1);\n',
    'b.mjs': 'process.exitCode = 1;\n',
    'c.mjs': 'x\r\nprocess.exit(0);\r\n',
  };
  const found = exitFiles(Object.keys(texts), (f) => texts[f]);
  assert.deepEqual(found, ['a.mjs', 'c.mjs']);
  assert.deepEqual(exitFailures(found, ['a.mjs', 'c.mjs']), []);
  const failures = exitFailures(found, ['a.mjs', 'b.mjs']);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /^c\.mjs calls process\.exit/);
  assert.match(failures[1], /^b\.mjs no longer calls process\.exit/);
});

test('the repository matches scripts/support/exit-owed.json exactly, and the list is sorted', () => {
  assertNoProcessExit(root);
  const owed = owedFiles(root);
  assert.deepEqual(owed, [...owed].sort());
  // The list names no script by its repository path, so the steps that read it do not take on the scripts it lists.
  const named = [
    ...readFileSync(join(root, 'scripts/support/exit-owed.json'), 'utf8').matchAll(
      /"((?:scripts|tests|examples|bench|tools)\/[^"]*)"/g,
    ),
  ].map(([, path]) => path);
  assert.deepEqual(
    named.filter((path) => existsSync(join(root, path))),
    [],
  );
  assert.ok(trackedScripts(root).includes('scripts/support/process-exit.mjs'));
});

test('the fixed check scripts end by their event loop, passing or failing', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'process-exit-checks-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { env, lines } = endRecorder(folder);
  // Each runs its whole check on the repository; whether it passes is that check's business (check:wall-budgets and
  // check:fixed-waits are tested elsewhere), but it must end by its event loop with the code it set.
  const scripts = [
    'scripts/check-rapier-parity.mjs',
    'scripts/check-parity-table.mjs',
    'scripts/errors/page.mjs',
    'scripts/generate-all-entries.mjs',
    'scripts/umbrella.mjs',
    'scripts/supply-chain.mjs',
    'scripts/check-xr-runs.mjs',
    'scripts/check-film-time.mjs',
    'scripts/check-wall-budgets.mjs',
    'scripts/check-fixed-waits.mjs',
    'scripts/codemod-react-subpaths.mjs',
    'scripts/codemod-stage-loaders.mjs',
  ];
  for (const [i, script] of scripts.entries()) {
    // The checks that write when not asked to check get --check; the marker argument names the run in the record.
    const write = /errors\/page|generate-all-entries|umbrella|supply-chain|codemod-/.test(script);
    const ran = spawnSync(process.execPath, [join(root, script), `--run=${i}`, ...(write ? ['--check'] : [])], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const end = lines().find((line) => line.startsWith(`--run=${i} `));
    assert.equal(end, `--run=${i} loop ${ran.status}`, `${script} did not end by its event loop`);
  }
});

// KB-OWN-EXIT2 part 3: check-dev-servers, library-index and mutation run here on the paths that end at once (the
// server list, the usage line, a missing target); record-wgsl-corpus and site-check run whole GPU suites or a served
// site, and quickstart-timing's watchdog keeps its call with the reason, so their one-line changes are read, not run.
test('the part 3 scripts end by their event loop with the code they set', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'process-exit-part3-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { env, lines } = endRecorder(folder);
  // The recorder names a run by its first argument; library-index's usage path is the one with no argument at all.
  const runs = [
    ['scripts/check-dev-servers.mjs', ['--run=0', '--list'], '--run=0', 0],
    ['tools/library-index.mjs', [], 'undefined', 2],
    ['scripts/mutation.mjs', ['--run=2'], '--run=2', 1],
  ];
  for (const [script, args, verb, code] of runs) {
    const ran = spawnSync(process.execPath, [join(root, script), ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(ran.status, code, `${script}: ${ran.stderr}`);
    const end = lines().find((line) => line.startsWith(`${verb} `));
    assert.equal(end, `${verb} loop ${code}`, `${script} did not end by its event loop`);
  }
});

test('the fixed gate scripts end by their event loop with their exit codes', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'process-exit-end-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { env, lines } = endRecorder(folder);
  const run = (script, args) =>
    spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
  // quality: a stray argument and a --reason without one gate are usage errors (exit 2), found before any gate runs.
  assert.equal(run('scripts/quality-gate.mjs', ['sizes']).status, 2);
  assert.equal(run('scripts/quality-gate.mjs', ['--reason=x']).status, 2);
  // check:wgsl: a package with no WGSL source has nothing to compile (exit 0), and opens no browser.
  const wgsl = run('scripts/check-wgsl.mjs', ['--packages=no-such-package']);
  assert.equal(wgsl.status, 0, wgsl.stderr);
  const ends = lines();
  assert.ok(ends.includes('sizes loop 2'), `quality did not end by its event loop: ${ends.join(' | ')}`);
  assert.ok(ends.includes('--reason=x loop 2'), `quality did not end by its event loop: ${ends.join(' | ')}`);
  assert.ok(
    ends.includes('--packages=no-such-package loop 0'),
    `check:wgsl did not end by its event loop: ${ends.join(' | ')}`,
  );
});

// KB-OWN-EXIT2 part 4: a benchmark entry wraps its body in `if (!deferSpeedEntry(url, label)) { ... }`
// (scripts/support/speed-phase.mjs), so a deferred run skips the body and ends by its event loop with code 0, where the
// old prologue called process.exit(0). Every entry in the repository runs here deferred; the count guards the search.
test('every deferred speed entry ends by its event loop with code 0', { timeout: 300_000 }, async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'process-exit-speed-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { env, lines } = endRecorder(folder, { ...process.env, MARGO_SPEED_PHASE: 'deferred' });
  const entries = trackedScripts(root).filter(
    (file) =>
      /^(bench|scripts|examples|packages)\//.test(file) &&
      /\bdeferSpeedEntry\(import\.meta\.url, /.test(readFileSync(join(root, file), 'utf8')),
  );
  assert.ok(entries.length >= 61, `only ${entries.length} speed entries found`);
  const run = (file, i) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [join(root, file), `--run=${i}`], { cwd: root, env, windowsHide: true });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      const limit = setTimeout(() => child.kill(), 120_000);
      child.on('close', (code) => {
        clearTimeout(limit);
        done({ file, i, code, out });
      });
    });
  const results = [];
  for (let next = 0; next < entries.length; next += 8)
    results.push(...(await Promise.all(entries.slice(next, next + 8).map((file, k) => run(file, next + k)))));
  const ends = lines();
  for (const { file, i, code, out } of results) {
    assert.equal(code, 0, `${file}: ${out}`);
    assert.match(out, /SPEED DEFERRED: /, file);
    assert.ok(ends.includes(`--run=${i} loop 0`), `${file} did not end by its event loop: ${ends.join(' | ')}`);
  }
});

test('bench --list, which runs while speed is deferred, ends by its event loop', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'process-exit-bench-list-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { env, lines } = endRecorder(folder);
  const ran = spawnSync(process.execPath, [join(root, 'bench/cli.mjs'), '--list'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^Suites /);
  assert.deepEqual(lines(), ['--list loop 0']);
});

// KB-OWN-EXIT2 part 8: the test stand-ins set the exit code their caller reads and end by their event loop. The
// rendezvous fixture is run on its own, alone past its 20 s wait (code 3); the recorder names a run by its directory.
test('the rendezvous fixture ends by its event loop when it is left alone', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'process-exit-part8-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { env, lines } = endRecorder(folder);
  const dir = join(folder, 'starts');
  const ran = spawnSync(process.execPath, [join(root, 'tests/fixtures/rendezvous.mjs'), dir, '2'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(ran.status, 3, ran.stderr);
  assert.equal(ran.stdout.trim(), 'alone');
  assert.deepEqual(lines(), [`${dir} loop 3`]);
});
