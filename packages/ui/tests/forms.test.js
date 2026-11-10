import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Panel, attachMirror, parseRgba } from '../dist/index.js';
import { makeUi } from './helpers.js';
import { Select, RadioGroup, Tabs, Checkbox, ColorPicker, attachFormsMirror } from '../dist/forms.js';
const choices = [
  { label: 'Alpha', value: 'a' },
  { label: 'Disabled', value: 'b', disabled: true },
  { label: 'Gamma', value: 'c' },
];
const settle = () => new Promise((r) => setTimeout(r, 0));
test('Select has enabled choice navigation and a cancelable accessible choice dialog', async () => {
  const ui = makeUi(),
    select = new Select({ options: choices, label: 'Quality', id: 'quality', width: 240 });
  let changes = 0;
  select.on('change', () => changes++);
  ui.add(select);
  ui.focus(select, 'gamepad');
  assert.equal(select.value, 'a');
  ui.execute('down', 'gamepad');
  assert.equal(select.value, 'c');
  ui.execute('up');
  assert.equal(select.value, 'a');
  assert.equal(changes, 2);
  select.activate();
  assert.equal(select.expanded, true);
  assert.equal(ui.focused.role, 'option');
  ui.execute('cancel');
  await settle();
  assert.equal(select.expanded, false);
  assert.equal(ui.focused, select);
  assert.equal(select.value, 'a');
  select.activate();
  ui.execute('down');
  ui.execute('accept');
  await settle();
  assert.equal(select.value, 'c');
  assert.equal(select.expanded, false);
  assert.equal(changes, 3);
  ui.dispose();
});
test('RadioGroup is one tab stop and arrows wrap, skip disabled choices and activate', () => {
  const ui = makeUi(),
    group = new RadioGroup({ options: choices });
  ui.add(group);
  assert.equal(ui.focusables().length, 1);
  ui.focus(group.children[0], 'gamepad');
  ui.execute('right', 'gamepad');
  assert.equal(group.value, 'c');
  assert.equal(ui.focused, group.children[2]);
  ui.execute('down', 'gamepad');
  assert.equal(group.value, 'a');
  assert.equal(ui.focusables().length, 1);
  group.selectIndex(1, true);
  assert.equal(group.value, 'a');
  group.enabled = false;
  group.selectIndex(2, true);
  assert.equal(group.value, 'a');
  ui.dispose();
});
test('Tabs switch content panels and maintain one focus stop', () => {
  const ui = makeUi(),
    first = new Panel({ label: 'First', id: 'first' }),
    second = new Panel({ label: 'Second', id: 'second' }),
    tabs = new Tabs({
      id: 'tabs',
      label: 'Views',
      options: [
        { label: 'One', value: 'one', panel: first },
        { label: 'Two', value: 'two', panel: second },
      ],
    });
  ui.add(tabs);
  assert.equal(first.shown, true);
  assert.equal(second.shown, false);
  tabs.selectIndex(1, true);
  assert.equal(first.shown, false);
  assert.equal(second.shown, true);
  assert.equal(ui.focusables().length, 1);
  ui.dispose();
});
test('Checkbox uses the complete existing toggle behavior', () => {
  const box = new Checkbox({ text: 'Enable' });
  assert.equal(box.role, 'checkbox');
  box.activate();
  assert.equal(box.checked, true);
  box.enabled = false;
  box.activate();
  assert.equal(box.checked, true);
});
test('ColorPicker retains hue at zero saturation and keeps HSV, RGB, hex and alpha coherent', () => {
  const picker = new ColorPicker();
  picker.setHSV(2 / 3, 0, 1);
  assert.equal(picker.hue, 2 / 3);
  picker.setHSV(picker.hue, 1, 1);
  assert.equal(picker.value, '#0000ffff');
  picker.value = '#33669980';
  assert.deepEqual(parseRgba(picker.value), parseRgba('#33669980'));
  const ui = makeUi();
  ui.add(picker);
  const red = picker.children.find((w) => w.text === 'Red');
  ui.focus(red, 'gamepad');
  ui.execute('right', 'gamepad');
  assert.ok(parseRgba(picker.value)[0] > 0.2);
  ui.dispose();
});
test('Form mirror exposes roles, selection and panel relationships without duplicates', async () => {
  const dom = new JSDOM('<div><canvas tabindex="0"></canvas></div>'),
    canvas = dom.window.document.querySelector('canvas'),
    ui = makeUi(),
    radio = new RadioGroup({ id: 'radio', label: 'Mode', options: choices }),
    p1 = new Panel({ id: 'p1', label: 'One' }),
    p2 = new Panel({ id: 'p2', label: 'Two' }),
    tabs = new Tabs({
      id: 'tabs',
      label: 'Views',
      options: [
        { label: 'One', value: 'a', panel: p1 },
        { label: 'Two', value: 'b', panel: p2 },
      ],
    }),
    select = new Select({ id: 'select', label: 'Choice', options: choices });
  ui.add(radio, tabs, select);
  const mirror = attachMirror(ui, canvas),
    off = attachFormsMirror(ui, canvas);
  await settle();
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('[role=radiogroup]').length, 1);
  assert.equal(doc.querySelectorAll('[role=radio][aria-checked=true]').length, 1);
  assert.equal(
    doc.querySelector('[role=tab][aria-selected=true]').getAttribute('aria-controls'),
    'margo-ui-tabs-panel-0',
  );
  assert.equal(doc.querySelector('[role=tabpanel]').getAttribute('aria-labelledby'), 'margo-ui-tabs-choice-0');
  assert.equal(doc.querySelector('[role=combobox]').getAttribute('aria-haspopup'), 'dialog');
  radio.value = 'c';
  tabs.value = 'b';
  await settle();
  assert.equal(doc.getElementById('margo-ui-radio-choice-2').getAttribute('aria-checked'), 'true');
  assert.equal(doc.getElementById('margo-ui-tabs-choice-1').getAttribute('aria-selected'), 'true');
  assert.equal(doc.querySelectorAll('[role=tabpanel]').length, 1);
  off();
  mirror();
  ui.dispose();
  dom.window.close();
});
test('invalid choices and initial values reject clearly', () => {
  assert.throws(() => new RadioGroup({ options: [choices[0], choices[0]] }), /unique/);
  assert.throws(() => new Select({ options: choices, value: 'missing' }), /option/);
});

