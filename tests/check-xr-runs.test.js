import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { judge, OPEN_HEADING } from '../scripts/check-xr-runs.mjs';
import { XR_RUN_MIN_FRAMES, XR_RUN_TARGETS } from '../packages/shared/xr-run.js';

const record = (target, change = {}) => ({
  schema: 1,
  date: '2026-11-07T00:00:00.000Z',
  userAgent: 'device',
  native: true,
  mode: target.mode,
  route: target.route,
  features: [],
  views: 2,
  frames: XR_RUN_MIN_FRAMES,
  tracked: XR_RUN_MIN_FRAMES,
  emulated: 0,
  frameMs: { median: 14, p95: 15, max: 20 },
  inputs: [{ handedness: 'none', targetRayMode: 'screen', profiles: [], hand: false, buttons: 0, axes: 0 }],
  endedEarly: false,
  errors: [],
  observed: { scene: true, tracking: true, input: true, exit: true },
  ...change,
});
const all = XR_RUN_TARGETS.map((target) => ({ file: `${target.id}.json`, run: record(target) }));

test('no records: every route is open, and known-bugs must say so', () => {
  assert.equal(judge([], OPEN_HEADING).open.length, XR_RUN_TARGETS.length);
  assert.deepEqual(judge([], OPEN_HEADING).problems, []);
  assert.match(judge([], '').problems.join(), /has no ".*" entry/);
});

test('a stand-in record proves nothing, however good it looks', () => {
  const runs = XR_RUN_TARGETS.map((target) => ({ file: 'x.json', run: record(target, { native: false }) })),
    { open, targets } = judge(runs, OPEN_HEADING);
  assert.equal(open.length, XR_RUN_TARGETS.length);
  assert.match(targets[0].gaps.join(), /stand-in/);
});

test('every route proven: the known-bugs entry must go', () => {
  assert.equal(judge(all, '').open.length, 0);
  assert.deepEqual(judge(all, '').problems, []);
  assert.match(judge(all, OPEN_HEADING).problems.join(), /remove/);
});

test('a malformed record is a problem and names its file', () => {
  const { problems } = judge([{ file: 'bad.json', run: { schema: 2 } }], OPEN_HEADING);
  assert.match(problems[0], /^bad\.json: schema/);
});

test('the gate passes on the repository today, and --release does not while routes are open', () => {
  assert.match(execFileSync(process.execPath, ['scripts/check-xr-runs.mjs'], { encoding: 'utf8' }), /vr-webgpu/);
  assert.equal(spawnSync(process.execPath, ['scripts/check-xr-runs.mjs', '--release']).status, 1);
});
