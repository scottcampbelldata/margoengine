import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  Button,
  Dialog,
  Inventory,
  Label,
  List,
  Panel,
  ProgressBar,
  Slider,
  Toggle,
  VirtualList,
  createTheme,
  themes,
} from '../dist/index.js';
import { mountDom, stayingInOrder } from '../dist/dom-host.js';
import { Checkbox, RadioGroup, Select, Tabs } from '../dist/forms.js';
import { TextArea, TextInput } from '../dist/input.js';
import { makeUi } from './helpers.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function page() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><main id="host"></main></body></html>');
  const { window } = dom;
  return { window, doc: window.document, host: window.document.getElementById('host') };
}

function mount(build, options = {}) {
  const env = page(),
    ui = makeUi();
  const widgets = build(ui);
  const host = mountDom(ui, env.host, { update: false, ...options });
  return { ...env, ui, host, widgets };
}

test('every widget class maps to its native element and role', () => {
  const { host, widgets } = mount((ui) => {
    const w = {
      label: new Label({ text: 'Hello', size: 'title' }),
      button: new Button({ text: 'Save', variant: 'primary' }),
      toggle: new Toggle({ text: 'Sound', checked: true }),
      checkbox: new Checkbox({ text: 'Agree' }),
      slider: new Slider({ label: 'Volume', min: 0, max: 10, value: 4 }),
      progress: new ProgressBar({ label: 'Loading', value: 0.5 }),
      list: new List({ label: 'Saves', items: ['Dawn', 'Noon', 'Dusk'], selected: 1 }),
      select: new Select({
        label: 'Quality',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
        value: 'high',
      }),
      radio: new RadioGroup({
        label: 'Speed',
        options: [
          { value: 'slow', label: 'Slow' },
          { value: 'fast', label: 'Fast' },
        ],
        value: 'fast',
      }),
      text: new TextInput({ label: 'Name', value: 'Ada', maxLength: 20, required: true }),
      area: new TextArea({ label: 'Notes', placeholder: 'Write here' }),
      group: new Panel({ label: 'Tools', direction: 'row', gap: 8 }),
      inventory: new Inventory({ slots: 2, items: [{ label: 'Key' }, null] }),
    };
    ui.add(new Panel({ gap: 12, children: Object.values(w) }));
    return w;
  });
  const el = (w) => host.elementOf(w);
  assert.equal(el(widgets.label).tagName, 'P');
  assert.equal(el(widgets.label).textContent, 'Hello');
  assert.equal(el(widgets.label).dataset.size, 'title');
  assert.equal(el(widgets.button).tagName, 'BUTTON');
  assert.equal(el(widgets.button).getAttribute('type'), 'button');
  assert.equal(el(widgets.button).dataset.variant, 'primary');
  const toggle = el(widgets.toggle).querySelector('input');
  assert.equal(toggle.type, 'checkbox');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.checked, true);
  assert.equal(el(widgets.toggle).tagName, 'LABEL');
  assert.equal(el(widgets.toggle).textContent, 'Sound');
  const checkbox = el(widgets.checkbox).querySelector('input');
  assert.equal(checkbox.type, 'checkbox');
  assert.equal(checkbox.hasAttribute('role'), false);
  const range = el(widgets.slider).querySelector('input');
  assert.equal(range.type, 'range');
  assert.equal(range.value, '4');
  assert.equal(range.max, '10');
  assert.equal(el(widgets.slider).textContent, 'Volume');
  assert.equal(el(widgets.progress).tagName, 'PROGRESS');
  assert.equal(el(widgets.progress).value, 0.5);
  assert.equal(el(widgets.progress).getAttribute('aria-label'), 'Loading');
  assert.equal(el(widgets.list).getAttribute('role'), 'listbox');
  const options = [...el(widgets.list).querySelectorAll('[role=option]')];
  assert.deepEqual(
    options.map((o) => [o.textContent, o.getAttribute('aria-selected'), o.getAttribute('tabindex')]),
    [
      ['Dawn', 'false', '-1'],
      ['Noon', 'true', '0'],
      ['Dusk', 'false', '-1'],
    ],
  );
  const select = el(widgets.select);
  assert.equal(select.tagName, 'SELECT');
  assert.deepEqual(
    [...select.options].map((o) => o.value),
    ['low', 'high'],
  );
  assert.equal(select.value, 'high');
  const fieldset = el(widgets.radio);
  assert.equal(fieldset.tagName, 'FIELDSET');
  assert.equal(fieldset.querySelector('legend').textContent, 'Speed');
  const radios = [...fieldset.querySelectorAll('input[type=radio]')];
  assert.deepEqual(
    radios.map((r) => r.checked),
    [false, true],
  );
  assert.equal(new Set(radios.map((r) => r.name)).size, 1);
  const text = el(widgets.text);
  assert.equal(text.tagName, 'INPUT');
  assert.equal(text.value, 'Ada');
  assert.equal(text.getAttribute('maxlength'), '20');
  assert.equal(text.hasAttribute('required'), true);
  assert.equal(text.getAttribute('aria-label'), 'Name');
  assert.equal(el(widgets.area).tagName, 'TEXTAREA');
  assert.equal(el(widgets.area).getAttribute('placeholder'), 'Write here');
  assert.equal(el(widgets.group).getAttribute('role'), 'group');
  assert.equal(el(widgets.group).style.getPropertyValue('flex-direction'), 'row');
  assert.equal(el(widgets.group).style.getPropertyValue('gap'), '8px');
  assert.equal(el(widgets.inventory).getAttribute('role'), 'group');
  assert.equal(el(widgets.inventory).querySelectorAll('button').length, 2);
});

