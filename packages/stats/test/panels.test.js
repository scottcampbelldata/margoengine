import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { StatsPanels } from '../dist/panels.js';
import { Stats } from '../dist/index.js';

function dom() {
  const d = new JSDOM('<body/>'),
    moves = [];
  d.window.HTMLCanvasElement.prototype.getContext = () => ({
    fillRect() {},
    beginPath() {
      moves.push('begin');
    },
    stroke() {},
    moveTo(x, y) {
      moves.push(['move', x, y]);
    },
    lineTo(x, y) {
      moves.push(['line', x, y]);
    },
  });
  return { d, moves };
}
const sample = (fps) => ({
  fps,
  cpuMilliseconds: fps / 10,
  gpuMilliseconds: fps / 20,
  memoryBytes: fps * 1048576,
  passes: [{ name: 'main', milliseconds: fps / 20 }],
});

test('four fixed histories remain chronological after wrap; DOM refresh is separate and JSON is independent', () => {
  const { d } = dom(),
    panels = new StatsPanels({ parent: d.window.document.body, samples: 3 }),
    ring = panels.series.fps;
  try {
    const before = panels.element.textContent;
    for (const fps of [10, 20, 30, 40]) panels.sample(sample(fps));
    assert.equal(panels.element.textContent, before, 'sampling has no DOM writes');
    const report = panels.toJSON();
    assert.deepEqual(report.fps, [20, 30, 40]);
    assert.deepEqual(report.cpuMilliseconds, [2, 3, 4]);
    assert.deepEqual(report.gpuMilliseconds, [1, 1.5, 2]);
    assert.deepEqual(
      report.memoryBytes,
      [20, 30, 40].map((v) => v * 1048576),
    );
    assert.equal(panels.series.fps, ring);
    panels.refresh();
    assert.match(panels.element.textContent, /FPS: 40.00.*avg 30.00.*peak 40.00/);
    assert.match(panels.element.textContent, /GPU passes\nmain: 2.00 ms/);
    assert.equal(panels.element.querySelectorAll('canvas[role="img"]').length, 4);
    report.passes[0].name = 'changed';
    report.fps[0] = -1;
    assert.equal(panels.toJSON().passes[0].name, 'main');
    assert.equal(panels.toJSON().fps[0], 20);
  } finally {
    panels.dispose();
    d.window.close();
  }
});

test('missing GPU/memory samples are gaps, pass names are text, and invalid samples never partially mutate history', () => {
  const { d, moves } = dom(),
    panels = new StatsPanels({ parent: d.window.document.body, samples: 4 });
  try {
    panels.sample(sample(10));
    panels.sample({ ...sample(20), gpuMilliseconds: null, memoryBytes: null });
    panels.sample({ ...sample(30), passes: [{ name: '<img src=x onerror=bad()>', milliseconds: 1 }] });
    panels.refresh();
    assert.equal(panels.element.querySelector('img'), null);
    assert.match(panels.element.textContent, /<img src=x onerror=bad\(\)>/);
    assert.deepEqual(panels.toJSON().gpuMilliseconds, [0.5, null, 1.5]);
    assert.ok(
      moves.some((v) => Array.isArray(v) && v[0] === 'move' && v[1] === 2),
      'missing values break the path',
    );
    const report = panels.toJSON();
    for (const bad of [
      { ...sample(10), fps: NaN },
      { ...sample(10), cpuMilliseconds: -1 },
      { ...sample(10), memoryBytes: Infinity },
      { ...sample(10), passes: [{ name: '', milliseconds: 1 }] },
    ])
      assert.throws(() => panels.sample(bad), /Invalid/);
    assert.deepEqual(panels.toJSON(), report);
    panels.sample({ ...sample(0), gpuMilliseconds: null, memoryBytes: null });
    panels.refresh();
    assert.match(panels.element.textContent, /GPU ms: unavailable/);
    assert.match(panels.element.textContent, /GPU passes unavailable/);
  } finally {
    panels.dispose();
    d.window.close();
  }
});

test('borrowed Stats survives panel disposal with its original graph restored; owned Stats is removed', () => {
  const { d } = dom(),
    stats = new Stats({ parent: d.window.document.body }),
    panels = new StatsPanels({ stats });
  try {
    assert.equal(stats.graph.style.display, 'none');
    panels.dispose();
    panels.dispose();
    assert.equal(stats.graph.style.display, 'block');
    assert.equal(stats.element.isConnected, true);
    stats.tick(16);
    assert.throws(() => panels.sample(sample(10)), /disposed/);
    const owned = new StatsPanels({ parent: d.window.document.body });
    owned.dispose();
    assert.equal(owned.stats.element.isConnected, false);
    assert.throws(() => new StatsPanels({ parent: d.window.document.body, samples: 1 }), /Invalid/);
    assert.throws(() => new StatsPanels({ parent: d.window.document.body, refreshMilliseconds: 0 }), /Invalid/);
  } finally {
    panels.dispose();
    stats.dispose();
    d.window.close();
  }
});

test('failed engine registration cleans up the constructed panel and timer', () => {
  const { d } = dom();
  try {
    assert.throws(
      () =>
        StatsPanels.attach(
          {
            use() {
              throw new Error('duplicate');
            },
          },
          { parent: d.window.document.body },
        ),
      /duplicate/,
    );
    assert.equal(d.window.document.body.childElementCount, 0);
  } finally {
    d.window.close();
  }
});
