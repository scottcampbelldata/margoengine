import test from 'node:test';
import assert from 'node:assert/strict';
import { LayoutDocument, LayoutEditor } from '../dist/editor.js';
import { makeUi } from './helpers.js';
import { JSDOM } from 'jsdom';
const source = {
  markup: '<panel id="menu"><label id="name">Mars</label><button id="go">Explore</button></panel>',
  styles: '#menu { width: 300; gap: 12; padding: 20 }',
};
test('source/style edits are atomic, history is bounded, branching drops redo, persisted source is exact', () => {
  const d = new LayoutDocument(source, { historyLimit: 2 });
  d.apply({ styles: '#menu { width: 400 }' });
  d.setText('name', 'Earth & Moon');
  assert.equal(d.build().get('name').text, 'Earth & Moon');
  const valid = d.source;
  assert.throws(() => d.apply({ markup: '<panel>' }), TypeError);
  assert.deepEqual(d.source, valid);
  assert.throws(() => d.apply({ styles: '#menu { width: nope; }' }), TypeError);
  assert.deepEqual(d.source, valid);
  assert.equal(d.undo(), true);
  assert.equal(d.build().get('name').text, 'Mars');
  assert.equal(d.redo(), true);
  d.undo();
  d.apply({ styles: '#menu { width: 500 }' });
  assert.equal(d.canRedo, false);
  const saved = d.save(),
    copy = new LayoutDocument({ markup: '', styles: '' });
  copy.load(saved);
  assert.deepEqual(copy.source, d.source);
  assert.throws(() => copy.load('{bad'), TypeError);
  assert.throws(() => copy.load('{"version":2}'), RangeError);
  assert.deepEqual(copy.source, d.source);
  d.dispose();
  copy.dispose();
});
test('visual attributes, insertion, removal and hierarchy moves round trip and reject cycles', () => {
  const d = new LayoutDocument(source);
  const id = d.insert('button', 'menu');
  d.setText(id, 'Click <here> "now"');
  d.setAttribute(id, 'width', '120');
  assert.equal(d.build().get(id).style.width, 120);
  assert.equal(d.build().get(id).text, 'Click <here> "now"');
  d.move(id, undefined, 0);
  assert.equal(d.tree[0].attributes.id, id);
  d.undo();
  assert.throws(() => d.move('menu', 'name'), RangeError);
  assert.throws(() => d.move('go', 'name'), TypeError);
  assert.equal(d.tree[0].tag, 'panel');
  d.remove(id);
  assert.equal(d.build().get(id), undefined);
  d.undo();
  assert.ok(d.build().get(id));
  d.setAttribute(id, 'width', undefined);
  assert.equal(d.build().get(id).style.width, undefined);
  assert.throws(() => d.setAttribute(id, 'bad name', 'x'), TypeError);
});
test('editor mounts, validates live draft, updates properties and restores its canvas on disposal', () => {
  const dom = new JSDOM(
      '<div id="host"></div><div id="old"><canvas></canvas><div data-margo-ui="mirror"></div><span id="after"></span></div>',
    ),
    ui = makeUi(),
    canvas = dom.window.document.querySelector('canvas'),
    host = dom.window.document.querySelector('#host');
  // Native events and abort signals must come from the same document realm.
  const prior = globalThis.AbortController;
  globalThis.AbortController = dom.window.AbortController;
  try {
    const editor = new LayoutEditor(host, { ui, canvas, ...source }),
      root = editor.element.shadowRoot,
      markup = root.querySelector('[aria-label="Markup"]');
    assert.equal(root.querySelector('canvas'), canvas);
    assert.ok(root.querySelector('[data-margo-ui=mirror]'));

    assert.deepEqual(JSON.parse(editor.document.save()), { version: 1, ...source });
    markup.value = '<label id="next">Earth</label>';
    markup.dispatchEvent(new dom.window.Event('input'));
    assert.equal(editor.document.build().get('next').text, 'Earth');
    markup.value = '<label>';
    markup.dispatchEvent(new dom.window.Event('input'));
    assert.equal(editor.document.build().get('next').text, 'Earth');
    assert.match(root.querySelector('output').value, /Markup/);
    const select = [...root.querySelectorAll('[role=treeitem]')].find((b) => b.textContent.includes('next'));
    select.click();
    const width = root.querySelector('[aria-label="Selected width"]');
    width.value = '200';
    width.dispatchEvent(new dom.window.Event('change'));
    assert.equal(editor.document.build().get('next').style.width, 200);
    editor.dispose();
    editor.dispose();
    assert.equal(canvas.parentElement.id, 'old');
    assert.equal(canvas.nextElementSibling.dataset.margoUi, 'mirror');
    assert.equal(canvas.nextElementSibling.nextElementSibling.id, 'after');
    canvas.nextElementSibling.remove();
    const second = new LayoutEditor(host, { ui, canvas, ...source }),
      late = dom.window.document.createElement('div');
    late.dataset.margoUi = 'mirror';
    canvas.after(late);
    second.dispose();
    assert.equal(canvas.nextElementSibling, late);
    assert.equal(late.nextElementSibling.id, 'after');
    assert.equal(host.children.length, 0);
    assert.equal(ui.root.children.length, 0);
  } finally {
    globalThis.AbortController = prior;
    ui.dispose();
    dom.window.close();
  }
});