test('widget changes patch their element only, keeping the focused element', async () => {
  const { doc, host, widgets } = mount((ui) => {
    const w = {
      label: new Label({ text: 'Before' }),
      name: new TextInput({ label: 'Name', value: 'Ada' }),
      bar: new ProgressBar({ value: 0.1 }),
      toggle: new Toggle({ text: 'Music' }),
    };
    ui.add(new Panel({ children: Object.values(w) }));
    return w;
  });
  const field = host.elementOf(widgets.name),
    label = host.elementOf(widgets.label);
  field.focus();
  assert.equal(doc.activeElement, field);
  field.setSelectionRange(1, 2);
  widgets.label.text = 'After';
  widgets.bar.value = 0.75;
  widgets.toggle.checked = true;
  await tick();
  assert.equal(host.elementOf(widgets.label), label, 'the same element is patched, not rebuilt');
  assert.equal(label.textContent, 'After');
  assert.equal(host.elementOf(widgets.bar).value, 0.75);
  assert.equal(host.elementOf(widgets.toggle).querySelector('input').checked, true);
  assert.equal(doc.activeElement, field, 'focus stays in the text field');
  assert.equal(host.elementOf(widgets.name), field);
});

test('elements drive the widgets: their own events fire as on the canvas', async () => {
  const { window, host, widgets, ui } = mount((ui) => {
    const w = {
      button: new Button({ text: 'Go' }),
      toggle: new Toggle({ text: 'Sound' }),
      slider: new Slider({ label: 'Volume', min: 0, max: 10, value: 1 }),
      list: new List({ items: ['A', 'B'] }),
      select: new Select({
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        value: 'a',
      }),
      radio: new RadioGroup({
        options: [
          { value: 'x', label: 'X' },
          { value: 'y', label: 'Y' },
        ],
        value: 'x',
      }),
      text: new TextInput({ label: 'Name' }),
    };
    ui.add(new Panel({ children: Object.values(w) }));
    return w;
  });
  const events = [];
  for (const [name, w] of Object.entries(widgets))
    for (const type of name === 'text' ? ['change', 'submit'] : ['click', 'change', 'select', 'submit'])
      w.on(type, (e) => events.push([name, type, e.value ?? e.index]));
  host.elementOf(widgets.button).click();
  host.elementOf(widgets.toggle).querySelector('input').click();
  const range = host.elementOf(widgets.slider).querySelector('input');
  range.value = '7';
  range.dispatchEvent(new window.Event('input', { bubbles: true }));
  host.elementOf(widgets.list).querySelectorAll('[role=option]')[1].click();
  const select = host.elementOf(widgets.select);
  select.value = 'b';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  host.elementOf(widgets.radio).querySelectorAll('input')[1].click();
  const field = host.elementOf(widgets.text);
  field.focus();
  field.value = 'Grace';
  field.setSelectionRange(5, 5);
  field.dispatchEvent(new window.Event('input', { bubbles: true }));
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(events, [
    ['button', 'click', undefined],
    ['toggle', 'change', true],
    ['slider', 'change', 7],
    ['list', 'select', 1],
    ['select', 'change', 'b'],
    ['radio', 'change', 'y'],
    ['text', 'change', 'Grace'],
    ['text', 'submit', 'Grace'],
  ]);
  assert.equal(widgets.text.selectionStart, 5);
  assert.equal(ui.focused, widgets.text, 'DOM focus focuses the widget');
  await tick();
  assert.equal(host.elementOf(widgets.list).querySelectorAll('[role=option]')[1].getAttribute('aria-selected'), 'true');
});

