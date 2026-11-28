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
  // Values near the largest double: the mean, slope and trend stay finite instead of overflowing to NaN.
  const big = [-1.5e308, 1e308, 1.7e308],
    wide = describeSeries({ name: 'Wide', kind: 'series', count: 3, datum: (i) => ({ x: i * 5e307, value: big[i] }) });
  assert.ok(Math.abs(wide.mean - 4e307) < 1e293, `mean ${wide.mean}`);
  assert.equal(wide.trend, 'rising');
  assert.ok(Math.abs(wide.slope - 3.2) < 1e-12, `slope ${wide.slope}`);
  const tiny = describeSeries({
    name: 'Tiny',
    kind: 'series',
    count: 2,
    datum: (i) => ({ value: [5e-324, 1e-323][i] }),
  });
  assert.ok(tiny.mean >= 5e-324 && tiny.mean <= 1e-323, `mean ${tiny.mean}`);
  assert.equal(tiny.trend, 'rising');
});

test('pitch plans preserve every sample, missing silence, monotonic pitch, data times and exact abort reasons', () => {
  const plan = sonificationPlan([0, NaN, 0.5, 1], { duration: 4, pitch: [220, 880] });
  assert.deepEqual([...plan.audible], [1, 0, 1, 1]);
  assert.deepEqual([...plan.times], [0, 1, 2, 3]);
  assert.deepEqual([...plan.frequencies], [220, 220, 440, 880]);
  assert.deepEqual([...sonificationPlan([1, 2, 3], { times: [10, 11, 20], duration: 3 }).times], [0, 0.2, 2]);
  assert.deepEqual([...sonificationPlan([2, 2]).frequencies], [440, 440]);
  // A data span or time span past the largest double still maps every sample to a pitch and a time.
  const wide = sonificationPlan([-1.7e308, 0, 1.7e308], { times: [-1e308, 0, 1e308], duration: 3 });
  assert.deepEqual([...wide.frequencies], [220, 440, 880]);
  assert.deepEqual([...wide.times], [0, 1, 2]);
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

function domFixture(renderer = { ready: async () => {}, add() {}, remove() {}, dispose() {} }) {
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
    };
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

test('disposing accessibility restores the original theme and frame pacing', async () => {
  const f = domFixture();
  try {
    const theme = { ...f.fig.theme };
    const pace = () => true;
    f.engine.pace = pace;
    const a = attachAccessibility(f.fig, { highContrast: true, reducedMotion: true });
    await a.ready;
    assert.deepEqual(f.fig.theme, HIGH_CONTRAST_THEME);
    a.dispose();
    await f.fig.ready();
    assert.deepEqual(f.fig.theme, theme);
    assert.equal(f.engine.pace, pace);
    assert.notEqual(f.engine.stopped, true);
  } finally {
    f.restore();
  }
});

test('OS preferences restore theme and motion without restarting a stopped engine', async (t) => {
  const f = domFixture();
  const queries = [];
  const savedMedia = globalThis.matchMedia;
  t.after(() => {
    if (savedMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = savedMedia;
  });
  globalThis.matchMedia = (query) => {
    const media = new EventTarget();
    media.matches = false;
    media.media = query;
    queries.push(media);
    return media;
  };
  try {
    f.engine.stop();
    const theme = { ...f.fig.theme };
    const a = attachAccessibility(f.fig);
    await a.ready;
    for (const q of queries) {
      q.matches = true;
      q.dispatchEvent(new Event('change'));
    }
    await f.fig.ready();
    assert.deepEqual(f.fig.theme, HIGH_CONTRAST_THEME);
    for (const q of queries) {
      q.matches = false;
      q.dispatchEvent(new Event('change'));
    }
    await f.fig.ready();
    assert.deepEqual(f.fig.theme, theme);
    assert.equal(f.engine.pace, undefined);
    assert.equal(f.engine.stopped, true);
    a.dispose();
  } finally {
    f.restore();
  }
});

test('reduced motion suspends timeline frames while preserving playback and cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const savedReport = globalThis.reportError;
  globalThis.reportError = (e) => {
    throw e;
  };
  t.after(() => {
    if (savedReport === undefined) delete globalThis.reportError;
    else globalThis.reportError = savedReport;
  });
  const f = domFixture();
  try {
    let frames = 0;
    const timeline = f.fig.timeline(
      [0, 1, 2],
      () => {
        frames++;
      },
      { controls: false },
    );
    await timeline.seek(0);
    const before = frames;
    const abort = new AbortController();
    const playback = f.fig.play({ loop: true, fps: 10, signal: abort.signal });
    const a = attachAccessibility(f.fig, { reducedMotion: true });
    await a.ready;
    t.mock.timers.tick(100);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(frames, before);
    assert.equal(timeline.playing, true);
    a.dispose();
    t.mock.timers.tick(100);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.ok(frames > before);
    const reason = new Error('stop restored playback');
    abort.abort(reason);
    await assert.rejects(playback, (e) => e === reason);
  } finally {
    f.restore();
  }
});
// KB-VC-SCIVIZ-STILL: the view suspended the frame loop and nothing drew afterwards, so a page that attached before
// the axes (or the first frame) had drawn kept a picture without them, and dragging or the page's controls did nothing.
test('a figure under reduced motion draws its changes and answers input with one frame', async () => {
  const f = domFixture();
  try {
    let draws = 0;
    f.engine.render = () => draws++;
    const controls = { enableDamping: true };
    Object.defineProperty(f.fig, 'controls', { configurable: true, get: () => controls });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const a = attachAccessibility(f.fig, { reducedMotion: true, series: [] });
    await a.ready;
    await settle();
    assert.ok(draws > 0, 'the figure as it stood at attach was never drawn');
    assert.equal(controls.enableDamping, false);
    let before = draws;
    f.fig.addLayer({ bounds: [0, 1, 0, 1, 0, 1], setModel() {}, draw() {}, restore() {}, dispose() {} });
    await settle();
    assert.ok(draws > before, 'an added layer was never drawn');
    before = draws;
    await f.fig.ready();
    assert.ok(draws > before, 'ready() left the change undrawn');
    assert.equal(f.engine.pace(0), false);
    for (const type of ['pointerdown', 'wheel', 'input', 'change']) {
      f.canvas.dispatchEvent(new f.dom.window.Event(type, { bubbles: true }));
      assert.equal(f.engine.pace(0), true, `${type} got no frame`);
      assert.equal(f.engine.pace(0), false, `${type} left the loop running`);
    }
    f.canvas.dispatchEvent(new f.dom.window.Event('pointermove', { bubbles: true }));
    assert.equal(f.engine.pace(0), false, 'a move without a pressed button is not input');
    a.dispose();
    assert.equal(controls.enableDamping, true);
    await settle();
    before = draws;
    await f.fig.ready();
    assert.equal(draws, before, 'a running loop needs no extra draw');
  } finally {
    f.restore();
  }
});

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
    assert.equal(a.element.style.margin, '0px');
    assert.equal(a.element.style.padding, '0px');
    assert.equal(a.element.style.background, 'transparent');
    assert.equal(figureForCanvas(f.canvas), f.fig);
    assert.equal(f.engine.pace(0), false);
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
    const c = new AbortController(),
      reason = { cancelled: 'external' };
    let started;
    const ready = new Promise((r) => (started = r));
    const a = attachAccessibility(f.fig, {
      signal: c.signal,
      series: () => {
        started();
        return new Promise(() => {});
      },
    });
    await ready;
    c.abort(reason);
    await assert.rejects(a.ready, (e) => e === reason);
    assert.equal(a.element.isConnected, false);
  } finally {
    f.restore();
  }
});

