import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = '.lane/p/current-step-profile-v1';
const r = JSON.parse(readFileSync(root + '/results-v2.json'));
assert.equal(r.failure, null);
assert.equal(r.browsers.length, 2);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y), t = (s.length - 1) * p, l = Math.floor(t); return s[l] + (s[Math.ceil(t)] - s[l]) * (t - l); };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const stats = (a) => ({ n: a.length, min: Math.min(...a), q1: q(a, .25), median: q(a, .5), q3: q(a, .75), iqr: q(a, .75) - q(a, .25), max: Math.max(...a), range: Math.max(...a) - Math.min(...a), mean: sum(a) / a.length });
const unique = (a) => [...new Set(a)];
const summary = {
  source: root + '/results-v2.json', sourceSha256: createHash('sha256').update(readFileSync(root + '/results-v2.json')).digest('hex'),
  sourceManifest: root + '/manifest.json', artifacts: r.artifacts,
  scope: 'Matched complete-step profile of current finite-trim physics. Busy diagnostic; instrumentation and export reads can alter optimizer/layout/cache behavior. Absolute instrumented phase costs are not an unmodified production-step speed claim.',
  method: r.method, aggregateCpuBusyPercent: r.aggregateCpuBusyPercent,
  accuracy: 'Both artifacts pass shipped checks0/1/2 and full3 explicit u64 pins. Node100-step and every measured browser-step full public body/contact/cache state and public work fingerprint match. All measured visits retain5050awake.',
  originalFailedAttempt: { file: root + '/results.json', correction: root + '/harness-u64-regression.json', cause: 'Wasm i64 signed BigInt was formatted without u64 normalization; failure occurred before timed samples. Modules and physical assertions were unchanged.' },
  clockCaveat: 'Clock-loop minus empty-loop cost is approximate. The black_box empty loop includes int-to-f64/checksum work that differs from the imported-clock loop; neither subtraction nor adjacent-phase attribution isolates import cost. Raw phases and raw calibration samples are retained, no exact deconvolution is claimed.',
  browsers: [],
};
for (const b of r.browsers) {
  const control = [], instrumented = [], pairs = [];
  for (const round of b.rounds) {
    const c = round.runs.find((x) => x.name === 'control'), i = round.runs.find((x) => x.name === 'instrumented');
    assert.equal(c.samples.length, 40); assert.equal(i.samples.length, 40);
    control.push(...c.samples.map((s) => ({ round: round.round, ...s })));
    instrumented.push(...i.samples.map((s) => ({ round: round.round, ...s })));
    pairs.push({ round: round.round, order: round.order, controlMin: Math.min(...c.samples.map((s) => s.elapsed)), instrumentedMin: Math.min(...i.samples.map((s) => s.elapsed)) });
  }
  const total = sum(instrumented.map((s) => s.elapsed));
  const selected = instrumented.reduce((a, b) => b.elapsed < a.elapsed ? b : a);
  const calibration = {
    importedLoopMs: stats(b.calibration.map((s) => s.clock.elapsed)),
    emptyLoopMs: stats(b.calibration.map((s) => s.empty.elapsed)),
    rawDifferencePerCallMs: stats(b.calibration.map((s) => (s.clock.elapsed - s.empty.elapsed) / s.n)),
    clampedApproximateDifferencePerCallMs: stats(b.calibration.map((s) => s.estimatedImportMs)),
    directImportedLoopPerCallMs: stats(b.calibration.map((s) => s.clock.elapsed / s.n)),
  };
  const estimate = calibration.clampedApproximateDifferencePerCallMs.median;
  const phases = r.phases.map((name, i) => {
    const values = instrumented.map((s) => s.phases[i]);
    const elapsedSum = sum(values);
    return { name, rawMs: stats(values), elapsedSum, shareOfOuterTotalPercent: 100 * elapsedSum / total, meanEntries: sum(instrumented.map((s) => s.entries[i])) / instrumented.length, entriesSeen: unique(instrumented.map((s) => s.entries[i])), selectedMinimumWholeStepMs: selected.phases[i] };
  });
  summary.browsers.push({
    browser: b.name, version: b.version, crossOriginIsolated: b.crossOriginIsolated, checks: b.checks,
    wholeStep: { controlAllSamples: stats(control.map((s) => s.elapsed)), instrumentedAllSamples: stats(instrumented.map((s) => s.elapsed)), controlRoundMinima: stats(pairs.map((s) => s.controlMin)), instrumentedRoundMinima: stats(pairs.map((s) => s.instrumentedMin)), instrumentedOverControlRoundMinima: stats(pairs.map((s) => s.instrumentedMin / s.controlMin)), pairedRoundMinima: pairs },
    calibration,
    clockCallsSeen: unique(instrumented.map((s) => s.clockCalls)),
    estimatedAllClockImportsMs: stats(instrumented.map((s) => estimate * s.clockCalls)),
    estimatedClosedIntervalClockCostMs: stats(instrumented.map((s) => estimate * sum(s.entries))),
    residualMs: stats(instrumented.map((s) => s.outerMinusPhaseSum)),
    phaseSumMs: stats(instrumented.map((s) => s.phaseSum)),
    outerElapsedSumMs: total,
    rawPhaseSumOfAllSamplesMs: sum(instrumented.map((s) => s.phaseSum)),
    phases,
    selectedMinimumWholeStep: selected,
    runtimeCounts: r.countNames.map((name, i) => ({ name, valuesSeen: unique(instrumented.map((s) => s.counts[i])) })),
    publicCounts: r.publicCountNames.map((name, i) => ({ name, valuesSeen: unique(instrumented.map((s) => s.publicCounts[i])) })),
  });
}
writeFileSync(root + '/summary.json', JSON.stringify(summary, null, 2) + '\n');
let md = '# Complete checked-step profile: current finite trim\n\n' + summary.scope + '\n\n';
md += `Aggregate host CPU busy was ${summary.aggregateCpuBusyPercent.toFixed(4)}%. These absolute whole-step times must remain separate from the original browser benchmark rows.\n\n`;
md += summary.accuracy + '\n\n' + summary.clockCaveat + '\n\n';
md += 'All values below are milliseconds. Phase shares use the sum over320 actual instrumented steps divided by the sum of those same320 outer elapsed times. Phase means/medians are not an additive minimum step. The selected vector belongs to the named real complete step.\n\n';
for (const b of summary.browsers) {
  const s = b.selectedMinimumWholeStep;
  md += `## ${b.browser} ${b.version}\n\n`;
  md += `Control/instrumented minimum complete step: ${b.wholeStep.controlAllSamples.min.toFixed(6)} / ${b.wholeStep.instrumentedAllSamples.min.toFixed(6)}. Median paired round-minimum ratio: ${b.wholeStep.instrumentedOverControlRoundMinima.median.toFixed(6)} (Q1 ${b.wholeStep.instrumentedOverControlRoundMinima.q1.toFixed(6)}, Q3 ${b.wholeStep.instrumentedOverControlRoundMinima.q3.toFixed(6)}).\n\n`;
  md += `There are ${b.clockCallsSeen.join(', ')} imported clock calls per instrumented step. The approximate clock-minus-empty median cost per call is ${(b.calibration.clampedApproximateDifferencePerCallMs.median * 1e6).toFixed(3)} ns, estimated all-call cost ${b.estimatedAllClockImportsMs.median.toFixed(6)} ms. The observed outer-minus-phase-sum residual median is ${b.residualMs.median.toFixed(6)} ms (range ${b.residualMs.min.toFixed(6)} to ${b.residualMs.max.toFixed(6)}). No clock or layout cost is silently subtracted.\n\n`;
  md += `Selected real minimum step: round ${s.round}, sample ${s.sample}, world step ${s.worldStep}, outer ${s.elapsed.toFixed(6)}, phase sum ${s.phaseSum.toFixed(6)}, residual ${s.outerMinusPhaseSum.toFixed(6)}.\n\n`;
  md += '| Phase | Mean ms | Median ms | Share of outer total | Selected real step ms | Entries/step |\n|---|---:|---:|---:|---:|---:|\n';
  for (const p of b.phases) md += `| ${p.name} | ${p.rawMs.mean.toFixed(6)} | ${p.rawMs.median.toFixed(6)} | ${p.shareOfOuterTotalPercent.toFixed(3)}% | ${p.selectedMinimumWholeStepMs.toFixed(6)} | ${p.entriesSeen.join(',')} |\n`;
  md += '\nRuntime count values: ' + b.runtimeCounts.map((c) => c.name + '=' + c.valuesSeen.join('/')).join(', ') + '.\n\n';
  md += 'Public count values: ' + b.publicCounts.map((c) => c.name + '=' + c.valuesSeen.join('/')).join(', ') + '.\n\n';
}
md += 'Original attempt and its failure log remain intact. The only correction was signed Wasm i64-to-u64 hexadecimal normalization, verified by directed assertions for all three pins. No physics module, fixture, settings, hash expectation or accuracy predicate changed.\n';
writeFileSync(root + '/summary.md', md);
console.log(JSON.stringify(summary.browsers.map((b) => ({ browser: b.browser, controlMin: b.wholeStep.controlAllSamples.min, instrumentedMin: b.wholeStep.instrumentedAllSamples.min, perturbationMedian: b.wholeStep.instrumentedOverControlRoundMinima.median, approximateClockCostMs: b.estimatedAllClockImportsMs.median, residualMedianMs: b.residualMs.median, phases: b.phases.map((p) => ({ name: p.name, share: p.shareOfOuterTotalPercent, meanMs: p.rawMs.mean })) })), null, 2));
