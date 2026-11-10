import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Camera } from '@margoengine/core';
import { Figure, THEMES } from '@margoengine/sciviz';
import {
  attachAccessibility,
  describeSeries,
  sonificationPlan,
  playSonification,
  HIGH_CONTRAST_THEME,
  figureForCanvas,
} from '@margoengine/sciviz/a11y';

test('descriptions retain missing/count/extremes and a numerically stable trend', () => {
  const y = [2, NaN, 8, 11],
    series = { name: 'Observed', kind: 'series', count: y.length, datum: (i) => ({ x: 1e12 + i, value: y[i] }) };
  const d = describeSeries(series);
  assert.equal(d.count, 4);
  assert.equal(d.finite, 3);
  assert.equal(d.missing, 1);
  assert.equal(d.minimum, 2);
  assert.equal(d.minimumIndex, 0);
  assert.equal(d.maximumIndex, 3);
  assert.equal(d.mean, 7);
  assert.equal(d.trend, 'rising');
  assert.ok(Math.abs(d.slope - 3) < 0.0001);
  assert.equal(describeSeries({ ...series, datum: () => ({ value: NaN }) }).trend, 'unavailable');
});

test('pitch plans preserve every sample, missing silence, monotonic pitch, data times and exact abort reasons', () => {
  const plan = sonificationPlan([0, NaN, 0.5, 1], { duration: 4, pitch: [220, 880] });
  assert.deepEqual([...plan.audible], [1, 0, 1, 1]);
  assert.deepEqual([...plan.times], [0, 1, 2, 3]);
  assert.deepEqual([...plan.frequencies], [220, 220, 440, 880]);
  assert.deepEqual([...sonificationPlan([1, 2, 3], { times: [10, 11, 20], duration: 3 }).times], [0, 0.2, 2]);
  assert.deepEqual([...sonificationPlan([2, 2]).frequencies], [440, 440]);
  for (const options of [{ duration: 0 }, { pitch: [20, 20] }, { times: [0, 0] }, { maxPoints: 1 }])
    assert.throws(() => sonificationPlan([1, 2], options));
  assert.throws(() => sonificationPlan([NaN]));
  const c = new AbortController(),
    reason = { cancelled: true };
  c.abort(reason);
  assert.throws(
    () => sonificationPlan([1], { signal: c.signal }),
    (e) => e === reason,
  );
});

function audio() {
  const events = [],
    osc = {
      connect() {},
      disconnect() {
        events.push('osc-disconnect');
      },
      frequency: { setValueAtTime: (...v) => events.push(['frequency', ...v]) },
      start() {},
      stop() {
        events.push('stop');
        queueMicrotask(() => osc.onended?.());
      },
      onended: null,
    };
  const ctx = {
    currentTime: 0,
    destination: {},
    resume: async () => {},
    close: async () => events.push('close'),
    createOscillator: () => osc,
    createGain: () => ({
      gain: {
        setValueAtTime: (...v) => events.push(['gain', ...v]),
        linearRampToValueAtTime: (...v) => events.push(['ramp', ...v]),
      },
      connect() {},
      disconnect() {
        events.push('gain-disconnect');
      },
    }),
  };
  return { ctx, events };
}
test('Web Audio owns and releases nodes, retains borrowed contexts and cancels a suspended resume', async () => {
  const a = audio();
  await playSonification([0, 1], { context: a.ctx, duration: 0.1 });
  assert.ok(a.events.includes('osc-disconnect'));
  assert.ok(a.events.includes('gain-disconnect'));
  assert.ok(!a.events.includes('close'));
  assert.equal(a.events.filter((e) => e[0] === 'frequency').length, 2);
  const c = new AbortController(),
    reason = { cancelled: 'resume' },
    b = audio();
  b.ctx.resume = () => new Promise(() => {});
  const pending = playSonification([1], { context: b.ctx, signal: c.signal });
  c.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
});

