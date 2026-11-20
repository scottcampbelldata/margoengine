import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ColorBar } from '@margoengine/sciviz';
import { Colormap, colormap } from '@margoengine/sciviz/colormaps';
import { hex, svgBars } from '../src/export.ts';
import { mapColours } from '../src/color-lookup.ts';
import { extent } from '../src/extent.ts';
import { scalarMesh } from '../src/vector-snapshot.ts';

test('colour bars of two charts inlined in one page keep their own gradients', () => {
  const dom = new JSDOM('<div><canvas></canvas></div>');
  const saved = {};
  for (const k of ['document', 'getComputedStyle']) {
    saved[k] = globalThis[k];
    globalThis[k] = k === 'document' ? dom.window.document : dom.window.getComputedStyle;
  }
  try {
    const canvas = document.querySelector('canvas'),
      theme = { text: '#000000', background: '#ffffff', axis: '#333333', grid: '#cccccc' };
    const svgOf = (map) => {
      const bar = new ColorBar(canvas, map, [0, 1], theme);
      bar.bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 14, height: 100 });
      const svg = svgBars([{ bar: bar.bar, map }], { left: 0, top: 0 });
      bar.dispose();
      return svg;
    };
    const ids = (svg) => [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const a = svgOf(colormap('viridis')),
      b = svgOf(colormap('magma'));
    // One page, one id namespace: different gradients need different ids, and each rect points at its own.
    assert.notDeepEqual(ids(a), ids(b));
    for (const svg of [a, b]) assert.equal(svg.match(/url\(#([^)]+)\)/)[1], ids(svg)[0]);
    // The same gradient gets the same id, so the output stays deterministic.
    assert.equal(svgOf(colormap('viridis')), a);
    // A map whose sample gives NaN writes a valid colour.
    const nan = new Colormap('custom', 'sequential', (t) => [t > 0.5 ? NaN : t, 0, 1]);
    assert.doesNotMatch(svgOf(nan), /NaN/);
  } finally {
    for (const k of Object.keys(saved)) globalThis[k] = saved[k];
    dom.window.close();
  }
});

test('hex writes a NaN channel as 00, not #NaN', () => {
  assert.equal(hex(NaN, 0.5, 2), '#0080ff');
  assert.equal(hex(-1, 1, NaN), '#00ff00');
});

test('colour mapping spreads a range wider than the largest double over the map', () => {
  const map = colormap('gray'),
    rgb = mapColours([-1e308, 0, 1e308], map, [-1e308, 1e308]);
  assert.ok(rgb.every(Number.isFinite), `${rgb}`);
  assert.ok(rgb[0] < rgb[3] && rgb[3] < rgb[6], `${rgb}`);
  assert.equal(rgb[0], 0);
  assert.equal(rgb[6], 1);
  // An ordinary range keeps its indices: 0.5 of 255 rounds to entry 128.
  const plain = mapColours([0, 5, 10], map, [0, 10]);
  assert.deepEqual([plain[0], plain[6]], [0, 1]);
  assert.equal(plain[3], map.table(256)[128 * 4]);
});

test('the fitted range skips infinities, so one infinite value leaves the others their colours', () => {
  assert.deepEqual(extent([1, Infinity, 3, -Infinity, NaN]), [1, 3]);
  assert.deepEqual(extent([Infinity, -Infinity]), [0, 1]);
  const map = colormap('gray'),
    rgb = mapColours([1, 2, 3, Infinity], map, extent([1, 2, 3, Infinity]));
  assert.equal(rgb[0], 0);
  assert.equal(rgb[6], 1);
  assert.equal(rgb[9], 1);
});

test('a scalar-coloured mesh snapshot spreads a range wider than the largest double over the map', () => {
  const map = colormap('gray'),
    mesh = scalarMesh(new Float32Array(9), [-1e308, 0, 1e308], map, [-1e308, 1e308], 1);
  const red = [mesh.colors[0], mesh.colors[4], mesh.colors[8]];
  assert.ok(red.every(Number.isFinite), `${red}`);
  assert.ok(red[0] < red[1] && red[1] < red[2], `${red}`);
  assert.deepEqual(
    [...scalarMesh(new Float32Array(9), [0, 5, 10], map, [0, 10], 1).colors.slice(0, 3)],
    [...map.sample(0)].slice(0, 3).map(Math.fround),
  );
});
