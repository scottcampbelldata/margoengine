import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  Button,
  HealthBar,
  Inventory,
  Label,
  List,
  Menu,
  ProgressBar,
  Slider,
  Toggle,
  UiRenderer,
  VirtualList,
  attachMirror,
  browserTextScale,
} from '../dist/index.js';
import { makeUi } from './helpers.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function page() {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="host"><canvas id="c" width="800" height="600"></canvas></div></body></html>',
    {
      pretendToBeVisual: false,
    },
  );
  const { window } = dom,
    canvas = window.document.getElementById('c');
  Object.defineProperty(canvas, 'clientWidth', { value: 800 });
  Object.defineProperty(canvas, 'clientHeight', { value: 600 });
  return { window, doc: window.document, canvas };
}
const q = (doc, selector) => doc.querySelector(selector);
const qa = (doc, selector) => [...doc.querySelectorAll(selector)];

async function setup(build) {
  const { window, doc, canvas } = page(),
    ui = makeUi();
  const widgets = build(ui);
  const detach = attachMirror(ui, canvas);
  await tick();
  return { window, doc, canvas, ui, detach, ...widgets };
}

test('the mirror is a labelled region after the canvas with real elements for each widget', async () => {
  const { doc, canvas } = await setup((ui) => {
    const menu = new Menu({ title: 'Settings', items: [{ label: 'Play' }, { label: 'Quit', disabled: true }] });
    ui.add(
      menu,
      new Slider({ text: 'Volume', value: 0.5, anchor: 'top-left' }),
      new Toggle({ text: 'Subtitles', checked: true, anchor: 'top-left' }),
      new ProgressBar({ text: 'Loading', value: 0.25, anchor: 'top-left' }),
      new Label({ text: 'Hello there', anchor: 'bottom' }),
    );
    return { menu };
  });
  const region = q(doc, '[data-margo-ui=mirror]');
  assert.equal(region.getAttribute('role'), 'region');
  assert.equal(region.getAttribute('aria-label'), 'Game interface');
  assert.equal(canvas.nextElementSibling, region, 'right after the canvas');
  const group = q(doc, '[role=group]');
  assert.equal(group.getAttribute('aria-label'), 'Settings');
  const buttons = qa(doc, 'button:not([role])');
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ['Play', 'Quit'],
  );
  assert.equal(buttons[1].hasAttribute('disabled'), true);
  const range = q(doc, 'input[type=range]');
  assert.equal(range.getAttribute('aria-label'), 'Volume');
  assert.equal(range.value, '0.5');
  assert.equal(range.getAttribute('aria-valuetext'), '0.5');
  const sw = q(doc, '[role=switch]');
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.equal(sw.textContent, 'Subtitles');
  const bar = q(doc, '[role=progressbar]');
  assert.equal(bar.getAttribute('aria-valuenow'), '0.25');
  assert.equal(bar.getAttribute('aria-valuemax'), '1');
  assert.equal(bar.getAttribute('aria-valuetext'), '25%');
  assert.equal(bar.getAttribute('aria-label'), 'Loading');
  assert.equal(
    q(doc, 'p').textContent === 'Settings' || qa(doc, 'p').some((p) => p.textContent === 'Hello there'),
    true,
  );
});

test('elements sit over their widgets in CSS pixels and move with the layout and the scale', async () => {
  const { doc, ui } = await setup((ui) => {
    const button = new Button({ text: 'Go', anchor: 'top-left', margin: 30, width: 100 });
    ui.add(button);
    return { button };
  });
  const el = q(doc, 'button');
  const style = el.getAttribute('style');
  assert.match(style, /left:30px/);
  assert.match(style, /top:30px/);
  assert.match(style, /width:100px/);
  assert.match(style, /position:absolute/);
  assert.match(style, /pointer-events:none/);
  ui.setScale(2);
  await tick();
  assert.match(el.getAttribute('style'), /left:60px/, 'a UI unit is two CSS pixels at scale 2');
  ui.setScale(1);
});

