import test from 'node:test';
import assert from 'node:assert/strict';
import {
  colormap,
  colormapNames,
  colorScale,
  tolColormap,
  tolPalette,
  tolSchemeNames,
  simulateCVD,
  cvdMatrix,
} from '@margoengine/sciviz/colormaps';
import { colorTextureData } from '../src/color-lookup.ts';
import { ColorBar } from '@margoengine/sciviz';
import { encodingLegend } from '@margoengine/sciviz/colormaps';
import { svgBars, svgSwatches, swatches } from '../src/export.ts';
import { JSDOM } from 'jsdom';
import { SRGBToLinear } from '@margoengine/math/color';

const near = (a, b, t = 1e-6) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < t, `${a} versus ${b}`));
const labL = (rgb) => {
  const [r, g, b] = rgb.map(SRGBToLinear),
    y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  return 116 * (y > 216 / 24389 ? Math.cbrt(y) : ((24389 / 27) * y + 16) / 116) - 16;
};

test('Kovesi constructions preserve linear lightness, symmetric divergence, cyclic seam and isoluminance', () => {
  for (let i = 0; i <= 256; i++) {
    const t = i / 256;
    assert.ok(Math.abs(labL(colormap('lab-linear-blue-yellow').sample(t)) - (25 + 65 * t)) < 0.0001);
    assert.ok(Math.abs(labL(colormap('lab-isoluminant-hue').sample(t)) - 70) < 0.0001);
    assert.ok(
      Math.abs(
        labL(colormap('lab-diverging-blue-red').sample(t)) - labL(colormap('lab-diverging-blue-red').sample(1 - t)),
      ) < 0.0001,
    );
  }
  const cyclic = colormap('lab-cyclic-diamond'),
    h = 1e-5;
  near(cyclic.sample(0), cyclic.sample(1), 1e-12);
  const before = cyclic.sample(-h),
    after = cyclic.sample(h),
    center = cyclic.sample(0);
  near(
    before.map((v, i) => (center[i] - v) / h),
    after.map((v, i) => (v - center[i]) / h),
    0.01,
  );
});

