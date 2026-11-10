import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { CASES, INSTALL, RIVALS, compareOptions } from '../scripts/sciviz-compare/manifest.mjs';
import { comparisonData } from '../scripts/sciviz-compare/data.mjs';

test('comparison manifest covers all eight scenes and six named external rivals', () => {
  assert.deepEqual([...new Set(CASES.map((c) => c.id))].sort(), [
    'graph',
    'heatmap',
    'isosurface',
    'line',
    'scatter',
    'streamlines',
    'tiles',
    'volume',
  ]);
  assert.deepEqual([...new Set(CASES.map((c) => c.rival))].sort(), Object.keys(RIVALS).sort());
  assert.equal(new Set(CASES.map((c) => `${c.id}/${c.rival}`)).size, CASES.length);
  for (const spec of CASES) {
    assert.ok(spec.scales.length >= 4);
    assert.ok(spec.scales.every((s, i) => Number.isSafeInteger(s) && s > 0 && (!i || s > spec.scales[i - 1])));
  }
  assert.ok(INSTALL.every((spec) => /@\d+\.\d+\.\d+$/.test(spec)));
  assert.equal(compareOptions(['--runs=1']).runs, 1);
  assert.deepEqual(compareOptions(['--cases=volume/vtk,scatter/regl']).cases, ['volume/vtk', 'scatter/regl']);
  for (const arg of ['--runs=0', '--runs=101', '--runs=1x', '--cases=missing', '--output=', '--typo'])
    assert.throws(() => compareOptions([arg]));
});

test('shared taxi scenes retain every input row and label repetition; heatmap bins retain their exact sum', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (path) => new Response(await readFile(new URL(`..${path}`, import.meta.url))),
  );
  const scatter = await comparisonData('scatter', 1024);
  assert.equal(scatter.sourceRows, 1024);
  assert.equal(scatter.points.length, 1024);
  assert.equal(scatter.replicated, false);
  assert.ok(scatter.points.flat().every((x) => Number.isFinite(x) && x >= -1 && x <= 1));
  const repeated = await comparisonData('line', 1025);
  assert.equal(repeated.replicated, true);
  assert.deepEqual(repeated.points[1024], repeated.points[0]);
  const heat = await comparisonData('heatmap', 32);
  assert.equal(
    heat.values.reduce((a, b) => a + b, 0),
    1024,
  );
  assert.equal(heat.colorscale.length, 256);
});

test('shared NOAA input decodes the actual gzip container and OpenAlex copies retain connectivity', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (path) => new Response(await readFile(new URL(`..${path}`, import.meta.url))),
  );
  const wind = await comparisonData('streamlines', 8);
  assert.equal(wind.field.u.length, 49 * 19);
  assert.equal(wind.field.v.length, 49 * 19);
  assert.ok([...wind.field.u, ...wind.field.v].every(Number.isFinite));
  const once = await comparisonData('graph', 1),
    twice = await comparisonData('graph', 2);
  assert.equal(twice.edges.length, 2 * once.edges.length);
  assert.equal(twice.positions.length, 2 * once.positions.length);
  const nodes = once.positions.length / 3;
  assert.deepEqual(
    [...twice.edges.slice(once.edges.length)],
    [...once.edges].map((x) => x + nodes),
  );
});
