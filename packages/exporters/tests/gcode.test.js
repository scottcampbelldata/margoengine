// exportGCode: a cube sliced and the program read back by the G-code loader, with the numbers worked out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGCode } from '@margoengine/loaders/gcode';
import { exportGCode, exportGCodePaths } from '../dist/gcode.js';

/** An axis-aligned box from (0,0,0) to (w,d,h) in scene units, outward triangles. */
const box = (w, d, h) => ({
  positions: [0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h],
  indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
});
const scene = (geometry) => ({ nodes: [{ geometry }] });
const near = (a, b, tolerance, label = '') => assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} against ${b}`);
// Filament per mm of line: layer height x line width over the 1.75 mm filament's cross section.
const perMm = (layer, width, filament = 1.75) => (layer * width) / (Math.PI * (filament / 2) ** 2);

test('a 20 mm cube, outlines only, reads back with the layer count, bounds and filament worked out by hand', () => {
  const result = exportGCode(scene(box(0.02, 0.02, 0.02)), { upAxis: 'z', layerHeight: 0.5, infill: 0 });
  // (20 - 0.5) / 0.5 + 1 = 40 layers of a 80 mm square outline.
  assert.equal(result.layers, 40);
  near(result.length, 40 * 80, 1e-6);
  near(result.filament, 40 * 80 * perMm(0.5, 0.4), 1e-6);
  assert.deepEqual(result.min.slice(0, 2).map(Math.round), [0, 0]);
  near(result.min[2], 0.5, 1e-9); // the first layer prints at its top
  assert.deepEqual(result.max.map(Math.round), [20, 20, 20]);
  const parsed = parseGCode(result.text);
  assert.equal(parsed.layers.length, 40);
  near(parsed.filament, result.filament, 1e-2); // E is written to 5 decimals
  assert.equal(parsed.layers[0].extrusion.length / 6, 8); // two collinear segments per side: 8 per outline
  assert.match(result.text, /^; Margo Engine G-code/);
  assert.match(result.text, /\nM83/);
  assert.match(result.text, /\nM106 S255\n/);
  const small = exportGCode(scene(box(0.02, 0.02, 0.004)), { upAxis: 'z' });
  assert.match(small.text, /\nG1 E-1 F/); // relative retraction before a travel across the part
});

test('Y-up scenes stand up, infill adds scanline fill, and centre moves the part to the bed centre', () => {
  // A 10 x 30 x 20 mm box in a Y-up scene: its 30 mm height becomes G-code Z.
  const options = { layerHeight: 1, infill: 0.5, center: [100, 100], firstLayerHeight: 1 };
  const result = exportGCode(scene(box(0.01, 0.03, 0.02)), options);
  // Y-up: x = x, G-code y = -z (depth 20), Z = y (height 30).
  assert.equal(result.layers, 30);
  near(result.max[2] - result.min[2], 29, 1e-6); // from the first layer top (1) to the last (30)
  assert.deepEqual([result.min[0], result.max[0]].map(Math.round), [95, 105]);
  assert.deepEqual([result.min[1], result.max[1]].map(Math.round), [90, 110]);
  near(result.min[2], 1, 1e-9);
  const outline = exportGCode(scene(box(0.01, 0.03, 0.02)), { ...options, infill: 0 });
  assert.ok(result.length > outline.length * 1.2, 'infill prints more path than outlines alone');
  // Layers alternate scanline direction: the first fill line of layer 0 is horizontal, of layer 1 vertical.
  const layers = parseGCode(result.text).layers;
  const horizontal = (p) => p[1] === p[4];
  const seg = (layer, at) => [...layers[layer].extrusion.slice(at * 6, at * 6 + 6)];
  assert.ok(horizontal(seg(0, 8)) && !horizontal(seg(1, 8)));
});

test('absolute extrusion, retraction on long travels, and start and end code', () => {
  const result = exportGCode(scene(box(0.02, 0.02, 0.004)), {
    upAxis: 'z',
    relativeExtrusion: false,
    infill: 0.3,
    startCode: 'G28\nG29',
    endCode: 'M84',
    nozzleTemperature: 0,
    bedTemperature: 0,
    fan: 0,
  });
  assert.match(result.text, /\nM82/);
  assert.ok(!/M104|M140|M106/.test(result.text.replace(/\n(M104 S0|M140 S0)/g, '')));
  assert.match(result.text, /G28\nG29\nG92 E0/);
  assert.ok(result.text.trimEnd().endsWith('M84'));
  const e = [...result.text.matchAll(/ E(-?[\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(e.some((v, i) => i && v < e[i - 1]), 'absolute E moves back on a retraction');
});

test('polylines print as 3D paths grouped by layer', () => {
  const result = exportGCodePaths([[0, 0, 0, 0.01, 0, 0, 0.01, 0.01, 0], [0, 0, 0.0002, 0.01, 0, 0.0002]], { upAxis: 'z', layerHeight: 0.2 });
  assert.equal(result.layers, 2);
  near(result.length, 20 + 10, 1e-6);
  near(parseGCode(result.text).filament, 30 * perMm(0.2, 0.4), 1e-3);
});

test('bad options and sources throw', () => {
  const cube = scene(box(0.01, 0.01, 0.01));
  assert.throws(() => exportGCode(cube, { layerHeight: 0 }), /layerHeight/);
  assert.throws(() => exportGCode(cube, { infill: 2 }), /infill/);
  assert.throws(() => exportGCode(cube, { scale: -1 }), /scale/);
  assert.throws(() => exportGCode(cube, { retract: -1 }), /retract/);
  assert.throws(() => exportGCode({ nodes: [] }), /triangles/);
  assert.throws(() => exportGCode(cube, { upAxis: 'z', layerHeight: 0.00001 }), /layers/);
  assert.throws(() => exportGCodePaths([[0, 0]]), /triples/);
});
