import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TreeInspector } from '../dist/inspect.js';
import { BehaviorTree, action, selector, utility } from '../dist/index.js';

test('panel draws the whole hierarchy and updates statuses/scores without ticking the source', () => {
  const dom = new JSDOM('<main><p>keep</p></main>'),
    container = dom.window.document.querySelector('main');
  let score = 0.7;
  const tree = new BehaviorTree(
    selector(
      utility([{ score: 'value', child: { ...action('go'), label: '<script>safe</script>' } }]),
      action('fallback'),
    ),
    {
      trace: true,
      handlers: { scores: { value: () => score }, actions: { go: () => 'running', fallback: () => true } },
    },
  );
  const panel = new TreeInspector(tree, container, { autoRefresh: false });
  assert.equal(panel.element.querySelectorAll('[data-path]').length, 4);
  assert.match(panel.element.textContent, /No trace/);
  const details = panel.element.querySelector('details');
  details.open = false;
  tree.tick();
  panel.refresh();
  assert.equal(tree.ticks, 1);
  assert.equal(details.open, false);
  assert.equal(panel.element.querySelector('[data-path="root.children[0]"]').dataset.status, 'running');
  assert.equal(panel.element.querySelector('[data-path="root.children[1]"]').dataset.status, 'idle');
  assert.match(panel.element.textContent, /scores: 0.7/);
  assert.equal(panel.element.querySelector('script'), null);
  score = 0;
  tree.tick();
  panel.refresh();
  assert.equal(panel.element.querySelector('[data-path="root.children[0].options[0].child"]').dataset.status, 'idle');
  assert.match(panel.element.textContent, /scores: 0/);
  panel[Symbol.dispose]();
  panel.dispose();
  assert.equal(container.textContent, 'keep');
  assert.throws(() => panel.refresh(), /disposed/);
  dom.window.close();
});
test('automatic refresh, pause, resume and abort clean up their scheduled frame', () => {
  const dom = new JSDOM('<main/>'),
    w = dom.window;
  const pending = new Map();
  let id = 0;
  w.requestAnimationFrame = (fn) => {
    pending.set(++id, fn);
    return id;
  };
  w.cancelAnimationFrame = (key) => pending.delete(key);
  const controller = new AbortController();
  const tree = new BehaviorTree(action('go'), { trace: true, handlers: { actions: { go: () => true } } });
  const panel = new TreeInspector(tree, w.document.querySelector('main'), { signal: controller.signal });
  assert.equal(pending.size, 1);
  tree.tick();
  const [key, frame] = [...pending][0];
  pending.delete(key);
  frame();
  assert.match(panel.element.textContent, /Tick 1/);
  assert.equal(pending.size, 1);
  panel.element.querySelector('button').click();
  assert.equal(pending.size, 0);
  tree.tick();
  assert.match(panel.element.textContent, /Tick 1/);
  panel.element.querySelector('button').click();
  assert.match(panel.element.textContent, /Tick 2/);
  controller.abort();
  assert.equal(pending.size, 0);
  assert.equal(w.document.querySelector('section'), null);
  assert.throws(() => panel.resume(), /disposed/);
  const aborted = new TreeInspector(tree, w.document.querySelector('main'), { signal: controller.signal });
  assert.equal(aborted.element.isConnected, false);
  assert.equal(pending.size, 0);
  dom.window.close();
});
