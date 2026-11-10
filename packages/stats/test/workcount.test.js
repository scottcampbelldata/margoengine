// Batch 170 stats work counts: the overlay timers redraw only when what they draw changed. A redraw with unchanged
// inputs repeats the same text and canvas commands, so an idle page (no frames) does no DOM or canvas work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Stats } from '../dist/index.js';
import { StatsPanels } from '../dist/panels.js';

// A recording 2D context and a captured interval callback, so the test drives the 150 ms timer by hand.
function page(t) {
  const d = new JSDOM('<body></body>'),
    ops = [];
  const record = (name) =>
    function (...args) {
      ops.push([name, ...args]);
    };
  d.window.HTMLCanvasElement.prototype.getContext = () => ({
    fillRect: record('fillRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    set fillStyle(v) {
      ops.push(['fillStyle', v]);
    },
    set strokeStyle(v) {
      ops.push(['strokeStyle', v]);
    },
  });
  const timers = [],
    previous = globalThis.setInterval;
  globalThis.setInterval = (callback, milliseconds) => {
    timers.push(callback);
    return previous(() => {}, milliseconds);
  };
  t.after(() => {
    globalThis.setInterval = previous;
    d.window.close();
  });
  return { d, ops, timers, restore: () => (globalThis.setInterval = previous) };
}

test('Stats: 1000 idle timer refreshes draw nothing; a new sample draws the same overlay as an explicit refresh', (t) => {
  const { d, ops, timers, restore } = page(t);
  const stats = new Stats({ parent: d.window.document.body });
  restore();
  t.after(() => stats.dispose());
  for (let i = 0; i < 200; i++) stats.tick(16 + (i % 7), 3, 1);
  ops.length = 0;
  timers[0]();
  const text = stats.element.textContent,
    drawn = JSON.stringify(ops);
  ops.length = 0;
  let writes = 0;
  const node = stats.element.firstChild,
    descriptor = Object.getOwnPropertyDescriptor(d.window.Node.prototype, 'textContent');
  Object.defineProperty(node, 'textContent', {
    get: () => descriptor.get.call(node),
    set: (v) => {
      writes++;
      descriptor.set.call(node, v);
    },
  });
  for (let i = 0; i < 1000; i++) timers[0]();
  assert.equal(writes, 0);
  assert.equal(ops.length, 0);
  // The skipped refreshes would have drawn exactly this again: an explicit refresh repeats the last draw.
  stats.refresh();
  assert.equal(stats.element.textContent, text);
  assert.ok(JSON.stringify(ops) === drawn, 'an explicit refresh repeats the timer draw');
  ops.length = 0;
  writes = 0;
  stats.tick(40, 5, 2);
  timers[0]();
  assert.equal(writes, 1);
  assert.ok(ops.length > 0);
  const after = JSON.stringify(ops);
  ops.length = 0;
  stats.refresh();
  assert.ok(JSON.stringify(ops) === after, 'the timer draw after a sample equals an explicit refresh');
  // Public counters written directly still reach the overlay on the next timer refresh.
  writes = 0;
  stats.drawCalls = 9;
  timers[0]();
  assert.equal(writes, 1);
  assert.match(stats.element.textContent, /9 draws/);
});

test('StatsPanels: idle timer refreshes draw nothing; a new sample redraws exactly as an explicit refresh', (t) => {
  const { d, ops, timers, restore } = page(t);
  const panels = new StatsPanels({ parent: d.window.document.body });
  restore();
  t.after(() => panels.dispose());
  const sample = (fps) => ({
    fps,
    cpuMilliseconds: fps / 10,
    gpuMilliseconds: fps / 20,
    memoryBytes: fps * 1048576,
    passes: [{ name: 'main', milliseconds: fps / 20 }],
  });
  for (let i = 0; i < 50; i++) panels.sample(sample(30 + i));
  const timer = timers.at(-1);
  ops.length = 0;
  timer();
  const text = panels.element.textContent;
  ops.length = 0;
  for (let i = 0; i < 1000; i++) timer();
  assert.equal(ops.length, 0);
  assert.equal(panels.element.textContent, text);
  panels.sample(sample(90));
  timer();
  const drawn = JSON.stringify(ops),
    shown = panels.element.textContent;
  assert.ok(ops.length > 0);
  ops.length = 0;
  panels.refresh();
  assert.ok(JSON.stringify(ops) === drawn, 'an explicit refresh repeats the timer draw');
  assert.equal(panels.element.textContent, shown);
});
