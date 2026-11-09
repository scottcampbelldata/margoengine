// Named speed suite: original assertions, scenes and budgets retained verbatim.
import assert from 'node:assert/strict';
import { deferSpeed } from '../support/speed-phase.mjs';

const budgets = {
  'biomes-copy-packing': ({ pack }) => {
    assert.equal(pack.short, 0, `${pack.short} frames stopped copying with budget left and copy steps waiting`);
  },
  'proof-speedup': ({ item, name, ref }) => {
    assert.ok(item.speedup >= 1, `${name} ${item.case} is slower than ${ref}: ${item.speedup}x`);
  },
  'geometry-edges': ({ cpu }) => {
    assert.ok(cpu() < 150, 'linear time on 8,385 vertices');
  },
  'geometry-triangulate': ({ ms }) => {
    assert.ok(ms < 150, `took ${ms.toFixed(0)} ms of CPU`);
  },
  'geometry-circle': ({ ms, reference, count }) => {
    assert.ok(
      ms < 2.5 * reference + 50,
      `${count} points: ${ms.toFixed(0)} ms vs noisy ring ${reference.toFixed(0)} ms`,
    );
  },
  'geometry-inputs': ({ ms }) => {
    assert.ok(ms < 1500, `Invalid input took ${ms} ms of CPU time to reject`);
  },
  'biomes-object-allocation': ({ cpu }) => {
    assert.ok(cpu() < 100, 'no allocation before the check');
  },
  'biomes-wide-road': ({ ms }) => {
    assert.ok(ms < 200, `${ms} ms of CPU`);
  },
  'biomes-wander-road': ({ ms }) => {
    assert.ok(ms < 800, `${ms} ms of CPU`);
  },
  'points-las': ({ cpu }) => {
    assert.ok(cpu() < 150);
  },
  'points-e57': ({ cpu }) => {
    assert.ok(cpu() < 300);
  },
  'points-laz': ({ cpu }) => {
    assert.ok(cpu() < 8000);
  },
  'tiles-fuzz': ({ cpu }) => {
    assert.ok(cpu() < 150, 'fuzzing finishes quickly');
  },
  'wgsl-fuzz': ({ ms, what }) => {
    assert.ok(ms < 400, `${what}: took ${Math.round(ms)} ms of CPU`);
  },
  'loaders-xml': ({ cpu }) => {
    assert.ok(cpu() < 150, 'XML attribute scan must stay linear');
  },
  'security-stl': ({ took }) => {
    assert.ok(took < 150, `took ${took} ms of CPU`);
  },
  'fuzz-parsers': ({ took, ms, label }) => {
    assert.ok(took < ms, `${label} took ${took} ms of CPU`);
  },
  'materials-half': ({ ms, native }) => {
    assert.ok(ms < 120, `4M values took ${ms.toFixed(0)} ms (native ${native}); the per-value callback took ~400`);
  },
  'environment-exr': ({ parse, convert }) => {
    assert.ok(
      parse < convert,
      `parse ${parse.toFixed(1)} ms is not below halfToFloat per texel ${convert.toFixed(1)} ms`,
    );
  },
  'exporters-writer': ({ writer, search }) => {
    assert.ok(
      writer < search,
      `The number writer ${writer.toFixed(1)} ms is not below the old search ${search.toFixed(1)} ms`,
    );
  },
  'exporters-usdz': ({ usdz, unit }) => {
    assert.ok(
      usdz < unit * 10,
      `exportUSDZ of 1,000 boxes took ${usdz.toFixed(1)} ms, the control ${unit.toFixed(1)} ms`,
    );
  },
  'netcode-rtt': ({ mover }) => {
    assert.ok(mover.stats.rtt < 250, `rtt ${mover.stats.rtt} ms on localhost`);
  },
  'sandbox-finds': ({ ms }) => {
    assert.ok(ms < 1000, `worked out in ${ms.toFixed(0)} ms`);
  },
  'quickstart': ({ secondsToInteractive, gate }) => {
    assert.ok(
      secondsToInteractive < gate,
      `machine time to the verified interactive frame was ${secondsToInteractive} s; the gate is ${gate} s`,
    );
  },
  'biomes-slow-sends': ({ slow, SEND, worst }) => {
    assert.ok(
      slow.max <= SEND + 1.5,
      `the view spent ${slow.max.toFixed(1)} ms in one frame with ${SEND} ms sends: jobs or a whole tile went in beyond the frame budget (worst frame ${worst})`,
    );
  },
  'biomes-flight-p99': ({ result, settle, P99_LIMIT }) => {
    assert.ok(
      settle(result.p99Added) <= P99_LIMIT,
      `streaming added ${result.p99Added.toFixed(3)} ms to the 99th percentile frame`,
    );
  },
  'biomes-flight-max': ({ result, settle, MAX_LIMIT }) => {
    assert.ok(
      settle(result.maxAdded) <= MAX_LIMIT,
      `streaming added ${result.maxAdded.toFixed(3)} ms to the worst frame`,
    );
  },
  'biomes-camera01': ({ at01, BEFORE, shadows }) => {
    assert.ok(
      at01 <= 0.7 * BEFORE[`01 ${shadows}`],
      `camera 01, shadows ${shadows}: ${at01.toFixed(2)} ms, before ${BEFORE[`01 ${shadows}`]} ms`,
    );
  },
  'biomes-camera02': ({ at02, BEFORE, shadows }) => {
    assert.ok(
      at02 < BEFORE[`02 ${shadows}`],
      `camera 02, shadows ${shadows}: ${at02.toFixed(2)} ms, before ${BEFORE[`02 ${shadows}`]} ms`,
    );
  },
  'biomes-far-forest': ({ farCost }) => {
    assert.ok(farCost <= 1, `far forest costs ${farCost.toFixed(2)} ms, limit 1.0 ms`);
  },
  'sandbox-figures': ({ cost }) => {
    assert.ok(cost.mean < 4, `${cost.mean} ms a frame for 200 figures`);
  },
};

export const speedBudgetNames = Object.keys(budgets);

export function speedBudget(name, values) {
  if (!Object.hasOwn(budgets, name)) throw new Error(`Unknown speed budget: ${name}`);
  if (deferSpeed(name)) return;
  budgets[name](values);
}
