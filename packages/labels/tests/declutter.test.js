import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { fakeEngine } from './fake-dom.js';
import { LabelRenderer } from '../dist/index.js';
import { Declutter, eightPositions, fourPositions } from '../dist/declutter.js';

// The fake canvas is 800 x 400 with the camera 5 units from z = 0 and a 60 degree fov: one world unit at z = 0 is
// 400 tan(30 deg)^-1 / 2 / 5 = 69.28 CSS pixels on both axes, centred on (400, 200).
const unit = (Math.sqrt(3) / 5) * 200;
const at = (x, y, z = 0) => [(x - 400) / unit, (200 - y) / unit, z];

function setup(layout, rendererOptions = {}) {
  const engine = fakeEngine(Camera);
  const renderer = new LabelRenderer({ layout, ...rendererOptions });
  renderer.setup(engine);
  renderer.registerPasses(engine.graph);
  const add = (x, y, options = {}, size = [40, 20]) => {
    const element = engine.document.createElement('div');
    let reads = 0;
    Object.defineProperty(element, 'offsetWidth', { get: () => (reads++, size[0]) });
    Object.defineProperty(element, 'offsetHeight', { get: () => size[1] });
    const label = renderer.add(element, { position: at(x, y, options.z), ...options });
    label.reads = () => reads;
    return label;
  };
  return { engine, renderer, add };
}
const shown = (label) => label.element.style.display === '';
/** The label's box on screen from its placed anchor, as the renderer drew it. */
const box = (label, [w, h] = [40, 20]) => {
  const s = label.scale,
    left = label.screen.x - label.placedAnchor[0] * w * s,
    top = label.screen.y - label.placedAnchor[1] * h * s;
  return [left, top, left + w * s, top + h * s];
};
const apart = (a, b, pad) => a[2] + pad <= b[0] || b[2] + pad <= a[0] || a[3] + pad <= b[1] || b[3] + pad <= a[1];

test('an overlapping label of lower priority is hidden, and shown again once the overlap is gone', () => {
  const declutter = new Declutter();
  const { engine, add } = setup(declutter);
  const high = add(400, 200, { priority: 2 });
  const low = add(410, 205, { priority: 1 });
  const free = add(600, 300);
  engine.frame();
  assert.ok(shown(high) && high.onScreen);
  assert.equal(low.element.style.display, 'none');
  assert.equal(low.onScreen, false);
  assert.ok(shown(free));
  assert.equal(declutter.hidden, 1);
  low.priority = 3;
  engine.frame();
  assert.ok(shown(low) && !shown(high), 'the higher priority now wins');
  low.setPosition(at(500, 100));
  engine.frame();
  assert.ok(shown(low) && shown(high) && declutter.hidden === 0);
});

test('without a declutter layout both overlapping labels stay', () => {
  const { engine, add } = setup(null);
  const a = add(400, 200),
    b = add(410, 205);
  engine.frame();
  assert.ok(shown(a) && shown(b));
});