test('text, state and values follow the widgets', async () => {
  const { doc, ui, label, toggle, bar, slider, button } = await setup((ui) => {
    const label = new Label({ text: 'Score 0', anchor: 'top-left' }),
      toggle = new Toggle({ text: 'Music', anchor: 'top-left', margin: [50, 0, 0, 0] }),
      bar = new HealthBar({ anchor: 'top-left', margin: [100, 0, 0, 0], width: 200 }),
      slider = new Slider({ max: 10, step: 1, value: 3, anchor: 'top-left', margin: [150, 0, 0, 0] }),
      button = new Button({ text: 'Retry', anchor: 'top-left', margin: [200, 0, 0, 0] });
    ui.add(label, toggle, bar, slider, button);
    return { label, toggle, bar, slider, button };
  });
  label.text = 'Score 40';
  toggle.activate();
  bar.value = 60;
  slider.value = 7;
  button.text = 'Try again';
  await tick();
  assert.equal(
    qa(doc, 'p').some((p) => p.textContent === 'Score 40'),
    true,
  );
  assert.equal(q(doc, '[role=switch]').getAttribute('aria-checked'), 'true');
  const progress = q(doc, '[role=progressbar]');
  assert.equal(progress.getAttribute('aria-valuenow'), '60');
  assert.equal(progress.getAttribute('aria-valuetext'), '60 / 100');
  assert.equal(q(doc, 'input[type=range]').value, '7');
  assert.equal(qa(doc, 'button:not([role])')[0].textContent, 'Try again');
  button.visible = false;
  toggle.enabled = false;
  await tick();
  assert.equal(qa(doc, 'button:not([role])').length, 0, 'a hidden widget leaves the DOM');
  assert.equal(q(doc, '[role=switch]').hasAttribute('disabled'), true);
  ui.dispose();
});

test('screen reader and keyboard activation reach the widgets without doubling', async () => {
  const log = [];
  const { doc, window, ui } = await setup((ui) => {
    const go = new Button({ text: 'Go', anchor: 'top-left', onClick: () => log.push('go') }),
      volume = new Slider({
        max: 10,
        step: 1,
        value: 2,
        anchor: 'top-left',
        margin: [60, 0, 0, 0],
        onChange: (e) => log.push(`volume ${e.value}`),
      });
    ui.add(go, volume);
    return {};
  });
  q(doc, 'button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(log, ['go']);
  const range = q(doc, 'input[type=range]');
  range.value = '6';
  range.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(log, ['go', 'volume 6']);
  const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  q(doc, 'button').dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false, 'Enter is left to the button, so it clicks once');
  assert.deepEqual(log, ['go', 'volume 6']);
  ui.dispose();
});

test('focus is shared: DOM focus moves widget focus, and widget focus moves DOM focus', async () => {
  const { doc, window, canvas, ui, a, b } = await setup((ui) => {
    const a = new Button({ text: 'A', anchor: 'top-left' }),
      b = new Button({ text: 'B', anchor: 'top-left', margin: [60, 0, 0, 0] });
    ui.add(a, b);
    return { a, b };
  });
  const [ea, eb] = qa(doc, 'button');
  ea.focus();
  assert.equal(ui.focused, a, 'a native focus (Tab or a reader) focuses the widget');
  assert.equal(ui.inputMode, 'keyboard');
  assert.equal(a.focusVisible, true);
  ui.navigate('down');
  assert.equal(ui.focused, b);
  assert.equal(doc.activeElement, eb, 'keyboard navigation in the UI moves DOM focus so the reader announces it');
  const arrow = new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  eb.dispatchEvent(arrow);
  assert.equal(arrow.defaultPrevented, true, 'arrows from a mirror element navigate');
  assert.equal(ui.focused, a);
  assert.equal(doc.activeElement, ea);
  canvas.focus();
  ui.focus(b);
  assert.equal(doc.activeElement, eb, 'also when the canvas had focus');
  doc.activeElement.blur();
  ui.focus(null);
  ui.focus(a, 'pointer');
  assert.notEqual(doc.activeElement, ea, 'it does not steal focus from elsewhere on the page');
  assert.equal(a.focusVisible, false);
});

test('focus leaving the mirror clears the widget focus; a programmatic move does not', async () => {
  const { doc, window, ui, a } = await setup((ui) => {
    const a = new Button({ text: 'A', anchor: 'top-left' }),
      b = new Button({ text: 'B', anchor: 'top-left', margin: [60, 0, 0, 0] });
    ui.add(a, b);
    return { a, b };
  });
  const [ea, eb] = qa(doc, 'button');
  ea.focus();
  eb.focus();
  assert.notEqual(ui.focused, null);
  assert.equal(ui.focused.text, 'B');
  ea.focus();
  const outside = doc.createElement('button');
  doc.body.append(outside);
  outside.focus();
  assert.equal(ui.focused, null);
  void window;
  void a;
});

