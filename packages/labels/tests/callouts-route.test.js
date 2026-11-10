import test from 'node:test';
import assert from 'node:assert/strict';
import { routeCalloutLeaders, RoutedCallouts } from '@margoengine/labels/callouts-route';
import { LabelRenderer } from '@margoengine/labels';
import { Camera } from '@margoengine/core';
import { fakeEngine } from './fake-dom.js';
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const on = (a, b, c, turn = cross) =>
  turn(a, b, c) === 0 &&
  c[0] >= Math.min(a[0], b[0]) &&
  c[0] <= Math.max(a[0], b[0]) &&
  c[1] >= Math.min(a[1], b[1]) &&
  c[1] <= Math.max(a[1], b[1]);
function noCrossings(routes, turn = cross) {
  assert.equal(new Set(routes.map((r) => r.port)).size, routes.length);
  for (let i = 0; i < routes.length; i++)
    for (let j = 0; j < i; j++)
      for (let s = 0; s < 2; s++)
        for (let t = 0; t < 2; t++) {
          const [a, b] = routes[i].points.slice(s, s + 2),
            [c, d] = routes[j].points.slice(t, t + 2);
          const proper = turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
          assert.equal(proper, false, `proper crossing ${JSON.stringify([routes[i], routes[j]])}`);
          for (const p of [a, b])
            if (on(c, d, p, turn))
              assert.ok(
                s === 0 && t === 0 && same(p, routes[i].points[0]) && same(p, routes[j].points[0]),
                `touch/overlap ${JSON.stringify([routes[i], routes[j]])}`,
              );
          for (const p of [c, d])
            if (on(a, b, p, turn))
              assert.ok(
                s === 0 && t === 0 && same(p, routes[i].points[0]) && same(p, routes[j].points[0]),
                `touch/overlap ${JSON.stringify([routes[i], routes[j]])}`,
              );
        }
}
test('planar matching reorders a crossing-prone fixture and supports both sides', () => {
  const sources = [
      [10, 10],
      [90, 20],
    ],
    ports = [
      [120, 50],
      [120, 60],
    ];
  const routes = routeCalloutLeaders(sources, ports, 110);
  assert.deepEqual(
    routes.map((r) => r.port),
    [1, 0],
  );
  noCrossings(routes);
  const left = routeCalloutLeaders(
    sources.map((p) => [-p[0], p[1]]),
    ports.map((p) => [-p[0], p[1]]),
    -110,
  );
  noCrossings(left);
  assert.deepEqual(routes[0].points[0], sources[0]);
  assert.deepEqual(routes[0].points[2], ports[routes[0].port]);
});
test('seeded integer clouds, collinear and coincident anchors have no crossings or overlapping segments', () => {
  let seed = 781;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let round = 0; round < 80; round++) {
    const sources = Array.from({ length: 24 }, () => [Math.floor(random() * 100), Math.floor(random() * 400)]),
      ports = sources.map((_, i) => [140, i * 20]);
    noCrossings(routeCalloutLeaders(sources, ports, 120));
  }
  for (const sources of [
    Array.from({ length: 24 }, () => [20, 20]),
    Array.from({ length: 24 }, (_, i) => [20, i * 10]),
    [
      [20, 20],
      [20, 30],
      [20, 45],
    ],
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  ]) {
    const ports = sources.map((_, i) => [140, i * 20]);
    noCrossings(routeCalloutLeaders(sources, ports, 120));
  }
});
// Independent exact reference: radix-2 strings rather than bit-field decoding.
const exactInteger = (n) => {
  const [whole, fraction = ''] = Math.abs(n).toString(2).split('.');
  const bits = BigInt('0b' + whole + fraction) << BigInt(1074 - fraction.length);
  return n < 0 ? -bits : bits;
};
const exactCross = (a, b, c) => {
  const d =
    (exactInteger(b[0]) - exactInteger(a[0])) * (exactInteger(c[1]) - exactInteger(a[1])) -
    (exactInteger(b[1]) - exactInteger(a[1])) * (exactInteger(c[0]) - exactInteger(a[0]));
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};
test('binary64 degeneracy, enormous and subnormal coordinates remain deterministic and finite', () => {
  for (const scale of [1e-300, 1, 1e300]) {
    const sources = [
        [0, 0],
        [scale, scale],
        [scale * 2, scale * 2],
      ],
      ports = [
        [scale * 4, 0],
        [scale * 4, scale],
        [scale * 4, scale * 2],
      ];
    const routes = routeCalloutLeaders(sources, ports, scale * 3);
    assert.equal(routes.length, 3);
    noCrossings(routes, exactCross);
    assert.equal(new Set(routes.map((r) => r.port)).size, 3);
    assert.deepEqual(routeCalloutLeaders(sources, ports, scale * 3), routes);
    assert.ok(routes.every((r) => r.points.every((p) => p.every(Number.isFinite))));
  }
  assert.deepEqual(routeCalloutLeaders([], [], 0), []);
  assert.throws(() => routeCalloutLeaders([[0, 0]], [], 10), RangeError);
  assert.throws(
    () =>
      routeCalloutLeaders(
        [
          [0, 0],
          [1, 1],
        ],
        [
          [20, 2],
          [20, 2],
        ],
        10,
      ),
    RangeError,
  );
  assert.throws(() => routeCalloutLeaders([[15, 0]], [[20, 2]], 10), RangeError);
});
test('layout draws SVG elbows, reorders real label boxes without overlap, caches still frames and cleans up', () => {
  const engine = fakeEngine(Camera),
    layout = new RoutedCallouts(),
    renderer = new LabelRenderer({ layout });
  renderer.setup(engine);
  renderer.registerPasses(engine.graph);
  const labels = [];
  for (const position of [
    [0, 0, 0],
    [0.3, 0.1, 0],
    [0, 0, 0],
    [0.1, 0.3, 0],
  ]) {
    const e = engine.document.createElement('div');
    Object.defineProperty(e, 'offsetWidth', { value: 60 });
    Object.defineProperty(e, 'offsetHeight', { value: 24 });
    labels.push(renderer.add(e, { position }));
  }
  engine.frame();
  assert.equal(layout.routes.length, 4);
  assert.equal(layout.svg.children.length, 4);
  assert.ok(labels.every((l) => l.onScreen));
  const boxes = labels
    .map((l) => ({ left: l.screen.x - l.placedAnchor[0] * 60, top: l.screen.y - l.placedAnchor[1] * 24 }))
    .sort((a, b) => a.top - b.top);
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].top >= boxes[i - 1].top + 28);
  const points = [...layout.svg.children].map((p) => p.getAttribute('points'));
  engine.frame();
  assert.equal(layout.writes, 0);
  assert.deepEqual(
    [...layout.svg.children].map((p) => p.getAttribute('points')),
    points,
  );
  assert.equal(renderer.root?.style.overflow ?? layout.svg.parentElement.style.overflow, 'visible');
  labels[0].remove();
  engine.frame();
  assert.equal(layout.routes.length, 3);
  assert.equal(layout.svg.children.length, 3);
  const root = layout.svg.parentElement;
  layout[Symbol.dispose]();
  assert.equal(layout.svg, null);
  assert.equal(root.style.overflow, 'hidden');
  renderer.dispose();
});

test('fractional angular ordering matches an independent exact binary-rational intersection check', () => {
  let seed = 391;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let round = 0; round < 30; round++) {
    const sources = Array.from({ length: 12 }, () => [random() * 100, random() * 200]),
      ports = sources.map((_, i) => [140, i * 20 + random()]);
    noCrossings(routeCalloutLeaders(sources, ports, 120), exactCross);
  }
});
