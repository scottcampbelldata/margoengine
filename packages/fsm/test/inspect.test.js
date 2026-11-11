import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Inspector } from '@margoengine/inspector';
import { EventMachine, EventTrace } from '../dist/events.js';
import { StateMachine } from '../dist/index.js';
import { ParallelRegions } from '../dist/parallel.js';
import { MachineView } from '../dist/inspect.js';
import { FinalMachine } from '../dist/final.js';

test('disclosures retain current open state across transitions, filtering and same-named regions', () => {
  const dom = new JSDOM('<body></body>');
  const regions = new ParallelRegions(Object.fromEntries(['left', 'right'].map(name => [name, {
    states: { idle: {}, run: {} }, initial: 'idle', transitions: [{ from: 'idle', to: 'run', event: 'go' }],
  }])), {});
  const m = new StateMachine({ p: regions.asState() }, 'p', {});
  using view = new MachineView(m, { parent: dom.window.document.body, live: false });
  const root = view.element.shadowRoot;
  const row = name => root.querySelector(`[data-machine="root/p/${name}"] [data-state=idle]`);
  row('left').open = true;
  m.send('go'); view.refresh();
  assert.equal(row('left').open, true);
  assert.equal(row('right').open, false);
  assert.equal(row('left').hasAttribute('aria-current'), false);
  view.refresh('run'); view.refresh();
  assert.equal(row('left').open, true);
  // Read open synchronously, without waiting for HTML's queued toggle event.
  row('left').open = false; view.refresh('idle');
  assert.equal(row('left').open, false);
  dom.window.close();
});

test('optional runtime topology shows authored always, delay and event triggers as text without calling guards', () => {
  const dom = new JSDOM('<body></body>');
  let calls = 0;
  const m = new FinalMachine({ a: {}, b: {} }, 'a', {}, [
    { from: 'a', to: 'b', always: true, guard: () => { calls++; return false; } },
    { from: 'a', to: 'b', after: 2 },
    { from: 'a', to: 'b', event: '<img src=x onerror=bad()>' },
  ]);
  const before = calls;
  using view = new MachineView(m, { parent: dom.window.document.body, live: false });
  const root = view.element.shadowRoot;
  assert.equal(root.querySelector('[data-state=a] pre').textContent,
    'always -> b\nafter 2s -> b\n<img src=x onerror=bad()> -> b');
  assert.equal(root.querySelector('img'), null);
  assert.equal(calls, before);
  m.update(2); view.refresh();
  assert.match(root.querySelector('[data-trace]').textContent, /after 2s/);
  assert.equal(root.textContent.includes('\0fsm.'), false);
  dom.window.close();
});

test('view mounts in the real inspector shadow tree, draws active hierarchy history and recent trace', () => {
  const dom = new JSDOM('<body></body>');
  using inspector = new Inspector({ parent: dom.window.document.body });
  const m = new StateMachine({ play: { history: 'deep' }, idle: { parent: 'play' }, run: { parent: 'play' }, pause: {} }, 'idle', {},
    [{ from: 'idle', to: 'run', event: 'go' }, { from: 'play', to: 'pause', event: 'pause' }]);
  using view = new MachineView(m, { inspector, live: false, capacity: 1 });
  assert.equal(view.element.parentNode, inspector.element.shadowRoot);
  const root = view.element.shadowRoot;
  assert.equal(root.querySelectorAll('[aria-current=true]').length, 2);
  m.send('go'); m.send('pause'); view.refresh();
  assert.equal(root.querySelector('[data-history]').textContent, 'play: run');
  assert.equal(root.querySelectorAll('[data-trace] li').length, 1);
  assert.match(root.querySelector('[data-trace]').textContent, /pause/);
  assert.equal(root.querySelector('[data-state=pause]').getAttribute('aria-current'), 'true');
  view.refresh('run'); assert.equal(root.querySelectorAll('[data-state]').length, 1);
  view.dispose(); assert.equal(m.listener, null);
  dom.window.close();
});

test('cyclic payloads and markup state names render as text; supplied traces stay attached', () => {
  const dom = new JSDOM('<body></body>');
  const name = '<script>bad()</script>';
  const m = new EventMachine({ a: {}, [name]: {} }, 'a', {}, [{ from: 'a', to: name, event: 'go' }]);
  using trace = new EventTrace(m);
  const payload = {}; payload.self = payload;
  const view = new MachineView(m, { parent: dom.window.document.body, trace, live: false });
  m.send('go', payload); assert.doesNotThrow(() => view.refresh());
  assert.equal(view.element.shadowRoot.querySelector('script'), null);
  assert.match(view.element.shadowRoot.textContent, /<script>bad/);
  view.dispose(); assert.notEqual(m.listener, null);
  dom.window.close();
});

test('animation frames refresh the view and abort cancels its frame and trace listener', () => {
  const dom = new JSDOM('<body></body>');
  const queued = new Map(); let id = 0;
  dom.window.requestAnimationFrame = cb => { queued.set(++id, cb); return id; };
  dom.window.cancelAnimationFrame = key => queued.delete(key);
  const m = new StateMachine({ a: {}, b: {} }, 'a', {}, [{ from: 'a', to: 'b', event: 'go' }]);
  const controller = new AbortController();
  const view = new MachineView(m, { parent: dom.window.document.body, signal: controller.signal });
  m.send('go'); const [key, tick] = queued.entries().next().value; queued.delete(key); tick();
  assert.equal(view.element.shadowRoot.querySelector('[data-state=b]').getAttribute('aria-current'), 'true');
  controller.abort(); assert.equal(queued.size, 0); assert.equal(m.listener, null); assert.equal(view.element.isConnected, false);
  dom.window.close();
});

test('parallel regions show their separate active paths and history', () => {
  const dom = new JSDOM('<body></body>');
  const regions = new ParallelRegions({ legs: { states: { stand: {}, walk: {} }, initial: 'stand', transitions: [{ from: 'stand', to: 'walk', event: 'go' }] } }, {});
  const m = new StateMachine({ p: regions.asState() }, 'p', {});
  using view = new MachineView(m, { parent: dom.window.document.body, live: false });
  m.send('go'); view.refresh();
  assert.match(view.element.shadowRoot.textContent, /root\/p\/legs: walk/);
  dom.window.close();
});
