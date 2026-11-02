// Measures the Node test count of `npm run verify` and writes it where the public pages quote it, so the number on the
// white paper is a measured one with the commit it was measured at (audit E-07: the page said 6,373 after the count had
// moved to 6,513). Run it after `npm run build:packages`, from a clean tree:
//   node scripts/record-test-count.mjs [--commit=HEAD] [--from-log=<file>]
// It runs verify's unit-test command (PARALLEL in scripts/verify.mjs) and the two sandbox workspaces' tests, fails if any
// test failed, then rewrites examples/package-benchmarks/results/test-count.json, the statements in the white paper and in
// docs/whitepaper/claims.md. `--commit` names the commit the count is stated at: pass
// HEAD~1 when HEAD is a docs-only commit that adds no test. `--from-log` reads the "ℹ tests N" summary from a saved
// verify log instead of running the tests. scripts/support/public-truth.mjs (tests/public-truth.test.js, in verify) fails
// when a statement and the JSON differ.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { restateTestCount, TEST_COUNT_FILE, TEST_COUNT_FILES } from './support/public-truth.mjs';
import { PARALLEL } from './verify.mjs';

const root = resolve(import.meta.dirname, '..');

/** The last "ℹ tests/pass/fail/skipped/todo N" summary in node:test output, or undefined without one. */
export function parseSummary(output) {
  const pick = (name) => {
    const all = [...output.matchAll(new RegExp(`^ℹ ${name} (\\d+)\\s*$`, 'gm'))];
    return all.length ? Number(all.at(-1)[1]) : undefined;
  };
  const summary = {
    tests: pick('tests'),
    pass: pick('pass'),
    fail: pick('fail'),
    skipped: pick('skipped'),
    todo: pick('todo'),
  };
  return Object.values(summary).includes(undefined) ? undefined : summary;
}

const run = (command, ms) =>
  spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: ms,
    maxBuffer: 1 << 30,
    killSignal: 'SIGKILL',
  });

function measure(command, label, ms) {
  const result = run(command, ms),
    summary = parseSummary(`${result.stdout}\n${result.stderr}`);
  if (!summary) throw new Error(`${label}: no test summary in the output (exit ${result.status}); run ${command}`);
  if (summary.fail || result.status !== 0)
    throw new Error(
      `${label}: ${summary.fail} test(s) failed (exit ${result.status}); fix them, a failing run is not recorded`,
    );
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain', '--untracked-files=no'))
    throw new Error('the tree has uncommitted changes; commit them first so the count is for a commit');
  const commit = git('rev-parse', '--short=8', arg('commit') ?? 'HEAD'),
    nodeCommand = PARALLEL.find((chain) => chain[0].includes('--test'))[0],
    log = arg('from-log');
  const main = log
    ? parseSummary(readFileSync(log, 'utf8'))
    : measure(nodeCommand, 'the Node tests of verify', 40 * 60_000);
  if (!main || main.fail) throw new Error('the Node test summary is missing or has failures');
  const workspaces = {};
  for (const name of ['examples/gameplay-sandbox', 'examples/voxel-sandbox']) {
    const s = measure(`npm run test --workspace ${name}`, name, 10 * 60_000);
    workspaces[name] = { tests: s.tests, pass: s.pass };
  }
  const file = join(root, TEST_COUNT_FILE),
    old = JSON.parse(readFileSync(file, 'utf8')),
    record = {
      ...old,
      commit,
      date: new Date().toISOString().slice(0, 10),
      node: process.version,
      tests: main.tests,
      pass: main.pass,
      fail: main.fail,
      skipped: main.skipped,
      todo: main.todo,
      workspaces,
    };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  for (const path of TEST_COUNT_FILES) {
    const full = join(root, path),
      before = readFileSync(full, 'utf8'),
      crlf = before.includes('\r\n'),
      after = restateTestCount(before.split('\r\n').join('\n'), record, old.commit);
    if (after !== before.split('\r\n').join('\n')) writeFileSync(full, crlf ? after.split('\n').join('\r\n') : after);
  }
  console.log(
    `test count at ${commit}: ${record.tests} tests, ${record.pass} pass, ${record.skipped} skipped (was ${old.tests} at ${old.commit}); regenerate site/whitepaper/engine.pdf and site/llms-full.txt, then commit`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
