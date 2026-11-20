import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Engine.create stands in for a GPU engine; the test counts what the figure leaves behind.
const core = await import('@margoengine/core');
const engines = [];
mock.module('@margoengine/core', {
  namedExports: {
    ...core,
    Engine: {
      create: async (canvas) => {
        const engine = {
          canvas,
          camera: new core.Camera(),
          scene: {},
          disposed: 0,
          use() {},
          start() {},
          onFrame: () => () => {},
        };
        engine.dispose = () => engine.disposed++;
        engines.push(engine);
        return engine;
      },
    },
  },
});
const { Figure } = await import('@margoengine/sciviz');
const { createTheme } = await import('@margoengine/sciviz/themes');
const { positionBounds } = await import('../src/extent.ts');
const { hex } = await import('../src/export.ts');

test('Figure.create frees its engine when the options are invalid', async () => {
  const dom = new JSDOM('<canvas></canvas>'),
    canvas = dom.window.document.querySelector('canvas');
  for (const options of [{ theme: 'neon' }, { aspect: [1, 0, 1] }, { mode: '4d' }, { limits: [1, 0, 0, 1, 0, 1] }]) {
    await assert.rejects(Figure.create(canvas, options));
    assert.equal(engines.at(-1).disposed, 1, JSON.stringify(options));
  }
  dom.window.close();
});

test('theme chrome colours are #rrggbb, as the alpha-suffixed panels and the clear colour need', async () => {
  const dom = new JSDOM('<canvas></canvas>'),
    canvas = dom.window.document.querySelector('canvas'),
    base = { background: '#102030', axis: '#ffffff', grid: '#333333', text: '#eeeeee' };
  // '#fff' + 'd9' is no CSS colour, and the engine refuses an alpha background.
  for (const background of ['#fff', '#102030ff'])
    await assert.rejects(Figure.create(canvas, { theme: { ...base, background } }), /#rrggbb/);
  assert.throws(() => createTheme('light', { grid: '#ccc' }), /#rrggbb/);
  dom.window.close();
});

test('positions past the largest float32 do not stretch the fitted bounds', () => {
  const p = Float32Array.of(1, 2, 0, 1e39, 3, 0, 2, -1e39, 0, NaN, 4, 0);
  assert.deepEqual(positionBounds(p), [1, 2, 2, 4, 0, 0]);
  assert.deepEqual(positionBounds(Float32Array.of(Infinity, 0, 0)), [0, 1, 0, 0, 0, 0]);
  assert.equal(hex(NaN, 2, -1), '#00ff00');
});

test('bar refuses a base with no plot position; histogram and heatmap refuse missing values', async () => {
  const dom = new JSDOM('<canvas></canvas>'),
    canvas = dom.window.document.querySelector('canvas');
  const log = await Figure.create(canvas, { mode: '2d', axes: false, scale: { y: 'log' } });
  // A base of 0 on a log axis mapped to NaN, so every bar was drawn as NaN (nothing) without an error.
  await assert.rejects(log.bar({ x: [1, 2], y: [10, 100] }, { base: 0 }), RangeError);
  const linear = await Figure.create(canvas, { mode: '2d', axes: false });
  await assert.rejects(linear.bar({ x: [1, 2], y: [10, 100] }, { base: Infinity }), RangeError);
  // Missing values threw a bare TypeError from Float64Array.from or v.length, with no help link.
  await assert.rejects(linear.histogram(undefined), /histogram needs values/);
  await assert.rejects(linear.heatmap(undefined), /heatmap needs values/);
  dom.window.close();
});

test('a disposed colour bar gives back the room the 2D chart made for it', async () => {
  const dom = new JSDOM('<div><canvas></canvas></div>'),
    canvas = dom.window.document.querySelector('canvas');
  globalThis.document ??= dom.window.document;
  globalThis.getComputedStyle ??= dom.window.getComputedStyle.bind(dom.window);
  const figure = await Figure.create(canvas, { mode: '2d', axes: false }),
    before = figure.plotArea.width,
    bar = figure.colorbar('viridis', [0, 1]);
  assert.equal(figure.plotArea.width, before - 72);
  // The 96 px right margin stayed for good, and exports kept walking the removed bar.
  bar.dispose();
  assert.equal(figure.plotArea.width, before);
  assert.equal(figure.exportLayout().bars.length, 0);
  dom.window.close();
});