function domFixture() {
  const dom = new JSDOM('<div><canvas aria-label="Observed data"></canvas></div>'),
    saved = {};
  for (const key of ['document', 'getComputedStyle']) {
    saved[key] = globalThis[key];
    globalThis[key] = key === 'document' ? dom.window.document : dom.window.getComputedStyle;
  }
  const canvas = dom.window.document.querySelector('canvas'),
    engine = {
      canvas,
      camera: new Camera(),
      scene: { background: '#000000' },
      use() {},
      onFrame: () => () => {},
      render() {},
      stop() {
        this.stopped = true;
      },
    },
    renderer = { ready: async () => {}, dispose() {} };
  const fig = new Figure(engine, { axes: false }, renderer);
  return {
    dom,
    fig,
    canvas,
    engine,
    restore() {
      fig.dispose();
      for (const k of Object.keys(saved)) globalThis[k] = saved[k];
      dom.window.close();
    },
  };
}
test('keyboard movement, full table paging, live descriptions, weak discovery and figure-owned cleanup', async () => {
  const f = domFixture();
  try {
    const a = attachAccessibility(f.fig, {
      pageSize: 2,
      reducedMotion: true,
      series: [
        { name: 'LIGO', kind: 'series', count: 5, datum: (i) => ({ x: i, y: i * 2, value: i * 2 }) },
        { name: 'GHCN', kind: 'bin', count: 3, datum: (i) => ({ value: 10 - i }) },
      ],
    });
    await a.refresh();
    assert.equal(figureForCanvas(f.canvas), f.fig);
    assert.ok(f.engine.stopped);
    assert.match(a.element.textContent, /5 series records/);
    assert.match(a.element.textContent, /Trend rising/);
    const key = (k) =>
      f.canvas.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowRight');
    assert.deepEqual(a.focused, { series: 0, index: 1 });
    key('End');
    assert.equal(a.focused.index, 4);
    assert.match(a.element.querySelector('caption').textContent, /5 to 5 of 5/);
    key('ArrowDown');
    assert.deepEqual(a.focused, { series: 1, index: 2 });
    key('Home');
    assert.equal(a.focused.index, 0);
    assert.equal(a.element.querySelector('table').getAttribute('aria-rowcount'), '4');
    assert.match(a.element.querySelector('[role=status]').textContent, /GHCN, bin 1 of 3/);
    f.fig.dispose();
    assert.equal(a.element.isConnected, false);
    assert.equal(figureForCanvas(f.canvas), undefined);
    assert.equal(f.canvas.getAttribute('aria-label'), 'Observed data');
    assert.equal(f.canvas.hasAttribute('tabindex'), false);
    a.dispose();
  } finally {
    f.restore();
  }
});

test('high contrast and custom chrome are per figure, validate before mutation and remain portable', async () => {
  const f = domFixture();
  try {
    const before = { ...THEMES.dark };
    await f.fig.setTheme(HIGH_CONTRAST_THEME);
    assert.deepEqual(f.fig.theme, HIGH_CONTRAST_THEME);
    assert.deepEqual(THEMES.dark, before);
    assert.equal(f.engine.scene.background, '#000000');
    const { Figure: Portable, decodeFigureValue } = await import('@margoengine/sciviz/spec');
    const tracked = Portable.record(f.fig, { axes: false });
    const saved = await tracked.toJSON();
    assert.deepEqual((await decodeFigureValue(saved.options)).theme, HIGH_CONTRAST_THEME);
    await assert.rejects(f.fig.setTheme({ ...HIGH_CONTRAST_THEME, text: 'invalid' }));
    assert.deepEqual(f.fig.theme, HIGH_CONTRAST_THEME);
  } finally {
    f.restore();
  }
});

test('empty series navigation captures arrows before camera handlers and reattachment restores attributes', async () => {
  const f = domFixture();
  try {
    let cameraKeys = 0;
    f.canvas.addEventListener('keydown', () => cameraKeys++);
    const first = attachAccessibility(f.fig, {
      series: [
        {
          name: 'Empty',
          kind: 'series',
          count: 0,
          datum: () => {
            throw Error('No row');
          },
        },
        { name: 'Observed', kind: 'point', count: 1, datum: () => ({ x: 0, y: 0, value: 4 }) },
      ],
    });
    await first.ready;
    const key = (k) =>
      f.canvas.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('End');
    assert.match(first.element.querySelector('[role=status]').textContent, /no observations/);
    key('ArrowDown');
    assert.deepEqual(first.focused, { series: 1, index: 0 });
    assert.equal(cameraKeys, 0);
    const second = attachAccessibility(f.fig, { series: [] });
    await second.ready;
    assert.equal(first.element.isConnected, false);
    second.dispose();
    assert.equal(f.canvas.getAttribute('aria-label'), 'Observed data');
    assert.equal(f.canvas.hasAttribute('tabindex'), false);
  } finally {
    f.restore();
  }
});

test('disposal aborts an unresolved application adapter without waiting for it', async () => {
  const f = domFixture();
  try {
    let started;
    const ready = new Promise((r) => (started = r));
    const a = attachAccessibility(f.fig, {
      series: () => {
        started();
        return new Promise(() => {});
      },
    });
    await ready;
    a.dispose();
    await assert.rejects(a.ready, (e) => e.name === 'AbortError');
  } finally {
    f.restore();
  }
});


test('an external cancellation retains its exact reason while removing owned controls', async () => {
  const f = domFixture();
  try {
    const c = new AbortController(), reason = { cancelled: 'external' };
    let started;
    const ready = new Promise(r => started = r);
    const a = attachAccessibility(f.fig, {signal: c.signal, series: () => { started(); return new Promise(() => {}); }});
    await ready;
    c.abort(reason);
    await assert.rejects(a.ready, e => e === reason);
    assert.equal(a.element.isConnected, false);
  } finally { f.restore(); }
});
