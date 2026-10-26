import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// React needs a document; set it up before importing it. This file runs in its own process.
const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const { act, createElement: h, StrictMode, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const ui = await import('../dist/react.js');
const { Ui, themes } = await import('../dist/index.js');
const { measurer } = await import('./helpers.js');

const options = { measurer, reducedMotion: true, safeArea: [0, 0, 0, 0] };

async function mount(element) {
  const container = dom.window.document.getElementById('app');
  container.innerHTML = '';
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    rerender: (next) => act(async () => root.render(next)),
    unmount: () => act(async () => root.unmount()),
  };
}

test('widgets render no DOM and become widgets of the Ui in mount order', async () => {
  const instance = new Ui(options);
  const view = await mount(
    h(
      ui.UiRoot,
      { ui: instance },
      h(ui.Label, { text: 'Hello', anchor: 'top-left' }),
      h(
        ui.Panel,
        { id: 'card', background: 'surface', padding: 12, anchor: 'center' },
        h(ui.Button, { text: 'Play' }),
        h(ui.ProgressBar, { value: 0.5, text: 'Load' }),
      ),
    ),
  );
  assert.equal(view.container.innerHTML, '');
  assert.deepEqual(
    instance.root.children.map((w) => w.constructor.name.length > 0 && w.role),
    ['text', 'generic'],
  );
  const card = instance.find('card');
  assert.deepEqual(
    card.children.map((w) => w.role),
    ['button', 'progressbar'],
  );
  await view.unmount();
  assert.equal(instance.root.children.length, 0, 'unmounting removes the widgets');
  assert.doesNotThrow(() => instance.update(0.1), 'a Ui you passed in is left alone');
});

test('props update widgets in place and events call the latest handler', async () => {
  const instance = new Ui(options),
    calls = [];
  const tree = (n) =>
    h(
      ui.UiRoot,
      { ui: instance },
      h(ui.Label, { id: 'label', text: `Count ${n}`, anchor: 'top-left' }),
      h(ui.Button, {
        id: 'button',
        text: 'Add',
        anchor: 'top-left',
        margin: [60, 0, 0, 0],
        onClick: () => calls.push(n),
      }),
      h(ui.ProgressBar, { id: 'bar', value: n / 10, anchor: 'top-left', margin: [120, 0, 0, 0] }),
    );
  const view = await mount(tree(1));
  const label = instance.find('label'),
    bar = instance.find('bar');
  await view.rerender(tree(5));
  assert.equal(instance.find('label'), label, 'the same widget');
  assert.equal(label.text, 'Count 5');
  assert.equal(bar.value, 0.5);
  instance.find('button').activate();
  assert.deepEqual(calls, [5], 'the handler of the latest render');
  await view.unmount();
});

test('a controlled toggle and slider round trip through React state', async () => {
  const instance = new Ui(options);
  function Settings() {
    const [on, setOn] = useState(false),
      [volume, setVolume] = useState(0.2);
    return h(
      ui.UiRoot,
      { ui: instance },
      h(ui.Toggle, {
        id: 'music',
        text: `Music ${on ? 'on' : 'off'}`,
        checked: on,
        onChange: (e) => setOn(e.value),
        anchor: 'top-left',
      }),
      h(ui.Slider, {
        id: 'volume',
        value: volume,
        text: 'Volume',
        onChange: (e) => setVolume(e.value),
        anchor: 'top-left',
        margin: [60, 0, 0, 0],
      }),
      h(ui.Label, { id: 'echo', text: String(volume), anchor: 'top-left', margin: [120, 0, 0, 0] }),
    );
  }
  const view = await mount(h(Settings));
  await act(async () => instance.find('music').activate());
  assert.equal(instance.find('music').checked, true);
  assert.equal(instance.find('music').text, 'Music on');
  await act(async () => instance.find('volume').setValue(0.7));
  assert.equal(instance.find('echo').text, '0.7');
  assert.equal(instance.find('volume').value, 0.7);
  await view.unmount();
});

test('conditional children come and go, and constructor-only props recreate the widget', async () => {
  const instance = new Ui(options);
  const tree = (show, max) =>
    h(
      ui.UiRoot,
      { ui: instance },
      show && h(ui.Label, { id: 'extra', text: 'Extra', anchor: 'top-left' }),
      h(ui.Slider, { id: 'slider', min: 0, max, value: 1, anchor: 'top-left', margin: [60, 0, 0, 0] }),
    );
  const view = await mount(tree(true, 10));
  assert.ok(instance.find('extra'));
  const first = instance.find('slider');
  await view.rerender(tree(false, 10));
  assert.equal(instance.find('extra'), undefined);
  assert.equal(instance.find('slider'), first);
  await view.rerender(tree(false, 100));
  assert.notEqual(instance.find('slider'), first, 'a new range is a new slider');
  assert.equal(instance.find('slider').max, 100);
  assert.equal(instance.root.children.length, 1);
  await view.unmount();
});

test('StrictMode runs effects twice without duplicating widgets or disposing the Ui', async () => {
  let created;
  function Probe() {
    created = ui.useUi();
    return h(ui.Button, { id: 'only', text: 'One' });
  }
  const view = await mount(h(StrictMode, null, h(ui.UiRoot, { options }, h(Probe))));
  assert.equal(created.root.children.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.doesNotThrow(() => created.update(0.1));
  await view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(
    () => created.update(0.1),
    (e) => e.code === 'disposed',
    'a Ui made by UiRoot is disposed on unmount',
  );
});

test('useUi gives event handlers the Ui; outside UiRoot it explains itself', async () => {
  let api;
  function Hud() {
    api = ui.useUi();
    return null;
  }
  const view = await mount(h(ui.UiRoot, { options }, h(Hud)));
  const toast = api.toast('Saved', { kind: 'success', duration: 0 });
  assert.equal(toast.kind, 'success');
  await view.unmount();
  await assert.rejects(
    async () => {
      const errors = [];
      const spy = console.error;
      console.error = (...args) => errors.push(args);
      try {
        await mount(h(Hud));
      } finally {
        console.error = spy;
      }
    },
    (e) => e.code === 'state' && /UiRoot/.test(e.message) && /errors#ui/.test(e.message),
  );
});

test('theme, text scale and scale props restyle the Ui', async () => {
  const instance = new Ui(options);
  const tree = (theme, textScale, scale) =>
    h(ui.UiRoot, { ui: instance, theme, textScale, scale }, h(ui.Label, { text: 'x' }));
  const view = await mount(tree(themes.light, 2, 2));
  assert.equal(instance.theme.name, 'light');
  assert.equal(instance.textScale, 2);
  assert.equal(instance.cssScale, 2);
  await view.rerender(tree(themes.highContrast, 1, 1));
  assert.equal(instance.theme.name, 'high-contrast');
  assert.equal(instance.cssScale, 1);
  await view.unmount();
});

test('an engine prop attaches a UiRenderer and removes it on unmount', async () => {
  const log = [];
  const engine = {
    use(plugin) {
      log.push(['use', plugin.name]);
      return this;
    },
    removePlugin(name) {
      log.push(['remove', name]);
    },
  };
  const instance = new Ui(options);
  const view = await mount(
    h(ui.UiRoot, { ui: instance, engine, renderer: { name: 'game-ui', input: false, mirror: false } }),
  );
  assert.deepEqual(log, [['use', 'game-ui']]);
  await view.unmount();
  assert.deepEqual(log, [
    ['use', 'game-ui'],
    ['remove', 'game-ui'],
  ]);
});