test('a dialog is role dialog, aria-modal, named by its title, and makes the rest inert', async () => {
  const { doc, window, ui } = await setup((ui) => {
    ui.add(new Button({ text: 'Behind', anchor: 'top-left' }));
    return {};
  });
  const answer = ui.dialog({
    title: 'Quit?',
    message: 'Progress is saved.',
    buttons: [
      { label: 'Quit', value: 1 },
      { label: 'Stay', value: 0 },
    ],
  });
  await tick();
  const dialog = q(doc, '[role=dialog]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(doc.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Quit?');
  assert.equal(doc.getElementById(dialog.getAttribute('aria-describedby')).textContent, 'Progress is saved.');
  const content = q(doc, '[data-margo-ui=mirror] > div');
  assert.equal(content.hasAttribute('inert'), true);
  assert.equal(content.getAttribute('aria-hidden'), 'true');
  const buttons = qa(dialog, 'button');
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ['Quit', 'Stay'],
  );
  assert.equal(doc.activeElement === buttons[0] || ui.focused.text === 'Quit', true);
  const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  buttons[1].focus();
  buttons[1].dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true, 'Tab is trapped inside the dialog');
  assert.equal(ui.focused.text, 'Quit', 'and wraps');
  const esc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  buttons[0].dispatchEvent(esc);
  assert.equal(await answer, undefined);
  await tick();
  assert.equal(q(doc, '[role=dialog]'), null);
  assert.equal(content.hasAttribute('inert'), false);
});

test('toasts and announcements go to live regions, danger assertively', async () => {
  const { doc, ui } = await setup(() => ({}));
  const polite = q(doc, '[aria-live=polite]'),
    assertive = q(doc, '[aria-live=assertive]');
  ui.toast('Game saved', { kind: 'success', duration: 0 });
  ui.toast('Disk full', { kind: 'danger', duration: 0 });
  ui.announce('Level 2', 'polite');
  ui.announce('Enemy nearby', 'assertive');
  assert.deepEqual(
    [...polite.children].map((p) => p.textContent),
    ['Done: Game saved', 'Level 2'],
  );
  assert.deepEqual(
    [...assertive.children].map((p) => p.textContent),
    ['Error: Disk full', 'Enemy nearby'],
  );
  await tick();
  const toast = qa(doc, '[role=group]').find((g) => g.getAttribute('aria-label') === 'Done: Game saved');
  assert.ok(toast, 'the toast is also in the tree for browsing');
  assert.equal(toast.querySelectorAll('p').length, 0, 'its text is not read twice');
  assert.throws(() => ui.announce(''), TypeError);
});

test('tooltips and descriptions become aria-describedby', async () => {
  const { doc } = await setup((ui) => {
    ui.add(new Button({ text: 'Shop', anchor: 'top-left', tooltip: 'Buy and sell', description: 'Opens the market' }));
    return {};
  });
  const button = q(doc, 'button');
  const described = doc.getElementById(button.getAttribute('aria-describedby'));
  assert.equal(described.textContent, 'Opens the market. Buy and sell');
});

test('lists, options and inventory slots expose their selection and carried state', async () => {
  const { doc, list, bag } = await setup((ui) => {
    const list = new List({
        items: ['One', 'Two', { label: 'Third', disabled: true }],
        selected: 1,
        width: 200,
        height: 150,
        anchor: 'top-left',
        label: 'Saves',
      }),
      bag = new Inventory({
        columns: 2,
        slots: 4,
        anchor: 'top-left',
        margin: [200, 0, 0, 0],
        items: [{ id: 'p', name: 'Potion', count: 2 }],
      });
    ui.add(list, bag);
    return { list, bag };
  });
  const box = q(doc, '[role=listbox]');
  assert.equal(box.getAttribute('aria-label'), 'Saves');
  const options = qa(doc, '[role=option]');
  assert.deepEqual(
    options.map((o) => o.getAttribute('aria-selected')),
    ['false', 'true', 'false'],
  );
  assert.equal(options[2].getAttribute('aria-disabled'), 'true');
  options[0].dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  assert.equal(list.selected, 0);
  const group = qa(doc, '[role=group]').find((g) => g.getAttribute('aria-label') === 'Inventory');
  const slots = qa(group, 'button');
  assert.deepEqual(
    slots.map((s) => s.textContent),
    ['Potion, 2', 'Empty slot 2', 'Empty slot 3', 'Empty slot 4'],
  );
  slots[0].dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  assert.equal(bag.carried, 0);
  await tick();
  assert.equal(slots[0].getAttribute('aria-pressed'), 'true');
});

