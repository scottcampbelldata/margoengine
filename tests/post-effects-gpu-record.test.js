// Known bug (2026-11-12, lane K1c): post's GPU check test:gpu:flare rewrote the tracked
// examples/package-benchmarks/results/flare-gpu.json on every passing run (the machine, date and commit of the run
// replaced the RTX A6000 record packages/post/README.md cites), so a lane's tree was no longer clean after its gate.
// examples/package-benchmarks/post-effects-gpu.mjs wrote results/<section>-gpu.json after every section, with no flag
// that separates recording from checking. Now only --record writes the tracked record; a plain run writes
// test-results/. Checked on the plan of the writes and the script's text: no GPU, no browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..'),
  script = 'examples/package-benchmarks/post-effects-gpu.mjs',
  source = readFileSync(join(root, script), 'utf8');
const tracked = (path) =>
  execFileSync('git', ['ls-files', '--', path], { cwd: root, encoding: 'utf8' }).trim() === path;
const ignored = (path) => {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: root });
    return true;
  } catch {
    return false;
  }
};
/** The arguments post's package.json passes to the script for test:gpu:flare. */
const flareArgs = () => {
  const command = JSON.parse(readFileSync(join(root, 'packages/post/package.json'), 'utf8')).scripts['test:gpu:flare'];
  const at = command.indexOf(script);
  assert.ok(at >= 0, `test:gpu:flare runs ${script}: ${command}`);
  return command
    .slice(at + script.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
};

test('the script writes no report path of its own: every section report goes through sectionReport', () => {
  assert.doesNotMatch(source, /writeFileSync\(\s*[`'"]examples\/package-benchmarks\/results\//);
  assert.doesNotMatch(source, /writeFileSync\(\s*resolve\([^)]*results\//);
  assert.match(source, /import \{ sectionReport \} from '\.\/post-effects-output\.mjs';/);
  const writes = [...source.matchAll(/writeFileSync\(\s*([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual(writes, ['out.path']);
  assert.match(source, /const out = sectionReport\(name\);/);
});

test("post's test:gpu:flare plans its report outside the tracked record; --record writes the record", async () => {
  const { sectionReport } = await import('../examples/package-benchmarks/post-effects-output.mjs');
  const args = flareArgs();
  assert.deepEqual(args, ['--only=flare']);
  const check = sectionReport('flare', ['node', script, ...args]);
  assert.deepEqual(check, { record: false, path: 'test-results/post-flare-gpu.json' });
  assert.equal(tracked(check.path), false);
  assert.equal(ignored(check.path), true, `${check.path} is ignored by git, so a check run leaves the tree clean`);
  const record = sectionReport('flare', ['node', script, ...args, '--record']);
  assert.deepEqual(record, { record: true, path: 'examples/package-benchmarks/results/flare-gpu.json' });
  assert.equal(tracked(record.path), true);
  for (const name of ['gtao', 'ssgi', 'motion', 'ssr-surfaces']) {
    assert.equal(tracked(sectionReport(name, ['node', script, '--record']).path), true, name);
    assert.equal(tracked(sectionReport(name, ['node', script]).path), false, name);
  }
});
