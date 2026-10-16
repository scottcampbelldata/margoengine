import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachWorkshopStats } from '../examples/skinning-ik/performance-hud.ts';

function fixture(t) {
  const dom = new JSDOM('<body><div id="viewport"></div></body>', { url: 'http://localhost/skinning-ik.html' }),
    doc = dom.window.document,
    timers = new Map(),
    lists = [],
    memory = { usedJSHeapSize: 32 * 1024 * 1024 };
  let createdPoints = 0,
    pointStrings = 0,
    plugin;
  t.mock.method(globalThis, 'setInterval', (callback, milliseconds) => {
    const token = { callback, milliseconds };
    timers.set(token, token);
    return token;
  });
  t.mock.method(globalThis, 'clearInterval', (token) => timers.delete(token));
  const oldMemory = Object.getOwnPropertyDescriptor(performance, 'memory');
  Object.defineProperty(performance, 'memory', { configurable: true, value: memory });
  const create = doc.createElementNS.bind(doc);
  t.mock.method(doc, 'createElementNS', (namespace, tag) => {
    const element = create(namespace, tag);
    if (tag === 'svg')
      element.createSVGPoint = () => {
        createdPoints++;
        return { x: 0, y: 0 };
      };
    if (tag === 'polyline') {
      const items = [],
        points = {
          get numberOfItems() {
            return items.length;
          },
          appendItem(point) {
            const attached = { x: point.x, y: point.y };
            items.push(attached);
            return attached;
          },
        };
      Object.defineProperty(element, 'points', { value: points });
      const attribute = element.setAttribute.bind(element);
      element.setAttribute = (name, value) => {
        if (name === 'points') pointStrings++;
        attribute(name, value);
      };
      lists.push(items);
    }
    return element;
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const hud = attachWorkshopStats(
    {
      use(value) {
        plugin = value;
      },
    },
    doc.querySelector('#viewport'),
  );
  t.after(() => {
    hud.dispose();
    plugin.dispose();
    dom.window.close();
    if (oldMemory) Object.defineProperty(performance, 'memory', oldMemory);
    else delete performance.memory;
  });
  return {
    doc,
    hud,
    lists,
    timers,
    memory,
    refresh: [...timers.values()].find((value) => value.milliseconds === 500).callback,
    createdPoints: () => createdPoints,
    pointStrings: () => pointStrings,
  };
}

test('workshop sparklines reuse SVG points while preserving rolling values, labels and expand controls', (t) => {
  const f = fixture(t),
    histories = [[], []];
  f.hud.stats.tick(16);
  assert.equal(f.createdPoints(), 240);
  assert.equal(f.pointStrings(), 0);
  assert.equal(f.lists[1].length, 1);
  const toggle = f.doc.querySelector('[aria-controls="workshop-performance-panel"]');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(f.hud.stats.element.style.display, 'block');
  let retained;
  for (let frame = 0; frame < 300; frame++) {
    const heap = 32 + (frame % 150) / 10,
      gpu = 1 + (frame % 31) / 10;
    f.memory.usedJSHeapSize = heap * 1024 * 1024;
    f.hud.stats.gpuTime = gpu;
    f.refresh();
    histories[0].push(gpu);
    histories[1].push(heap);
    if (frame === 150) retained = f.lists.map((list) => list.slice());
  }
  assert.equal(f.createdPoints(), 240);
  assert.equal(f.pointStrings(), 0, 'refresh must not rebuild and parse a points string');
  for (let graph = 0; graph < 2; graph++) {
    const values = histories[graph].slice(-120),
      min = Math.min(...values),
      max = Math.max(...values),
      range = Math.max(max - min, Math.abs(max) * 0.005, 0.01);
    assert.equal(f.lists[graph].length, 120);
    for (let i = 0; i < 120; i++) {
      assert.equal(f.lists[graph][i], retained[graph][i]);
      assert.equal(f.lists[graph][i].x, Number(((i / 119) * 196).toFixed(1)));
      assert.equal(f.lists[graph][i].y, Math.round((20 - ((values[i] - min) / range) * 18) * 10) / 10);
    }
  }
  assert.match(toggle.textContent, /63 FPS · JS 47 MB/);
  assert.match(f.doc.body.textContent, /GPU passes 1\.00–4\.00 ms/);
  assert.match(f.doc.body.textContent, /JS heap 46\.9 MB\n35\.0–46\.9 MB · rolling 60 s/);
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('unavailable measurements remain honest and disposal stops HUD refresh', (t) => {
  const f = fixture(t);
  f.memory.usedJSHeapSize = NaN;
  f.hud.stats.gpuTime = null;
  f.refresh();
  assert.match(f.doc.body.textContent, /JS n\/a/);
  assert.match(f.doc.body.textContent, /JS heap unavailable/);
  assert.match(f.doc.body.textContent, /GPU trace unavailable/);
  f.hud.dispose();
  const text = f.doc.body.textContent;
  f.refresh();
  assert.equal(f.doc.body.textContent, text);
  assert.equal(
    [...f.timers.values()].some((value) => value.milliseconds === 500),
    false,
  );
});
