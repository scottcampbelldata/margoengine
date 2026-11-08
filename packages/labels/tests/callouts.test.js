import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { fakeEngine } from './fake-dom.js';
import { LabelRenderer } from '../dist/index.js';
import { Declutter } from '../dist/declutter.js';
import { Callouts } from '../dist/callouts.js';

// The fake canvas is 800 x 400 with the camera 5 units from z = 0 and a 60 degree fov: one world unit at z = 0 is
// 69.28 CSS pixels on both axes, centred on (400, 200).
const unit = (Math.sqrt(3) / 5) * 200;
const at = (x, y, z = 0) => [(x - 400) / unit, (200 - y) / unit, z];

function setup(layout) {
  const engine = fakeEngine(Camera);
  const renderer = new LabelRenderer({ layout });
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
const lines = (callouts) => (callouts.svg?.children ?? []).filter((e) => e.tagName === 'LINE');
const dots = (callouts) => (callouts.svg?.children ?? []).filter((e) => e.tagName === 'CIRCLE');
const ends = (line) => ['x1', 'y1', 'x2', 'y2'].map((name) => Number(line.getAttribute(name)));
const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.02);

test('a moved label gets a line from its point to the nearest point of its box, and a dot on the point', () => {
  const callouts = new Callouts();
  const { engine, renderer, add } = setup(callouts);
  const label = add(400, 200, { screenOffset: [60, -40] });
  engine.frame();
  // Box centred on (460, 160): 440..480 by 150..170; its nearest point to (400, 200) is its lower left corner.
  assert.match(label.element.style.transform, /^translate\(460px,160px\)/);
  assert.equal(callouts.lines, 1);
  const svg = callouts.svg;
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(renderer.root.children[0], svg, 'the lines sit under the labels');
  assert.equal(svg.style.zIndex, '0');
  assert.equal(svg.style.pointerEvents, 'none');
  const [line] = lines(callouts),
    [dot] = dots(callouts);
  assert.ok(near(ends(line), [400, 200, 440, 170]), `line ${ends(line)}`);
  assert.equal(line.getAttribute('stroke'), 'currentColor');
  assert.equal(line.getAttribute('stroke-width'), '1');
  assert.ok(near([+dot.getAttribute('cx'), +dot.getAttribute('cy'), +dot.getAttribute('r')], [400, 200, 2]));
  // Below and to the right of its point: the line ends on the box's upper left corner.
  label.screenOffset = [70, 50];
  engine.frame();
  assert.ok(near(ends(line), [400, 200, 450, 240]), `line ${ends(line)}`);
  // Straight above: the line meets the middle of the box's lower edge.
  label.screenOffset = [0, -60];
  engine.frame();
  assert.ok(near(ends(line), [400, 200, 400, 150]), `line ${ends(line)}`);
});

test('no line for a label on its point, and such labels are not measured', () => {
  const callouts = new Callouts({ dot: 0 });
  const { engine, add } = setup(callouts);
  const plain = add(400, 200);
  const corner = add(300, 100, { anchor: [0, 1] });
  const close = add(500, 300, { anchor: [0, 0.5], screenOffset: [1.5, 0] });
  const moved = add(600, 100, { screenOffset: [0, 40] });
  engine.frame();
  assert.equal(callouts.lines, 1, 'only the moved label gets a line');
  assert.equal(plain.reads(), 0);
  assert.equal(corner.reads(), 0);
  assert.equal(close.reads(), 1, 'an offset label is measured');
  assert.equal(moved.reads(), 1);
  assert.equal(dots(callouts).length, 0, 'dot: 0 draws no dot');
  assert.ok(near(ends(lines(callouts)[0]), [600, 100, 600, 130]));
});

