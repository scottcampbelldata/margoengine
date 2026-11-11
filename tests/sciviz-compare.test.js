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

test('accuracy references: option, mesh measures, cell fans and the float64 ABC reference (KB2594a)', async () => {
  const { abcReference, cellTriangles, meshMeasures } = await import('../scripts/sciviz-compare/accuracy.mjs');
  assert.equal(compareOptions(['--accuracy']).accuracy, true);
  assert.equal(compareOptions([]).accuracy, false);
  // Unit cube as 12 outward triangles: area 6, volume 1, from a VTK-style cell array with quads fanned.
  const p = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
  ];
  const ids = cellTriangles(quads.flatMap((q) => [4, ...q]));
  assert.equal(ids.length, 36);
  const cube = meshMeasures(12, (t, c) => p[ids[3 * t + c]]);
  assert.ok(Math.abs(cube.area - 6) < 1e-12 && Math.abs(cube.volume - 1) < 1e-12, JSON.stringify(cube));
  // RK4 at 20,000 steps agrees with 40,000 steps far below the measured streamline errors (1e-3).
  const seed = [Math.PI, Math.PI, Math.PI],
    a = abcReference(seed, 1, 20_000),
    b = abcReference(seed, 1, 40_000);
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-10);
});

test('graph link peak: share of the asked colour at the brightest interior link pixel (KB2594b)', async () => {
  const { linkPeak } = await import('../scripts/sciviz-compare/appearance.mjs');
  const width = 16,
    height = 16,
    background = [15, 20, 28],
    asked = [34, 203, 238];
  const frame = (colour) => {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) rgba.set([...background, 255], i * 4);
    for (let x = 4; x < 12; x++) rgba.set([...colour, 255], (8 * width + x) * 4);
    rgba.set([...asked, 255], 0); // a corner node outside the interior disc is left out
    return { width, height, rgba };
  };
  const full = linkPeak(frame(asked), asked, background);
  assert.deepEqual(full.peak, asked);
  assert.equal(full.share, 1);
  assert.equal(full.pixels, 8);
  const dim = linkPeak(frame([32, 97, 118]), asked, background);
  assert.ok(Math.abs(dim.share - 77 / 183) < 1e-12, JSON.stringify(dim));
});
