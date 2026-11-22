// Pins MachineView where inspect.test.js leaves it open: the capacity range and default, where it mounts and styles
// itself, live refresh only when asked, every frame scheduling the next, state rows (name, indent, trigger text)
// and the trace row text for the root machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { StateMachine } from '../dist/index.js';
import { FinalMachine } from '../dist/final.js';
import { MachineTrace } from '../dist/trace.js';
import { MachineView } from '../dist/inspect.js';

const page = () => new JSDOM('<body></body>');

test('capacity is a whole number from 1 to 10,000, checked by the view itself, default 32', () => {
  const dom = page();
  const m = new StateMachine({ a: {}, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', event: 'go' },
    { from: 'b', to: 'a', event: 'go' },
  ]);
  using trace = new MachineTrace(m, { capacity: 20000 });
  const parent = dom.window.document.body;
  for (const capacity of [0, 10001, 1.5, NaN, Infinity, -1])
    assert.throws(
      () => new MachineView(m, { parent, trace, capacity, live: false }),
      /Invalid view capacity/,
      String(capacity),
    );
  for (const capacity of [1, 10000]) new MachineView(m, { parent, trace, capacity, live: false }).dispose();
  for (let i = 0; i < 40; i++) m.send('go');
  using view = new MachineView(m, { parent, trace, live: false });
  assert.equal(view.element.shadowRoot.querySelectorAll('[data-trace] li').length, 32);
  dom.window.close();
});

test('with a parent the view mounts in it, unstyled, even beside an inspector or in a host with a shadow root', () => {
  const dom = page();
  const doc = dom.window.document;
  const parent = doc.createElement('div');
  parent.attachShadow({ mode: 'open' });
  doc.body.append(parent);
  const inspector = { element: doc.createElement('section') };
  inspector.element.attachShadow({ mode: 'open' });
  const m = new StateMachine({ a: {} }, 'a', {});
  using view = new MachineView(m, { parent, inspector, live: false });
  assert.equal(view.element.parentNode, parent);
  assert.equal(view.element.style.cssText, '');
  using floating = new MachineView(m, { inspector, trace: { records: [] }, live: false });
  assert.equal(floating.element.parentNode, inspector.element.shadowRoot);
  assert.match(floating.element.style.cssText, /position: fixed/);
  dom.window.close();
});

test('live: false never asks for a frame; live refresh asks for the next frame on every frame', () => {
  const dom = page();
  const queued = [];
  dom.window.requestAnimationFrame = (cb) => queued.push(cb);
  dom.window.cancelAnimationFrame = () => {};
  const m = new StateMachine({ a: {} }, 'a', {});
  const still = new MachineView(m, { parent: dom.window.document.body, trace: { records: [] }, live: false });
  assert.equal(queued.length, 0);
  still.dispose();
  const view = new MachineView(m, { parent: dom.window.document.body, trace: { records: [] } });
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.equal(queued.length, 1, 'the first frame schedules a second');
  queued.shift()();
  assert.equal(queued.length, 1, 'and that one a third');
  view.dispose();
  dom.window.close();
});

test('state rows: the summary is the name, nesting indents 16px a level, and triggers read as authored', () => {
  const dom = page();
  const m = new FinalMachine(
    { top: { initial: 'mid' }, mid: { parent: 'top', initial: 'leaf' }, leaf: { parent: 'mid' }, other: {} },
    'top',
    {},
    [{ from: 'leaf', to: 'other', event: 'go', always: undefined }],
  );
  using view = new MachineView(m, { parent: dom.window.document.body, live: false });
  const root = view.element.shadowRoot;
  const row = (name) => root.querySelector(`[data-state=${name}]`);
  assert.deepEqual(
    ['top', 'mid', 'leaf'].map((n) => [row(n).querySelector('summary').textContent, row(n).style.marginLeft]),
    [
      ['top', '0px'],
      ['mid', '16px'],
      ['leaf', '32px'],
    ],
  );
  assert.equal(row('leaf').querySelector('pre').textContent, 'go -> other');
  assert.equal(row('other').querySelector('pre').textContent, 'No outgoing transitions');
  m.send('go');
  view.refresh();
  assert.equal(root.querySelector('[data-trace] li').textContent, '0s root: leaf -> other [go]');
  dom.window.close();
});