test('positions move a label around its point before hiding it, and the moved box overlaps nothing', () => {
  const declutter = new Declutter({ positions: eightPositions, padding: 0 });
  const { engine, add } = setup(declutter);
  // The first box sits below left of the point; the second's centred box overlaps it, and above right is the first
  // of the eight that is free (it touches the first box at one corner, which padding 0 allows).
  const first = add(400, 200, { priority: 1, anchor: [1, 0] });
  const second = add(400, 200);
  engine.frame();
  assert.ok(shown(first) && shown(second));
  assert.deepEqual(first.placedAnchor, [1, 0]);
  assert.deepEqual(second.placedAnchor, [0, 1]);
  assert.deepEqual(second.anchor, [0.5, 0.5], 'the label keeps its own anchor for the next update');
  assert.match(second.element.style.transform, /translate\(0%,-100%\)$/);
  assert.equal(declutter.moved, 1);
  assert.ok(apart(box(first), box(second), 0));
  // Ten labels on one point: the four corners are the only boxes that do not overlap; the other six are hidden.
  const more = Array.from({ length: 8 }, () => add(400, 200, { priority: -1 }));
  engine.frame();
  const visible = [first, second, ...more].filter(shown);
  assert.deepEqual(
    visible.map((label) => label.placedAnchor.join()),
    ['1,0', '0,1', '1,1', '0,0'],
  );
  assert.equal(declutter.hidden, 6);
  for (let i = 0; i < visible.length; i++)
    for (let j = i + 1; j < visible.length; j++) assert.ok(apart(box(visible[i]), box(visible[j]), 0), `${i} ${j}`);
  assert.deepEqual(fourPositions, eightPositions.slice(0, 4));
  // Christensen, Marks and Shieber 1995, Figure 1: 1 above right, 2 above left, 3 below left, 4 below right, 5 right,
  // 6 above, 7 left, 8 below (anchors are the element's point placed on the label's point).
  assert.deepEqual(eightPositions, [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
    [0, 0.5],
    [0.5, 1],
    [1, 0.5],
    [0.5, 0],
  ]);
});

test('padding is the free gap: labels more than padding apart both show, closer ones do not', () => {
  const { engine, add } = setup(new Declutter({ padding: 6 }));
  const a = add(400, 200),
    b = add(447, 200);
  engine.frame();
  assert.ok(shown(a) && shown(b), `boxes ${box(a)} and ${box(b)}`);
  b.setPosition(at(445, 200));
  engine.frame();
  assert.ok(shown(a) && !shown(b));
});

test('inside keeps boxes in the view: a label at the edge moves inward', () => {
  const declutter = new Declutter({ inside: true, positions: fourPositions });
  const { engine, add } = setup(declutter);
  const edge = add(795, 100);
  engine.frame();
  assert.ok(shown(edge));
  assert.deepEqual(edge.placedAnchor, [1, 1], 'above left is the first corner inside the view');
  const corner = add(5, 5, { priority: 1 }, [20000, 20]);
  engine.frame();
  assert.ok(!shown(corner), 'a box wider than the view fits nowhere');
});

test('sticky: among equal priorities the label shown last keeps its place when the other comes nearer', () => {
  for (const sticky of [true, false]) {
    const { engine, add } = setup(new Declutter({ sticky }));
    const a = add(400, 200, { z: 1 }),
      b = add(400, 200, { z: 0 });
    engine.frame();
    assert.ok(shown(a) && !shown(b), 'nearer first');
    a.setPosition([a.position[0], a.position[1], -1]);
    engine.frame();
    assert.equal(shown(a), sticky, `sticky ${sticky}`);
    assert.equal(shown(b), !sticky);
  }
});

test('distance scaling scales the box, sizes are measured once until remeasure, and a still frame writes nothing', () => {
  const { engine, renderer, add } = setup(new Declutter());
  const a = add(400, 200, { distanceScale: 10 }),
    b = add(445, 200, { distanceScale: 10 });
  engine.frame();
  // Scale 2 makes each box 80 wide: 45 px apart they overlap; at scale 1 (40 wide) they would not.
  assert.equal(a.scale, 2);
  assert.ok(shown(a) && !shown(b));
  a.distanceScale = b.distanceScale = 5;
  engine.frame();
  assert.ok(shown(a) && shown(b));
  engine.frame();
  assert.equal(renderer.writes, 0);
  assert.equal(a.reads(), 1);
  a.remeasure();
  engine.frame();
  assert.equal(a.reads(), 2);
  assert.equal(renderer.writes, 0, 'measuring a shown label changes nothing');
});

test('a hidden label is measured shown, then hidden in the same update', () => {
  const { engine, renderer, add } = setup(new Declutter());
  const a = add(400, 200, { priority: 1 });
  const b = add(400, 200);
  engine.frame();
  assert.equal(b.reads(), 1);
  assert.equal(b.element.style.display, 'none');
  engine.frame();
  assert.equal(renderer.writes, 0, 'a label kept hidden writes nothing');
  assert.ok(shown(a));
});

