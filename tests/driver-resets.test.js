// Bug 25 (2026-10-28): GPU driver resets on the RTX A6000 PC (nvlddmkm event 153) took the WebGPU device of whichever
// page was using the GPU, and the next page to ask for one got "D3D12 create command queue failed with E_OUTOFMEMORY".
// The failure said nothing about the reset, and a whole check:merge was lost to it. scripts/support/driver-resets.mjs
// reads the resets from the Windows event log; the checks name them and run a failed step once more after one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeResets,
  driverResets,
  dumpTime,
  parseResets,
  resetQueryScript,
  retryAfterDriverReset,
} from '../scripts/support/driver-resets.mjs';

const line = (entry) => JSON.stringify(entry);
const nvidia = { at: '2026-10-28T05:21:49.188Z', source: 'nvlddmkm', id: 153, detail: 'Error occurred on GPUID: 100' };

test('an NVIDIA reset in the System log is a reset; other WER reports and Display events are not', () => {
  const text = [
    line(nvidia),
    line({ at: '2026-10-28T05:21:50.000Z', source: 'LiveKernelEvent', id: '1b8', detail: '' }), // not a GPU watchdog
    line({ at: '2026-10-28T05:21:51.000Z', source: 'Display', id: 4102, detail: '' }), // not "stopped responding"
    'not json',
    '',
  ].join('\r\n');
  assert.deepEqual(parseResets(text), [{ ...nvidia, id: '153' }]);
});

test('a watchdog dump counts once, at the time in its name, and only inside the window', () => {
  // Windows Error Reporting files the same dump again at every upload attempt, hours later.
  const written = dumpTime('WATCHDOG-20261028-0208.dmp');
  assert.equal(written.getHours(), 2);
  assert.equal(written.getMinutes(), 8);
  const report = (at, dump) => line({ at, source: 'LiveKernelEvent', id: '141', detail: dump });
  const since = new Date(written.getTime() - 5 * 60_000),
    until = new Date(written.getTime() + 5 * 60_000);
  const text = [
    report(new Date(written.getTime() + 36_000).toISOString(), 'WATCHDOG-20261028-0208.dmp'),
    report(new Date(written.getTime() + 39_000).toISOString(), 'WATCHDOG-20261028-0208.dmp'), // filed again
    report(new Date(written.getTime() + 39_000).toISOString(), 'WATCHDOG-20261027-2304.dmp'), // an old one, filed again
  ].join('\n');
  const resets = parseResets(text, { since, until });
  assert.equal(resets.length, 1);
  assert.equal(resets[0].at, written.toISOString());
  assert.match(describeResets(resets), /Windows GPU watchdog report LiveKernelEvent 141 at 02:08:00/);
});

test('the event log is read only on Windows, and the query is read only and covers every GPU vendor', () => {
  let ran = 0;
  const run = () => {
    ran++;
    return line(nvidia);
  };
  assert.deepEqual(driverResets({ since: 0, platform: 'linux', run }), []);
  assert.equal(ran, 0);
  assert.equal(
    driverResets({ since: '2026-10-28T05:21:00Z', until: '2026-10-28T05:22:00Z', platform: 'win32', run }).length,
    1,
  );
  const script = resetQueryScript('2026-10-28T05:21:00.000Z', '2026-10-28T05:22:00.000Z');
  for (const name of ['nvlddmkm', 'amdkmdag', 'igfx', 'Display', 'LiveKernelEvent'])
    assert.ok(script.includes(name), name);
  assert.doesNotMatch(script, /Set-|Remove-|Clear-|New-Item|wevtutil/);
});

test('the reset is named in plain words; a log that cannot be read is said so and is not a reset', () => {
  assert.equal(
    describeResets([{ ...nvidia, at: new Date(2026, 9, 28, 1, 21, 49).toISOString() }]),
    'GPU driver reset in the Windows event log: nvlddmkm event 153 at 01:21:49',
  );
  assert.equal(describeResets([]), null);
  assert.match(
    describeResets([{ source: 'lookup', id: 'failed', at: nvidia.at, detail: 'access denied' }]),
    /could not be read \(access denied\), so a GPU reset cannot be confirmed/,
  );
});

const quiet = { settleMs: 0, log: () => {} };

test('a step that fails during a logged reset runs once more, and the reset stays in the result and the log', async () => {
  const lines = [];
  let runs = 0;
  const result = await retryAfterDriverReset('sciviz test:browser', async () => ({ ok: ++runs === 2 }), {
    ...quiet,
    lookup: () => [{ ...nvidia, id: '153' }],
    log: (l) => lines.push(l),
  });
  assert.equal(runs, 2);
  assert.equal(result.ok, true);
  assert.equal(result.driverReset.rerunOk, true);
  assert.equal(result.driverReset.firstRun.ok, false);
  assert.match(
    lines.join('\n'),
    /GPU RESET: sciviz test:browser failed during a GPU driver reset .*nvlddmkm event 153/,
  );
  assert.match(lines.join('\n'), /the rerun of sciviz test:browser passed/);
});

test('only once: a step that fails again after a reset fails', async () => {
  let runs = 0;
  const result = await retryAfterDriverReset('visual:check', async () => ({ ok: (runs++, false) }), {
    ...quiet,
    lookup: () => [{ ...nvidia, id: '153' }],
  });
  assert.equal(runs, 2);
  assert.equal(result.ok, false);
  assert.equal(result.driverReset.rerunOk, false);
});