test('lines follow their labels, hide with them, go with removed labels, and still frames write nothing', () => {
  const callouts = new Callouts();
  const { engine, renderer, add } = setup(callouts);
  const a = add(400, 200, { screenOffset: [60, -40] });
  const b = add(200, 200, { screenOffset: [-60, 40] });
  engine.frame();
  assert.equal(callouts.lines, 2);
  const [la, lb] = lines(callouts);
  engine.frame();
  assert.equal(callouts.writes, 0, 'a still frame writes no attribute');
  assert.equal(renderer.writes, 0);
  a.setPosition(at(420, 210));
  engine.frame();
  assert.ok(near(ends(la).slice(0, 2), [420, 210]), 'the line follows its label');
  b.visible = false;
  engine.frame();
  assert.equal(lb.getAttribute('display'), 'none', 'a hidden label hides its line');
  assert.equal(dots(callouts)[1].getAttribute('display'), 'none');
  a.setPosition(at(400, 200, 9)); // behind the camera: no label reaches the layout
  engine.frame();
  assert.equal(la.getAttribute('display'), 'none', 'the layout runs with no labels and hides every line');
  assert.equal(callouts.lines, 0);
  a.setPosition(at(400, 200));
  b.visible = true;
  engine.frame();
  assert.equal(la.getAttribute('display'), 'inline');
  assert.equal(lb.getAttribute('display'), 'inline');
  b.remove();
  engine.frame();
  assert.equal(lines(callouts).length, 1, "a removed label's line is deleted");
  assert.equal(dots(callouts).length, 1);
  const svg = callouts.svg;
  callouts.clear();
  assert.equal(callouts.svg, null);
  assert.equal(renderer.root.children.includes(svg), false);
  engine.frame();
  assert.equal(lines(callouts).length, 1, 'drawn again after clear()');
});

test('Callouts keeps the decisions of the layout it wraps, and Declutter boxes use the offset', () => {
  const callouts = new Callouts({ layout: new Declutter() });
  const { engine, add } = setup(callouts);
  const a = add(400, 200, { screenOffset: [60, -40], priority: 2 });
  const b = add(400, 200, { screenOffset: [60, -40], priority: 1 });
  // No offset: its box is where a's moved box is (440..480 by 150..170).
  const c = add(460, 160, { priority: 0 });
  const d = add(400, 300, { priority: 3 });
  engine.frame();
  assert.equal(a.onScreen, true);
  assert.equal(b.onScreen, false, 'same offset box, lower priority: hidden');
  assert.equal(c.onScreen, false, 'Declutter tests the moved box');
  assert.equal(d.onScreen, true);
  assert.equal(callouts.lines, 1, 'the hidden label gets no line');
  b.screenOffset = [-60, 40];
  engine.frame();
  assert.equal(b.onScreen, true);
  assert.equal(callouts.lines, 2);
  // A wrapped layout that places a label with an anchor outside the element moves it off its point: a line.
  const placer = {
    arrange(labels, context) {
      for (const label of labels) context.place(label, [-1, 0.5]);
    },
  };
  const other = new Callouts({ layout: placer });
  const second = setup(other);
  const e = second.add(400, 200);
  second.engine.frame();
  assert.deepEqual(e.placedAnchor, [-1, 0.5]);
  assert.ok(near(ends(lines(other)[0]), [400, 200, 440, 200]), `line ${ends(lines(other)[0])}`);
});

test('options are checked', () => {
  assert.throws(() => new Callouts({ width: -1 }), /width must be a finite number of CSS pixels, 0 or more/);
  assert.throws(() => new Callouts({ dot: Number.NaN }), /dot must be a finite number of CSS pixels, 0 or more/);
  assert.throws(() => new Callouts({ minLength: Infinity }), /minLength must be a finite number of CSS pixels/);
  const { add } = setup(new Callouts());
  assert.throws(() => add(400, 200, { screenOffset: [Number.NaN, 0] }), /screenOffset must be two finite numbers/);
  const styled = new Callouts({ color: '#f80', width: 2, className: 'leaders' });
  const second = setup(styled);
  second.add(400, 200, { screenOffset: [0, -50] });
  second.engine.frame();
  assert.equal(styled.svg.getAttribute('class'), 'leaders');
  assert.equal(lines(styled)[0].getAttribute('stroke'), '#f80');
  assert.equal(lines(styled)[0].getAttribute('stroke-width'), '2');
});