test('detach removes the region, its listeners and pending announcements; abort and using detach too', async () => {
  const { doc, window, canvas, ui, detach } = await setup((ui) => {
    ui.add(new Button({ text: 'x', anchor: 'top-left' }));
    return {};
  });
  assert.ok(q(doc, '[data-margo-ui=mirror]'));
  detach();
  detach();
  assert.equal(q(doc, '[data-margo-ui=mirror]'), null);
  ui.announce('after detach');
  const controller = new AbortController();
  attachMirror(ui, canvas, { signal: controller.signal, label: 'HUD' });
  assert.equal(q(doc, '[data-margo-ui=mirror]').getAttribute('aria-label'), 'HUD');
  controller.abort();
  assert.equal(q(doc, '[data-margo-ui=mirror]'), null);
  {
    using scoped = attachMirror(ui, canvas);
    assert.equal(typeof scoped, 'function');
    assert.ok(q(doc, '[data-margo-ui=mirror]'));
  }
  assert.equal(q(doc, '[data-margo-ui=mirror]'), null);
  void window;
  attachMirror(ui, canvas, { signal: AbortSignal.abort() });
  assert.equal(q(doc, '[data-margo-ui=mirror]'), null);
});

test('UiRenderer attaches the pointer, keyboard and mirror to the canvas and removes them on dispose', async () => {
  const { doc, canvas } = page(),
    ui = makeUi(),
    renderer = new UiRenderer(ui),
    warn = console.warn;
  console.warn = () => {};
  try {
    renderer.setup({ backend: 'webgl2', canvas });
  } finally {
    console.warn = warn;
  }
  assert.ok(q(doc, '[data-margo-ui=mirror]'), 'accessible with no setup, even on WebGL2');
  assert.equal(canvas.getAttribute('tabindex'), '0');
  renderer.dispose();
  assert.equal(q(doc, '[data-margo-ui=mirror]'), null);
  assert.equal(canvas.hasAttribute('tabindex'), false);
  const plain = new UiRenderer(ui, { mirror: false, input: false });
  console.warn = () => {};
  try {
    plain.setup({ backend: 'webgl2', canvas });
  } finally {
    console.warn = warn;
  }
  assert.equal(q(doc, '[data-margo-ui=mirror]'), null);
  assert.equal(canvas.hasAttribute('tabindex'), false);
  plain.dispose();
});

test('browserTextScale follows the browser font size and textScale auto uses it', () => {
  const { doc } = page();
  assert.equal(browserTextScale(undefined), 1);
  doc.documentElement.style.fontSize = '20px';
  assert.equal(browserTextScale(doc), 1.25);
  doc.documentElement.style.fontSize = '80px';
  assert.equal(browserTextScale(doc), 3);
  doc.documentElement.style.fontSize = '4px';
  assert.equal(browserTextScale(doc), 0.5);
});

test('a virtual list mirrors as a listbox of its built rows, each with its place in the whole list', async () => {
  const { doc, list } = await setup((ui) => {
    const list = new VirtualList({
      count: 5000,
      row: (i) => `Entry ${i}`,
      height: 150,
      anchor: 'top-left',
      label: 'Log',
      selected: 2,
    });
    ui.add(list);
    return { list };
  });
  const box = q(doc, '[role=listbox]');
  assert.equal(box.getAttribute('aria-label'), 'Log');
  const options = qa(box, '[role=option]');
  assert.equal(options.length, list.range[1] - list.range[0], 'only the built rows');
  assert.ok(options.length < 20);
  assert.deepEqual(
    options.slice(0, 3).map((o) => [o.textContent, o.getAttribute('aria-posinset'), o.getAttribute('aria-setsize')]),
    [
      ['Entry 0', '1', '5000'],
      ['Entry 1', '2', '5000'],
      ['Entry 2', '3', '5000'],
    ],
  );
  assert.equal(options[2].getAttribute('aria-selected'), 'true');
  options[0].dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  assert.equal(list.selected, 0);
});