test('keyed reconcile moves only the out-of-order elements', async () => {
  const { host, widgets } = mount((ui) => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => new Label({ id, text: id }));
    const panel = new Panel({ children: items });
    ui.add(panel);
    return { items, panel };
  });
  const box = host.elementOf(widgets.panel),
    before = new Map(widgets.items.map((w) => [w, host.elementOf(w)]));
  let moves = 0;
  const insert = box.insertBefore.bind(box);
  box.insertBefore = (node, ref) => {
    moves++;
    return insert(node, ref);
  };
  // Move 'e' to the front: the four others are already in order and stay.
  widgets.panel.insert(widgets.items[4], 0);
  await tick();
  assert.equal(moves, 1);
  assert.deepEqual(
    [...box.children].map((c) => c.textContent),
    ['e', 'a', 'b', 'c', 'd'],
  );
  for (const [w, el] of before) assert.equal(host.elementOf(w), el);
  assert.deepEqual([...stayingInOrder([4, 0, 1, 2, 3])].sort(), [1, 2, 3, 4]);
  assert.deepEqual([...stayingInOrder([-1, 0, -1, 1])].sort(), [1, 3]);
  assert.equal(stayingInOrder([]).size, 0);
});

test('theme becomes CSS variables; one stylesheet per document; dispose removes everything', async () => {
  const env = page(),
    ui = makeUi({ theme: themes.dark });
  ui.add(new Panel({ children: [new Button({ text: 'A', tooltip: 'Does A', description: 'First' })] }));
  const one = mountDom(ui, env.host, { update: false });
  const second = env.doc.createElement('section');
  env.doc.body.append(second);
  const two = mountDom(ui, second, { update: false, idPrefix: 'other-' });
  const sheetCount = () =>
    (env.doc.adoptedStyleSheets?.length ?? 0) + env.doc.querySelectorAll('style[data-margo-ui]').length;
  assert.equal(sheetCount(), 1);
  assert.equal(env.host.style.getPropertyValue('--mg-primary'), themes.dark.colors.primary);
  assert.equal(env.host.style.getPropertyValue('--mg-target'), '44px');
  ui.theme = createTheme({ colors: { primary: '#ff8800' } });
  await tick();
  assert.equal(env.host.style.getPropertyValue('--mg-primary'), '#ff8800');
  const button = env.host.querySelector('button');
  assert.equal(button.dataset.tip, 'Does A');
  const desc = env.doc.getElementById(button.getAttribute('aria-describedby'));
  assert.equal(desc.textContent, 'First. Does A');
  one.dispose();
  assert.equal(env.host.children.length, 0);
  assert.equal(env.host.style.getPropertyValue('--mg-primary'), '');
  assert.equal(env.host.dataset.margoUi, undefined);
  assert.equal(sheetCount(), 1, 'the second host still uses the sheet');
  two[Symbol.dispose]();
  assert.equal(sheetCount(), 0);
  // A disposed host no longer follows the widgets.
  ui.root.children[0].add(new Label({ text: 'late' }));
  await tick();
  assert.equal(env.host.children.length, 0);
});

test('an AbortSignal unmounts; a bad source, container or target size throws', () => {
  const env = page(),
    ui = makeUi();
  const controller = new AbortController();
  mountDom(ui, env.host, { update: false, signal: controller.signal });
  assert.ok(env.host.children.length > 0);
  controller.abort();
  assert.equal(env.host.children.length, 0);
  assert.throws(() => mountDom({}, env.host), TypeError);
  assert.throws(() => mountDom(new Label({ text: 'loose' }), env.host), TypeError);
  assert.throws(() => mountDom(ui, null), TypeError);
  assert.throws(() => mountDom(ui, env.host, { targetSize: 20 }), RangeError);
  const aborted = new AbortController();
  aborted.abort();
  mountDom(ui, env.host, { signal: aborted.signal });
  assert.equal(env.host.children.length, 0);
});

