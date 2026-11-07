// What Sismic, an outside statechart interpreter, did with the seeded charts, replayed against Margo with no Python.
// `npm run test:outside` runs Sismic again and rewrites the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHART_COUNT, makeChart, runMargo } from './outside/charts.mjs';

test('Margo walks the seeded charts through the same states as Sismic, step by step', () => {
  const traces = JSON.parse(readFileSync(new URL('outside/traces.json', import.meta.url), 'utf8'));
  assert.equal(traces.length, CHART_COUNT);
  let moved = 0;
  traces.forEach((outside, index) => {
    const margo = runMargo(makeChart(index + 1));
    assert.deepEqual(margo, outside, `seed ${index + 1}`);
    for (let i = 1; i < outside.length; i++) if (outside[i] !== outside[i - 1]) moved++;
  });
  // The charts must really move, or equal traces prove nothing.
  assert.ok(moved > CHART_COUNT * 5, `only ${moved} steps changed state`);
});
