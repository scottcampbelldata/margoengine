import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Inspector } from '@margoengine/inspector';
import { EventMachine, EventTrace } from '../dist/events.js';
import { StateMachine } from '../dist/index.js';
import { ParallelRegions } from '../dist/parallel.js';
import { MachineView } from '../dist/inspect.js';

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