test('many labels: the grid finds the same placement as testing every pair, and the result repeats', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const points = Array.from({ length: 400 }, () => [
    random() * 800,
    random() * 400,
    Math.floor(random() * 4),
    random() * 2 - 1,
  ]);
  const run = () => {
    const declutter = new Declutter({ positions: fourPositions, padding: 3, cell: 32 });
    const { engine, add } = setup(declutter);
    const labels = points.map(([x, y, priority, z]) => add(x, y, { priority, z }));
    engine.frame();
    return { labels, declutter };
  };
  const { labels, declutter } = run();
  const visible = labels.filter(shown);
  assert.ok(visible.length > 50 && declutter.hidden > 50, `${visible.length} shown, ${declutter.hidden} hidden`);
  for (let i = 0; i < visible.length; i++)
    for (let j = i + 1; j < visible.length; j++) assert.ok(apart(box(visible[i]), box(visible[j]), 3));
  // Reference: the same greedy order with every accepted box tested, no grid.
  const candidates = labels.filter((label) => label.screen.inFront && label.screen.inFrustum);
  assert.ok(candidates.length > 300);
  const order = candidates
    .map((label, i) => i)
    .sort(
      (a, b) =>
        candidates[b].priority - candidates[a].priority || candidates[a].distance - candidates[b].distance || a - b,
    );
  const accepted = [],
    expect = new Map();
  for (const i of order) {
    const label = candidates[i];
    expect.set(label, null);
    for (const anchor of [label.anchor, ...fourPositions]) {
      const left = label.screen.x - anchor[0] * 40,
        top = label.screen.y - anchor[1] * 20,
        r = [left, top, left + 40, top + 20];
      if (accepted.every((other) => apart(r, other, 3))) {
        accepted.push(r);
        expect.set(label, anchor);
        break;
      }
    }
  }
  for (const label of candidates) {
    const anchor = expect.get(label);
    assert.equal(shown(label), anchor !== null);
    if (anchor) assert.deepEqual(label.placedAnchor, [...anchor]);
  }
  const again = run();
  assert.deepEqual(again.labels.map(shown), labels.map(shown));
});

test('options and priorities are checked', () => {
  assert.throws(() => new Declutter({ padding: -1 }), /padding must be a finite number/);
  assert.throws(() => new Declutter({ cell: 0 }), /cell must be/);
  assert.throws(() => new Declutter({ positions: [[0, Number.NaN]] }), /positions must be \[x, y\] anchors/);
  assert.throws(() => new Declutter({ positions: 'eight' }), /positions must be/);
  const { add } = setup(new Declutter());
  assert.throws(
    () => add(0, 0, { priority: Number.NaN }),
    /priority must be a number; see https:\/\/margoengine.com\/errors#labels/,
  );
  const label = add(0, 0, { priority: Infinity });
  assert.equal(label.priority, Infinity);
  assert.throws(() => (label.priority = Number.NaN), /priority must be a number/);
});

test('a layout gets only labels that passed culling, and can place them with any anchor', () => {
  const seen = [];
  const layout = {
    arrange(labels, context) {
      seen.push(labels.length, context.width, context.height);
      context.place(labels[0], [1, 0]);
      assert.throws(() => context.place(labels[0], [Number.NaN, 0]), /place\(label, anchor\) takes two finite numbers/);
    },
  };
  const { engine, renderer, add } = setup(layout);
  const label = add(400, 200);
  add(400, 200, { z: 9 }); // behind the camera
  engine.frame();
  assert.deepEqual(seen, [1, 800, 400]);
  assert.match(label.element.style.transform, /translate\(-100%,0%\)$/);
  assert.deepEqual(label.placedAnchor, [1, 0]);
  renderer.layout = null;
  engine.frame();
  assert.match(label.element.style.transform, /translate\(-50%,-50%\)$/);
});
