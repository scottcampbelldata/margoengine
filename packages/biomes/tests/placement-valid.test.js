// The checks of bench/placement-valid.mjs that decide whether a G1 measurement counts: repetition, spread, outputs,
// lock, quiet gate and host. Pure functions only: nothing here takes the GPU lock or times anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE,
  MIN_RUNS,
  OWNER,
  TARGETS,
  caseFailures,
  conditionFailures,
  g1,
  summarize,
} from '../bench/placement-valid.mjs';

const steady = (median, n = MIN_RUNS) => Array.from({ length: n }, (_, i) => median * (1 + ((i % 5) - 2) / 100));
const gate = (extra = {}) => ({
  ac: true,
  lock: { mode: 'exclusive', pid: 7, owner: OWNER },
  quiet: { cpuLoadPercent: 4, gpu: { checked: true, utilizationPercent: [0, 1, 0] } },
  ...extra,
});
const host = { gpu: [{ name: 'NVIDIA RTX A6000' }] };
const good = { gate: gate(), lockAtEnd: { mode: 'exclusive', pid: 7, owner: OWNER }, pid: 7, host };

test('summarize gives median, min, max and spread over the median', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { n: 4, median: 2.5, min: 1, max: 4, spread: 1.2 });
  assert.equal(summarize([5, 1, 3]).median, 3);
});

test('a case of 20 steady samples with one output is valid', () => {
  assert.deepEqual(caseFailures('cpu', { samples: steady(300), digests: Array(MIN_RUNS).fill('a') }), []);
});

test('fewer than 20 samples fail, whatever --runs asked for', () => {
  assert.match(caseFailures('x', { samples: steady(300, 19) }, { runs: 5 }).join(), /19 samples, need 20/);
  assert.match(caseFailures('x', { samples: steady(300, 20) }, { runs: 25 }).join(), /20 samples, need 25/);
});

test('a spread over 10% fails; 10% exactly passes', () => {
  const at = (top) => [...Array(MIN_RUNS - 1).fill(100), top];
  assert.deepEqual(caseFailures('x', { samples: at(110) }), []);
  assert.match(caseFailures('x', { samples: at(111) }).join(), /spread 11\.0% over the 10% limit/);
});

test('a sample that is not a positive finite time fails', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const samples = steady(100);
    samples[3] = bad;
    assert.match(caseFailures('x', { samples }).join(), /not a positive finite time/);
  }
  assert.deepEqual(caseFailures('x', undefined), ['x: no samples']);
});

test('samples that placed different objects fail', () => {
  const digests = Array(MIN_RUNS).fill('a');
  digests[9] = 'b';
  assert.match(caseFailures('x', { samples: steady(100), digests }).join(), /different objects/);
});

test('good conditions pass; a wrapping gpu-lock run counts as holding the lock', () => {
  assert.deepEqual(conditionFailures(good), []);
  const held = { held: 'by the wrapping gpu-lock run' };
  assert.deepEqual(conditionFailures({ ...good, gate: gate({ lock: held }), lockAtEnd: held }), []);
});

test('the lock must be this run, exclusive, at the start and at the end', () => {
  assert.match(
    conditionFailures({ ...good, gate: gate({ lock: null }) }).join(),
    /not held by this run when timing started/,
  );
  const other = { mode: 'exclusive', pid: 8, owner: OWNER };
  assert.match(conditionFailures({ ...good, lockAtEnd: other }).join(), /when timing ended/);
  const shared = { mode: 'shared', pid: 7, owner: OWNER };
  assert.match(conditionFailures({ ...good, gate: gate({ lock: shared }) }).join(), /timing started/);
});

test('battery, a skipped or loud CPU gate, an unread or busy GPU and another host all fail', () => {
  const failing = [
    [{ gate: gate({ ac: false }) }, /on battery/],
    [{ gate: gate({ quiet: { skipped: true } }) }, /quiet gate did not run/],
    [{ gate: gate({ quiet: { cpuLoadPercent: GATE.quietMax + 1, gpu: { checked: true } } }) }, /CPU 21% at the gate/],
    [{ gate: gate({ quiet: { cpuLoadPercent: 3, gpu: { checked: false } } }) }, /could not read GPU load/],
    [
      { gate: gate({ quiet: { cpuLoadPercent: 3, gpu: { checked: true, busy: true, utilizationPercent: [90] } } }) },
      /GPU busy/,
    ],
    [{ settles: [{ case: 'current:cpu', ac: true, cpuLoadPercent: 55 }] }, /CPU 55% before current:cpu/],
    [{ settles: [{ case: 'current:cpu', ac: false, cpuLoadPercent: 2 }] }, /on battery before current:cpu/],
    [{ host: { gpu: [{ name: 'Intel Arc' }] } }, /not the A6000 host/],
  ];
  for (const [change, why] of failing) assert.match(conditionFailures({ ...good, ...change }).join(), why);
  assert.deepEqual(conditionFailures({ ...good, host: { gpu: [] }, anyHost: true }), []);
});

test('G1 sums fields and objects for one thread and reads the eight-worker block; a miss is targetMet false', () => {
  const cases = {
    fields: { samples: steady(430) },
    placement: { samples: steady(250) },
    workers8: { samples: steady(120) },
  };
  assert.deepEqual(g1(cases), { oneThread: 680, eightWorkers: 120, targets: TARGETS, targetMet: false });
  const met = {
    fields: { samples: steady(200) },
    placement: { samples: steady(150) },
    workers8: { samples: steady(60) },
  };
  assert.equal(g1(met).targetMet, true);
  assert.equal(g1({}).targetMet, false);
});
