// Runs of high waves and the three sisters (SEA-03): Kimura's chain of successive heights gives his tables and the
// independent limit; the spectrum's kappa and the runs an hour follow from it; a group's crests stand one autocovariance
// period apart; three sisters placed in a NonlinearSea stand at their heights as three successive crests at their place.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NonlinearSea, groupSpacing, heightCorrelation, kappaFor, runStatistics, sisters } from '../dist/rogue.js';
import { jonswap } from '../dist/waves.js';
import { PhysicsWorld } from '../dist/world.js';

const g = -new PhysicsWorld().gravity[1];
const ND = 36;

/** A JONSWAP sea toward +x on a fine grid out to 10 f_p, spread cos^2. */
function storm({ height, period, peakedness = 3.3 }) {
  const nf = 120,
    f0 = 0.3 / period,
    f1 = 10 / period,
    frequencies = new Float64Array(nf),
    directions = new Float64Array(ND);
  for (let i = 0; i < nf; i++) frequencies[i] = f0 * (f1 / f0) ** (i / (nf - 1));
  for (let j = 0; j < ND; j++) directions[j] = -Math.PI + ((j + 0.5) * 2 * Math.PI) / ND;
  return jonswap(
    { height, period, direction: 0, peakedness },
    { frequencies, directions, energy: new Float64Array(nf * ND), depth: Number.POSITIVE_INFINITY, density: 1025 },
    g,
  );
}

test("Kimura's chain gives his tables: mean runs of high waves by the correlation of successive heights", () => {
  const sea = storm({ height: 4, period: 10 }),
    hmean = 0.886227 / Math.SQRT2,
    third = 1.415735 / Math.SQRT2;
  // His eq. 7 by elliptic integrals: 0.33757 at kappa 0.6, 0.79052 at 0.9.
  assert.ok(Math.abs(heightCorrelation(0.6) - 0.33757) < 1e-5 && Math.abs(heightCorrelation(0.9) - 0.79052) < 1e-5);
  assert.ok(Math.abs(kappaFor(heightCorrelation(0.55)) - 0.55) < 1e-9);
  // Table 2's theory, gamma 0.19 and 0.38: mean runs 2.08 and 2.46 above H_mean, 1.33 and 1.57 above H_1/3 (within 2 percent).
  for (const [gamma, overMean, overThird] of [
    [0.19, 2.08, 1.33],
    [0.38, 2.46, 1.57],
  ]) {
    const kappa = kappaFor(gamma),
      a = runStatistics(sea, hmean, { kappa }).meanRun,
      b = runStatistics(sea, third, { kappa }).meanRun;
    assert.ok(Math.abs(a / overMean - 1) < 0.02 && Math.abs(b / overThird - 1) < 0.02, `${gamma}: ${a} ${b}`);
  }
  // Independent waves (Goda): the run is 1 / (1 - q), 1.15574 above H_1/3.
  assert.ok(Math.abs(runStatistics(sea, third, { kappa: 0 }).meanRun - 1.15574) < 1e-4);
});

test('three in a row above 1.5 H_s come a hundred times as often as independent waves would bring them', () => {
  const sea = storm({ height: 4, period: 10 }),
    r = runStatistics(sea, 1.5, { kappa: 0.5696, period: 7.812 });
  // The research's table for JONSWAP 3.3 at kappa 0.5696: p22 0.1222, 0.0765 triples and 0.0671 runs of three an hour.
  assert.ok(Math.abs(r.persistence - 0.1222) < 1e-4);
  assert.ok(Math.abs(r.inARowPerHour(3) - 0.0765) < 1e-4 && Math.abs(r.runsPerHour(3) - 0.0671) < 2e-4);
  const independent = r.wavesPerHour * r.exceedance ** 3;
  assert.ok(r.inARowPerHour(3) > 100 * independent);
  // The spectrum's own kappa and the corrected one: the corrected is higher (longer groups).
  const spectral = runStatistics(sea, 1.5),
    corrected = runStatistics(sea, 1.5, { method: 'corrected' });
  assert.ok(Math.abs(spectral.kappa - 0.5696) < 0.01, `${spectral.kappa}`);
  assert.ok(corrected.kappa > spectral.kappa + 0.05);
  assert.throws(() => runStatistics(sea, 0), /threshold/);
});

test("three sisters stand at their heights, one group's crest spacing apart, as three successive crests", () => {
  const spectrum = storm({ height: 7, period: 10 }),
    spacing = groupSpacing(spectrum),
    tz = runStatistics(spectrum).period;
  // The research: psi's first positive maximum at 1.225 T_m02 for JONSWAP 3.3.
  assert.ok(Math.abs(spacing / tz - 1.225) < 0.02, `${spacing / tz}`);
  const events = sisters(spectrum, { position: [0, 0], time: 300 }, [8, 9.5, 10.5]),
    sea = new NonlinearSea({ spectrum, gravity: g, rogues: events, seed: 2 });
  assert.equal(sea.rogues.length, 3);
  for (const e of events) assert.ok(Math.abs(sea.elevation(0, 0, e.time) - e.crest) < 1e-6, `${e.time}`);
  // The record about them: its three highest crests are the sisters, in order.
  const crests = [];
  let a = sea.elevation(0, 0, 300 - 30),
    b = sea.elevation(0, 0, 300 - 29.9);
  for (let t = 300 - 29.8; t < 300 + 3 * spacing + 30; t += 0.1) {
    const c = sea.elevation(0, 0, t);
    if (b > a && b >= c) crests.push([t - 0.1, b]);
    a = b;
    b = c;
  }
  const top = [...crests]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .sort((x, y) => x[0] - y[0]);
  top.forEach(([t, h], k) => {
    assert.ok(Math.abs(t - events[k].time) < 0.3 && Math.abs(h - events[k].crest) < 0.05, `sister ${k}: ${h} at ${t}`);
  });
  assert.throws(() => sisters(spectrum, { position: [0, 0], time: 0 }, [1, 2]), /three crests/);
});
