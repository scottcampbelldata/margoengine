import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Camera } from '@margoengine/core';
import { Figure, THEMES } from '@margoengine/sciviz';
import {
  createTheme,
  THEME_PRESETS,
  PRINT_PALETTES,
  journalPreset,
  themeVariables,
  themeLayerOptions,
  applyTheme,
} from '@margoengine/sciviz/themes';
import { mediaDimensions } from '@margoengine/sciviz/export-media';

test('immutable complete presets, independent palettes and invalid style tokens', () => {
  const a = createTheme('print'),
    b = createTheme(a, { fontSize: 13, palette: ['#112233'] });
  assert.equal(a.fontSize, 11);
  assert.equal(b.fontSize, 13);
  assert.ok(Object.isFrozen(b.palette));
  assert.deepEqual(PRINT_PALETTES.color, ['#332288', '#117733', '#882255', '#AA4499', '#775500', '#000000']);
  assert.equal(themeLayerOptions(a, 7).color, PRINT_PALETTES.color[1]);
  assert.equal(themeLayerOptions(a).colormap, 'cividis');
  assert.equal('color' in themeLayerOptions(a,0,'scalar'), false);
  assert.throws(()=>themeLayerOptions(a,0,'unknown'));
  assert.equal(themeVariables(a)['--margo-line-width'], String(4 / 3));
  for (const value of [
    { fontSize: 0 },
    { fontSize: Infinity },
    { axisWidth: -1 },
    { gridWidth: NaN },
    { tickSize: 65 },
    { tickCount: 1 },
    { tickCount: 2.5 },
    { palette: [] },
    { palette: ['red'] },
    { fontFamily: 'Arial; color:red' },
    { gridStyle: 'dashed' },
    { scalarMap: 'missing' },
  ])
    assert.throws(() => createTheme('light', value));
  assert.throws(() => createTheme('missing'));
  assert.throws(() => themeLayerOptions(a, -1));
  assert.equal(THEME_PRESETS['print-mono'].gridStyle, 'none');
});

test('publisher final-column widths, CSS units and physical media pixels share the exact 25.4 mm conversion', () => {
  for (const [name, widths] of [
    ['nature', [89, 183]],
    ['ieee', [88.9, 182]],
  ])
    for (const columns of [1, 2]) {
      const p = journalPreset(name, columns, { heightMM: 50, dpi: 600 });
      assert.equal(p.widthMM, widths[columns - 1]);
      assert.equal(p.css.width, p.widthMM + 'mm');
      assert.equal(p.pdf.widthMM, p.widthMM);
      assert.deepEqual(mediaDimensions(100, 100, p.raster), {
        width: Math.round((p.widthMM / 25.4) * 600),
        height: Math.round((50 / 25.4) * 600),
        dpi: 600,
      });
      assert.ok(Object.isFrozen(p.theme));
    }
  assert.equal(journalPreset('nature').theme.fontSize, (6.5 * 4) / 3);
  assert.equal(journalPreset('ieee').theme.fontSize, (9.5 * 4) / 3);
  assert.throws(() => journalPreset('nature', 3));
  assert.throws(() => journalPreset('missing'));
  assert.throws(() => journalPreset('ieee', 1, { heightMM: 0 }));
});

function fixture() {
  const dom = new JSDOM('<div><canvas></canvas><canvas id="other"></canvas><span>Owned label</span></div>'),
    saved = {};
  for (const key of ['document', 'getComputedStyle']) {
    saved[key] = globalThis[key];
    globalThis[key] = key === 'document' ? dom.window.document : dom.window.getComputedStyle;
  }
  const canvas = dom.window.document.querySelector('canvas'),
    frames = new Set(),
    engine = {
      canvas,
      camera: new Camera(),
      scene: { background: '#000000' },
      use() {},
      render() {
        for (const fn of frames) fn();
      },
      onFrame(fn) {
        frames.add(fn);
        return () => frames.delete(fn);
      },
    },
    renderer = { ready: async () => {}, dispose() {} };
  const fig = new Figure(engine, { axes: false }, renderer);
  return {
    dom,
    fig,
    canvas,
    engine,
    frames,
    restore() {
      fig.dispose();
      for (const key of Object.keys(saved)) globalThis[key] = saved[key];
      dom.window.close();
    },
  };
}

test('scoped CSS refresh, theme event synchronization, stable self-assignment and owner cleanup', async () => {
  const f = fixture();
  try {
    const before = { ...THEMES.dark };
    f.canvas.style.setProperty('--margo-line-width', '5');
    const h = await applyTheme(f.fig, 'print');
    assert.equal(f.dom.window.document.body.style.getPropertyValue('--margo-background'), '');
    assert.equal(f.dom.window.document.querySelector('#other').style.getPropertyValue('--margo-background'), '');
    assert.equal(f.canvas.style.getPropertyValue('--margo-font-size'), '11px');
    f.canvas.style.setProperty('--margo-font-size', '14px');
    await h.refresh();
    assert.equal(f.fig.theme.fontSize, 14);
    assert.equal(f.fig.theme.lineWidth, 5);
    f.canvas.style.setProperty('--margo-font-size', '2em');
    await assert.rejects(h.refresh(), /pixel length/);
    assert.equal(f.fig.theme.fontSize, 14);
    f.canvas.style.setProperty('--margo-font-size', '14px');
    const expected = { ...f.fig.theme };
    await f.fig.setTheme(f.fig.theme);
    assert.deepEqual(f.fig.theme, expected);
    await f.fig.setTheme({ ...f.fig.theme, text: '#ffffff' });
    assert.equal(f.canvas.style.getPropertyValue('--margo-text'), '#ffffff');
    assert.deepEqual(THEMES.dark, before);
    f.fig.dispose();
    assert.equal(f.frames.size, 0);
    assert.equal(f.canvas.style.getPropertyValue('--margo-font-size'), '');
    assert.equal(f.canvas.style.getPropertyValue('--margo-line-width'), '5');
    await assert.rejects(h.refresh(), (e) => e.code === 'disposed');
  } finally {
    f.restore();
  }
});

test('new publication roots bind once and removed label roots release their style bindings', async () => {
  const f = fixture();
  try {
    const label = f.dom.window.document.querySelector('span');
    let roots = [label];
    f.fig.exportLayout = () => ({ roots, bars: [] });
    const h = await applyTheme(f.fig, 'print');
    assert.equal(label.style.getPropertyValue('--margo-font-size'), '11px');
    label.remove();
    roots = [];
    f.engine.render();
    assert.equal(label.style.getPropertyValue('--margo-font-size'), '');
    const second = f.dom.window.document.createElement('span');
    f.canvas.parentElement.append(second);
    roots = [second];
    f.engine.render();
    assert.equal(second.style.getPropertyValue('--margo-font-size'), '11px');
    h.dispose();
    assert.equal(second.style.getPropertyValue('--margo-font-size'), '');
  } finally {
    f.restore();
  }
});

test('pre-aborted theme application retains the exact caller reason and installs no resources', async () => {
  const f = fixture();
  try {
    const c = new AbortController(),
      reason = { cancelled: true };
    c.abort(reason);
    await assert.rejects(applyTheme(f.fig, 'print', { signal: c.signal }), (e) => e === reason);
    assert.equal(f.frames.size, 0);
  } finally {
    f.restore();
  }
});