test('disposing a select closes its owned popup', () => {
  const ui = makeUi(),
    select = new Select({ options: choices });
  ui.add(select);
  select.activate();
  assert.equal(ui.modalLayer.children.length, 1);
  select.dispose();
  assert.equal(ui.modalLayer.children.length, 0);
  ui.dispose();
});

test('a closed popup settling cannot release a reopened select popup', async () => {
  const ui = makeUi(),
    select = new Select({ options: choices });
  ui.add(select);
  try {
    select.activate();
    ui.execute('cancel');
    select.activate();
    const popupId = select.popupId;
    assert.equal(select.expanded, true);
    await Promise.resolve();
    assert.equal(select.expanded, true);
    assert.equal(select.popupId, popupId);
    select.activate();
    assert.equal(ui.modalLayer.children.length, 1);
    select.dispose();
    assert.equal(ui.modalLayer.children.length, 0);
  } finally {
    ui.dispose();
  }
});

test('hex editing keeps a valid RGB prefix while the user completes alpha', () => {
  const picker = new ColorPicker();
  picker.hexInput.edit('#336699', 7, 7, 'none');
  assert.equal(picker.hexInput.value, '#336699');
  picker.hexInput.insertText('80');
  assert.equal(picker.hexInput.value, '#33669980');
  assert.equal(picker.value, '#33669980');
});

test('form annotations and popup focus follow the ordinary mirror frame reconciliation', async () => {
  const oldRaf = globalThis.requestAnimationFrame,
    oldCancel = globalThis.cancelAnimationFrame;
  let next = 0;
  const frames = new Map();
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++next, callback);
    return next;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const frame = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  };
  const dom = new JSDOM('<div><canvas tabindex="0"></canvas></div>'),
    canvas = dom.window.document.querySelector('canvas'),
    ui = makeUi();
  const select = new Select({ id: 'select', options: choices }),
    tabs = new Tabs({
      id: 'tabs',
      options: [
        { label: 'One', value: 'one', panel: new Panel() },
        { label: 'Two', value: 'two', panel: new Panel() },
      ],
    });
  ui.add(select, tabs);
  const mirror = attachMirror(ui, canvas),
    forms = attachFormsMirror(ui, canvas);
  try {
    frame();
    canvas.focus();
    ui.focus(select, 'keyboard');
    frame();
    select.activate();
    frame();
    assert.equal(dom.window.document.activeElement.id, `margo-ui-${ui.focused.id}`);
    ui.execute('down');
    ui.execute('accept');
    await Promise.resolve();
    frame();
    assert.equal(dom.window.document.activeElement.id, 'margo-ui-select');
    tabs.value = 'two';
    frame();
    assert.equal(dom.window.document.getElementById('margo-ui-tabs-panel-1').getAttribute('role'), 'tabpanel');
  } finally {
    forms();
    mirror();
    ui.dispose();
    dom.window.close();
    if (oldRaf) globalThis.requestAnimationFrame = oldRaf;
    else delete globalThis.requestAnimationFrame;
    if (oldCancel) globalThis.cancelAnimationFrame = oldCancel;
    else delete globalThis.cancelAnimationFrame;
  }
});
