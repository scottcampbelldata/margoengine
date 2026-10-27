// The fresh-clone check's verdict on a proof-runner run (scripts/fresh-clone-check.mjs): a fresh clone of main once failed
// `npm run verify` because 14 of the 20 --current proofs rebuilt their baselines with `git rev-parse` / `git show` on
// commits only one PC's pre-rewrite history held. Every way that showed up, or could show up, must count as a problem.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MISSING_HISTORY, problems } from '../scripts/fresh-clone-check.mjs';

const summary = (pass, historical, fail) => `\n${pass} pass, ${historical} historical, ${fail} fail in 0.3 min\n`;
const row = (name, result, note = '') => `${name.padEnd(24)} 57250a49 -> tree       ${result.padEnd(10)} 0   ${note}`;

test('a clean run has no problems', () => {
  assert.deepEqual(problems(row('post-stack', 'PASS') + summary(1, 0, 0), 0), []);
});

test('the failure the fresh clone hit: a proof that cannot resolve its baseline commit', () => {
  const out =
    row('post-stack', 'FAIL', 'Error: Command failed: git rev-parse --verify 57250a49^{commit}') +
    '\nfatal: Needed a single revision\n' +
    summary(0, 0, 1);
  const found = problems(out, 1);
  assert.ok(found.includes('the proof runner exited 1'), found.join('\n'));
  assert.ok(found.includes('post-stack: FAIL'), found.join('\n'));
  assert.ok(
    found.some((line) => line.startsWith('missing history:')),
    found.join('\n'),
  );
});

test('HISTORICAL fails --current (an ongoing guarantee always runs) and is allowed for pinned claims', () => {
  const out =
    row('procedural-deps', 'HISTORICAL', 'needs an install') + '\n' + row('water-ssr', 'HISTORICAL') + summary(0, 2, 0);
  assert.deepEqual(problems(out, 0), [
    'procedural-deps: HISTORICAL in --current (an ongoing guarantee must always run)',
    'water-ssr: HISTORICAL in --current (an ongoing guarantee must always run)',
  ]);
  const pinned =
    row(
      'lines-perspective',
      'HISTORICAL',
      'lines-perspective is pinned to 96edc75, a commit only in the pre-rewrite history',
    ) + summary(0, 1, 0);
  assert.deepEqual(problems(pinned, 0, true), []);
  assert.deepEqual(problems(row('geometry', 'FAIL') + summary(0, 0, 1), 1, true), [
    'the proof runner exited 1',
    'geometry: FAIL',
  ]);
});

test('missing-history messages count even when the runner exits 0', () => {
  for (const message of [
    'Error: post-stack --current asked Git for 57250a49; a --current run reads its baseline from baselines/ only',
    'AssertionError: golden: no stored baseline for water-ssr (--current against 57250a49); capture it ...',
    'HISTORICAL: lines-perspective is pinned to 2d192a71, a commit only in the pre-rewrite history (this clone ...',
    'fatal: bad object 6c20076d',
    'packages/math/src/mat4.ts does not exist at 2484971',
  ]) {
    assert.match(message, MISSING_HISTORY);
    assert.equal(problems(`${message}\n${summary(1, 0, 0)}`, 0).length, 1, message);
  }
});

test('no summary line (the runner crashed before its table) is a problem', () => {
  assert.deepEqual(problems('', 0), ['the proof runner printed no summary']);
});