test('a refused attach keeps the current view, and a 2D record outside the window shows no marker', async () => {
  const f = domFixture();
  try {
    const a = attachAccessibility(f.fig, { reducedMotion: true, series: [] });
    await a.refresh();
    assert.throws(() => attachAccessibility(f.fig, { pageSize: 0 }), RangeError);
    assert.equal(a.element.isConnected, true, 'an invalid pageSize disposed the working view');
    a.dispose();
  } finally {
    f.restore();
  }
  const g = domFixture();
  try {
    g.fig.dispose();
    const fig = new Figure(
      g.engine,
      { mode: '2d', axes: false, limits: [0, 1, 0, 1] },
      {
        ready: async () => {},
        add() {},
        remove() {},
        dispose() {},
      },
    );
    for (const [k, v] of [
      ['clientWidth', 400],
      ['clientHeight', 300],
    ])
      Object.defineProperty(g.canvas, k, { value: v, configurable: true });
    // The engine updates its camera each frame; this one draws no frames.
    g.engine.camera.update(400 / 300, true);
    const a = attachAccessibility(fig, {
      reducedMotion: true,
      series: [{ name: 'trace', kind: 'series', count: 2, datum: (i) => ({ x: [0.5, 1.05][i], y: 0.5, value: i }) }],
    });
    await a.refresh();
    const marker = [...g.canvas.parentElement.children].find((e) => e.tagName === 'SPAN' && e.style.borderRadius);
    a.focus(0, 0);
    assert.equal(marker.hidden, false, 'a record inside the window is marked');
    // x 1.05 lands in the right margin (inside the canvas, outside the plot area), where nothing is drawn.
    a.focus(0, 1);
    assert.equal(marker.hidden, true);
    a.dispose();
    fig.dispose();
  } finally {
    g.restore();
  }
});

test('toSVG waits for the renderer like toPNG and rejects with its failure before drawing a frame', async () => {
  let fail;
  const failure = new Error('pipeline failed'),
    renderer = { ready: () => new Promise((_, reject) => (fail = reject)), add() {}, remove() {}, dispose() {} },
    f = domFixture(renderer);
  try {
    let frames = 0;
    f.engine.render = () => frames++;
    const svg = f.fig.toSVG({ vector: false });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(frames, 0);
    fail(failure);
    await assert.rejects(svg, (e) => e === failure);
    assert.equal(frames, 0);
  } finally {
    f.restore();
  }
});