test('a failure with no logged reset is not retried, and a pass is not looked up', async () => {
  let runs = 0,
    lookups = 0;
  const lookup = () => (lookups++, []);
  assert.equal(
    (await retryAfterDriverReset('a', async () => ({ ok: (runs++, false) }), { ...quiet, lookup })).ok,
    false,
  );
  assert.equal(runs, 1);
  assert.equal(lookups, 1);
  assert.equal((await retryAfterDriverReset('b', async () => ({ ok: (runs++, true) }), { ...quiet, lookup })).ok, true);
  assert.equal(runs, 2);
  assert.equal(lookups, 1);
  // A log that cannot be read confirms nothing: no rerun.
  const failed = () => [{ source: 'lookup', id: 'failed', at: nvidia.at, detail: 'denied' }];
  assert.equal(
    (await retryAfterDriverReset('c', async () => ({ ok: (runs++, false) }), { ...quiet, lookup: failed })).ok,
    false,
  );
  assert.equal(runs, 3);
});

test('the lookup covers the whole step, from just before it started', async () => {
  let window;
  const start = new Date('2026-10-28T05:20:00Z'),
    end = new Date('2026-10-28T05:22:00Z');
  let calls = 0;
  await retryAfterDriverReset('x', async () => ({ ok: false }), {
    ...quiet,
    now: () => (calls++ === 0 ? start : end),
    lookup: (w) => ((window = w), []),
  });
  assert.ok(window.since <= start && start - window.since <= 10_000);
  assert.equal(window.until.getTime(), end.getTime());
});

// A run that passed only on a rerun after a reset read exactly like a clean pass (coordinator, 2026-10-28): the summary
// now ends with a marked warning per rerun step, and both result files carry `passedAfterDriverReset`.
test('a check:merge pass after a reset rerun is marked in the summary and the JSON flag; a clean pass is not', async () => {
  const { summary } = await import('../scripts/check-merge.mjs');
  const reset = { resets: [nvidia], rerunOk: true };
  const clean = summary({ results: [{ command: 'npm run verify', ok: true }], seconds: 9 });
  assert.equal(clean.passedAfterDriverReset, false);
  assert.deepEqual(clean.lines, ['PASSED in 9 s']);
  const rerun = summary({
    results: [
      { command: 'npm run verify', ok: true },
      { command: 'npm run visual:check', ok: true, driverReset: reset },
      {
        command: 'npm run check:gpu-packages -- --no-build',
        ok: true,
        driverResetTests: [{ label: 'sciviz test:browser', ok: true, driverReset: reset }],
      },
    ],
    seconds: 12,
  });
  assert.equal(rerun.passedAfterDriverReset, true);
  const at = new Date(nvidia.at).toLocaleTimeString('en-GB', { hour12: false });
  assert.ok(rerun.lines.includes(`PASSED WITH A DRIVER RESET: npm run visual:check, ${describeResets([nvidia])}`));
  assert.ok(
    rerun.lines.includes(
      `PASSED WITH A DRIVER RESET: npm run check:gpu-packages -- --no-build > sciviz test:browser, ${describeResets([nvidia])}`,
    ),
  );
  assert.match(rerun.lines.join('\n'), new RegExp(`nvlddmkm event 153 at ${at}`));
  assert.match(rerun.lines.at(-1), /^PASSED WITH A DRIVER RESET in 12 s: 2 reruns after a GPU driver reset/);
  // A failed rerun fails the run: no pass warning and no flag, only the reset and the failure.
  const failed = summary({
    results: [{ command: 'npm run visual:check', ok: false, driverReset: { resets: [nvidia], rerunOk: false } }],
    failed: 'npm run visual:check',
    seconds: 5,
  });
  assert.equal(failed.passedAfterDriverReset, false);
  assert.ok(!failed.lines.some((l) => l.startsWith('PASSED')));
  assert.equal(failed.lines.at(-1), 'FAILED at npm run visual:check in 5 s');
});

test('check:gpu-packages writes passedAfterDriverReset and a warning per test that passed only on its rerun', async () => {
  const { report } = await import('../scripts/gpu-package-tests.mjs');
  const reset = { resets: [nvidia], rerunOk: true };
  const clean = report([{ label: 'sciviz test:browser', ok: true }]);
  assert.deepEqual(clean.json, {
    passedAfterDriverReset: false,
    results: [{ label: 'sciviz test:browser', ok: true }],
  });
  assert.deepEqual(clean.warnings, []);
  const rerun = report([
    { label: 'scatter test:browser', ok: true },
    { label: 'sciviz test:browser', ok: true, driverReset: reset },
  ]);
  assert.equal(rerun.json.passedAfterDriverReset, true);
  assert.equal(rerun.json.results.length, 2);
  assert.deepEqual(rerun.warnings, [`PASSED WITH A DRIVER RESET: sciviz test:browser, ${describeResets([nvidia])}`]);
  // Any failure: the run failed, so nothing is marked as passed.
  const failed = report([
    { label: 'sciviz test:browser', ok: true, driverReset: reset },
    { label: 'text test:browser', ok: false },
  ]);
  assert.equal(failed.json.passedAfterDriverReset, false);
  assert.deepEqual(failed.warnings, []);
});