test('a dialog is a modal <dialog>; Escape asks the widget; the screen is inert behind it', async () => {
  const { window, doc, host, ui } = mount((ui) => {
    ui.add(new Panel({ children: [new Button({ id: 'open', text: 'Open' })] }));
  });
  const result = ui.dialog({
    title: 'Quit?',
    message: 'Unsaved work is lost.',
    buttons: [{ label: 'Quit', value: 1 }],
    cancelValue: 0,
  });
  await tick();
  const dialog = doc.querySelector('dialog');
  assert.ok(dialog, 'a <dialog> element');
  assert.equal(dialog.open, true);
  assert.equal(doc.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Quit?');
  assert.equal(doc.getElementById(dialog.getAttribute('aria-describedby')).textContent, 'Unsaved work is lost.');
  const screen = host.elementOf(ui.find('open')).closest('[inert]');
  assert.ok(screen, 'the screen behind is inert');
  dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
  assert.equal(await result, 0);
  await tick();
  assert.equal(doc.querySelector('dialog'), null);
  assert.equal(host.elementOf(ui.find('open')).closest('[inert]'), null);
  assert.ok(Dialog);
});

test('tabs follow the tablist pattern; arrows move the selection and DOM focus', async () => {
  const { window, doc, host, widgets } = mount((ui) => {
    const tabs = new Tabs({
      label: 'Settings',
      options: [
        { value: 'a', label: 'Audio', panel: new Label({ text: 'Audio panel' }) },
        { value: 'v', label: 'Video', panel: new Label({ text: 'Video panel' }) },
      ],
      value: 'a',
    });
    ui.add(tabs);
    return { tabs };
  });
  const root = host.elementOf(widgets.tabs);
  const list = root.querySelector('[role=tablist]'),
    tabs = [...list.querySelectorAll('[role=tab]')],
    panels = [...root.querySelectorAll('[role=tabpanel]')];
  assert.equal(tabs.length, 2);
  assert.deepEqual(
    tabs.map((t) => [t.getAttribute('aria-selected'), t.getAttribute('tabindex')]),
    [
      ['true', '0'],
      ['false', '-1'],
    ],
  );
  assert.equal(tabs[0].getAttribute('aria-controls'), panels[0].id);
  assert.equal(panels[0].getAttribute('aria-labelledby'), tabs[0].id);
  assert.equal(panels[1].hidden, true);
  tabs[0].focus();
  tabs[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  await tick();
  assert.equal(widgets.tabs.value, 'v');
  assert.equal(doc.activeElement, tabs[1]);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(panels[1].hidden, false);
  assert.equal(panels[0].hidden, true);
});

test('a virtual list shows its built rows with their place in the whole list', () => {
  const { host, widgets } = mount((ui) => {
    const list = new VirtualList({ count: 1000, height: 200, label: 'Files' });
    ui.add(new Panel({ children: [list] }));
    return { list };
  });
  const rows = [...host.elementOf(widgets.list).querySelectorAll('[role=option]')];
  assert.ok(rows.length > 0 && rows.length < 50);
  assert.equal(rows[0].getAttribute('aria-setsize'), '1000');
  assert.equal(rows[0].getAttribute('aria-posinset'), '1');
});

test('announcements go to the live regions; mounting one widget shows only its subtree', async () => {
  const { doc, host, ui } = mount((ui) => {
    ui.add(new Panel({ children: [new Label({ text: 'Screen' })] }));
  });
  ui.announce('Saved');
  assert.equal(doc.querySelector('[aria-live=polite]').textContent, 'Saved');
  host.dispose();
  const env = page(),
    form = new Panel({ id: 'form', children: [new Button({ text: 'Only me' })] });
  ui.add(form);
  const sub = mountDom(form, env.host, { update: false });
  assert.deepEqual(
    [...env.host.querySelectorAll('button')].map((b) => b.textContent),
    ['Only me'],
  );
  assert.equal(env.host.textContent.includes('Screen'), false);
  sub.dispose();
});