test('Machado author matrix, linear-light multiplication and all severities of every map and Tol scheme', () => {
  assert.deepEqual(
    cvdMatrix('protan', 1),
    [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  );
  near(simulateCVD([1, 0, 0], 'protan'), [0.426608471, 0.372654285, 0], 1e-7);
  near(
    cvdMatrix('deutan', 0.85),
    cvdMatrix('deutan', 0.8).map((v, i) => (v + cvdMatrix('deutan', 0.9)[i]) / 2),
    1e-12,
  );
  const maps = [...colormapNames.map(colormap), ...tolSchemeNames.map(tolColormap)];
  for (const map of maps)
    for (const type of ['protan', 'deutan', 'tritan'])
      for (let s = 0; s <= 10; s++)
        for (let i = 0; i < 33; i++) {
          const rgb = map.sample(i / 32),
            simulated = simulateCVD(rgb, type, s / 10);
          assert.ok(
            simulated.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
            `${map.name}/${type}/${s}/${i}`,
          );
          if (s === 0) near(simulated, rgb, 1e-7);
        }
  assert.throws(() => simulateCVD([1, 0, 0], 'protan', 2));
  assert.throws(() => simulateCVD([NaN, 0, 0], 'protan'));
});

test('Tol defaults match author data and categories never interpolate', () => {
  assert.deepEqual(tolPalette('bright')[0], [68 / 255, 119 / 255, 170 / 255]);
  assert.deepEqual(tolPalette('dark').at(-1), [68 / 255, 68 / 255, 68 / 255]);
  for (const name of tolSchemeNames) {
    const p = tolPalette(name),
      map = tolColormap(name);
    for (let i = 0; i < p.length; i++) near(map.sample((i + 0.25) / p.length), p[i], 1e-12);
    assert.equal(map.gradientStops().length, p.length * 2);
  }
});

test('log and symmetric-log data scales, discrete bins and exceptional colours share CPU and GPU metadata', () => {
  const map = colorScale('gray', {
    domain: [1, 1000],
    scale: 'log',
    nan: '#ff00ff',
    under: '#ff0000',
    over: '#00ff00',
  });
  for (const [v, p] of [
    [1, 0],
    [10, 1 / 3],
    [100, 2 / 3],
    [1000, 1],
  ]) {
    assert.ok(Math.abs(map.position(v) - p) < 1e-12);
    near(map.sample((v - 1) / 999), colormap('gray').sample(p));
  }
  assert.deepEqual(map.sample(NaN), [1, 0, 1]);
  assert.deepEqual(map.sample(-Infinity), [1, 0, 0]);
  assert.deepEqual(map.sample(Infinity), [0, 1, 0]);
  const sym = colorScale('gray', { domain: [-100, 100], scale: 'symlog', constant: 2 });
  assert.equal(sym.position(0), 0.5);
  for (const v of [0, 0.01, 1, 10, 100]) assert.ok(Math.abs(sym.position(v) + sym.position(-v) - 1) < 1e-12);
  const bins = colorScale('aurora', { domain: [0, 10], boundaries: [0, 1, 5, 10], colors: ['#f00', '#0f0', '#00f'] });
  assert.deepEqual(bins.sample(0.1), [0, 1, 0]);
  assert.deepEqual(bins.sample(0.499999), [0, 1, 0]);
  assert.deepEqual(bins.sample(0.5), [0, 0, 1]);
  const stops = bins.gradientStops();
  assert.deepEqual(
    stops.map((s) => s.offset),
    [0, 0.1, 0.1, 0.5, 0.5, 1],
  );
  const data = colorTextureData(map);
  assert.deepEqual(Array.from(data.subarray(1036, 1040)), [1, 1, 1000, 1]);
  assert.deepEqual(Array.from(data.subarray(1032, 1036)), [1, 0, 1, 1]);
  assert.throws(() => colorScale('gray', { domain: [0, 1], scale: 'log' }));
  assert.throws(() => colorScale('gray', { domain: [0, 1], boundaries: [0, 0.5, 0.4, 1] }));
  assert.throws(() => colorScale('gray', { domain: [0, 1], bins: 1.5 }));
  assert.throws(() => colorScale('gray', { domain: [0, 1], bins: 2, colors: ['#fff'] }));
});

test('HTML legend, SVG hard stops and polygons keep exact encoding geometry and figure lifetime', () => {
  const dom = new JSDOM('<div><canvas></canvas></div>');
  const saved = {};
  for (const k of ['document', 'getComputedStyle']) {
    saved[k] = globalThis[k];
    globalThis[k] = k === 'document' ? dom.window.document : dom.window.getComputedStyle;
  }
  try {
    const canvas = document.querySelector('canvas'),
      theme = { text: '#000000', background: '#ffffff', axis: '#333333', grid: '#cccccc' };
    const map = colorScale('gray', { domain: [0, 10], boundaries: [0, 1, 5, 10], colors: ['#f00', '#0f0', '#00f'] });
    const bar = new ColorBar(canvas, map, [0, 10], theme);
    bar.bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 14, height: 100 });
    const svg = svgBars([{ bar: bar.bar, map }], { left: 0, top: 0 });
    assert.match(
      svg,
      /<stop offset="0.1" stop-color="rgb\(255,0,0\)"\/><stop offset="0.1" stop-color="rgb\(0,255,0\)"/,
    );
    const fig = { engine: { canvas }, theme };
    const legend = encodingLegend(
      fig,
      [
        { name: 'small', color: '#ff0000', shape: 'dot', size: 8 },
        { name: 'large', color: '#00ff00', shape: 'triangle', size: 24 },
      ],
      { title: 'Diameter in pixels' },
    );
    assert.equal(legend.element.isConnected, true);
    const spans = legend.element.querySelectorAll('[data-sciviz-swatch]');
    spans.forEach((s, i) => {
      s.getBoundingClientRect = () => ({ left: 0, top: 0, width: i ? 24 : 8, height: i ? 24 : 8 });
    });
    const boxes = swatches([legend.element], { left: 0, top: 0 });
    assert.match(svgSwatches(boxes), /<circle.*r="4"/);
    assert.match(svgSwatches(boxes), /<polygon points="12,0 24,24 0,24"/);
    legend.dispose();
    assert.equal(legend.element.isConnected, false);
    legend.dispose();
    bar.dispose();
  } finally {
    for (const k of Object.keys(saved)) globalThis[k] = saved[k];
    dom.window.close();
  }
});

test('portable figure values preserve exact bin edges, scale transforms and exceptional colours', async () => {
  const { encodeFigureValue, decodeFigureValue } = await import('@margoengine/sciviz/spec');
  const original = colorScale('gray', {
    domain: [1, 100],
    scale: 'log',
    boundaries: [1, 2, 10, 100],
    colors: ['#f00', '#0f0', '#00f'],
    nan: '#f0f',
    under: '#000',
    over: '#fff',
  });
  const restored = await decodeFigureValue(await encodeFigureValue(original));
  for (const v of [NaN, -Infinity, Infinity, 0, 0.01, 0.02, 0.1, 0.5, 1])
    near(original.sample(v), restored.sample(v), 1e-12);
  near(
    original.gradientStops().map((s) => s.offset),
    restored.gradientStops().map((s) => s.offset),
    1e-12,
  );
});
