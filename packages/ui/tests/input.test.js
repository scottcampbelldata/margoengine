import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Input } from '@margoengine/input';
import { Button, Inventory, List, Menu, Panel, Slider, UI_ACTIONS, Ui, attachInput, uiActions } from '../dist/index.js';
import { makeUi, measurer } from './helpers.js';

/** Step the UI in 50 ms frames for `seconds` (one update counts at most 0.1 s). */
const run = (ui, seconds) => {
  for (let t = 0; t < seconds - 1e-9; t += 0.05) ui.update(0.05);
};
const centre = (w) => [w.rect.x + w.rect.width / 2, w.rect.y + w.rect.height / 2];

function scene() {
  const ui = makeUi(),
    clicks = [],
    a = new Button({ text: 'A', anchor: 'top-left', margin: 20, width: 100, tooltip: 'Alpha button' }),
    b = new Button({ text: 'B', anchor: 'top-left', margin: [100, 0, 0, 20], width: 100 });
  a.on('click', () => clicks.push('A'));
  b.on('click', () => clicks.push('B'));
  ui.add(a, b);
  ui.layout();
  return { ui, a, b, clicks };
}

test('a press and release on a button clicks it and leaves the focus ring hidden', () => {
  const { ui, a, clicks } = scene();
  const [x, y] = centre(a);
  assert.equal(ui.pointerMove(x, y), true);
  assert.equal(a.hovered, true);
  assert.equal(ui.pointerDown(x, y), true);
  assert.equal(a.pressed, true);
  assert.equal(ui.focused, a);
  assert.equal(a.focusVisible, false, 'a mouse click does not show the ring');
  assert.equal(ui.pointerUp(x, y), true);
  assert.deepEqual(clicks, ['A']);
  assert.equal(a.pressed, false);
});

test('releasing off the button cancels the click; pressing off the UI is left to the game', () => {
  const { ui, a, b, clicks } = scene();
  const [x, y] = centre(a);
  ui.pointerDown(x, y);
  const [bx, by] = centre(b);
  ui.pointerUp(bx, by);
  assert.deepEqual(clicks, []);
  assert.equal(ui.pointerDown(700, 500), false, 'empty space is not the UI');
  assert.equal(ui.wantsPointer(700, 500), false);
  assert.equal(ui.wantsPointer(x, y), true);
  assert.equal(ui.pointerUp(700, 500), false);
});

test('hover events fire, touch pointers never hover, and a second pointer is ignored while one is down', () => {
  const { ui, a, b, clicks } = scene();
  const seen = [];
  a.on('hover', (e) => seen.push(e.value));
  const [x, y] = centre(a);
  ui.pointerMove(x, y);
  ui.pointerMove(700, 500);
  assert.deepEqual(seen, [true, false]);
  ui.pointerDown(x, y, { id: 7, type: 'touch' });
  assert.equal(a.hovered, false);
  assert.equal(ui.inputMode, 'touch');
  const [bx, by] = centre(b);
  ui.pointerDown(bx, by, { id: 8, type: 'touch' });
  ui.pointerUp(bx, by, { id: 8, type: 'touch' });
  ui.pointerUp(x, y, { id: 7, type: 'touch' });
  assert.deepEqual(clicks, ['A']);
});

test('only the primary button clicks, and a disabled button ignores the pointer', () => {
  const { ui, a, clicks } = scene();
  const [x, y] = centre(a);
  ui.pointerDown(x, y, { button: 2 });
  ui.pointerUp(x, y, { button: 2 });
  assert.deepEqual(clicks, []);
  a.enabled = false;
  ui.pointerDown(x, y);
  ui.pointerUp(x, y);
  assert.deepEqual(clicks, []);
});

test('dragging a slider with the pointer sets its value and captures the drag', () => {
  const ui = makeUi(),
    slider = new Slider({ min: 0, max: 100, width: 300, anchor: 'top-left', showValue: false });
  ui.add(slider);
  ui.layout();
  const r = slider.rect;
  ui.pointerDown(r.x + 14, r.y + 10);
  ui.pointerMove(r.x + 14 + 272 / 2, 400);
  assert.ok(Math.abs(slider.value - 50) < 1e-6);
  ui.pointerMove(r.x + 5000, 0);
  assert.equal(slider.value, 100);
  ui.pointerUp(r.x + 5000, 0);
  ui.pointerMove(r.x + 14, 0);
  assert.equal(slider.value, 100);
});

test('the pointer scale divides by the resolution scale', () => {
  const ui = makeUi({ width: 800, height: 600, scale: 2 }),
    b = new Button({ text: 'Hi', anchor: 'top-left', margin: 10, width: 100 }),
    clicks = [];
  b.on('click', () => clicks.push(1));
  ui.add(b);
  ui.layout();
  // The button is at 10..110 UI units, which is 20..220 CSS pixels.
  assert.equal(ui.wantsPointer(30, 30), true);
  assert.equal(ui.wantsPointer(10, 10), false);
  ui.pointerDown(30, 30);
  ui.pointerUp(30, 30);
  assert.deepEqual(clicks, [1]);
});

test('the wheel scrolls the list under the pointer and reports whether it did', () => {
  const ui = makeUi(),
    list = new List({
      items: Array.from({ length: 30 }, (_, i) => `Row ${i}`),
      height: 150,
      width: 200,
      anchor: 'top-left',
    });
  ui.add(list);
  ui.layout();
  const [x, y] = centre(list);
  assert.equal(ui.wheel(x, y, 80), true);
  assert.equal(list.scrollY, 80);
  assert.equal(ui.wheel(700, 500, 80), false);
  ui.wheel(x, y, -1000);
  assert.equal(list.scrollY, 0);
});

test('an inventory drag with the pointer swaps items; pointerCancel drops it where it was', () => {
  const ui = makeUi(),
    bag = new Inventory({
      columns: 2,
      slots: 4,
      anchor: 'top-left',
      items: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    });
  ui.add(bag);
  ui.layout();
  const [x0, y0] = centre(bag.slot(0)),
    [x3, y3] = centre(bag.slot(3));
  ui.pointerDown(x0, y0);
  ui.pointerMove(x3, y3);
  ui.pointerUp(x3, y3);
  assert.equal(bag.get(3).id, 'a');
  assert.equal(bag.get(0), null);
  const [x1, y1] = centre(bag.slot(1));
  ui.pointerDown(x1, y1);
  ui.pointerMove(x1 + 20, y1 + 20);
  ui.pointerCancel();
  assert.equal(bag.get(1).id, 'b');
});

test('tooltips show after the hover delay, sit below the widget, and hide when the pointer leaves', () => {
  const { ui, a } = scene();
  const tip = ui.tooltipWidget;
  const [x, y] = centre(a);
  ui.pointerMove(x, y);
  run(ui, 0.3);
  assert.equal(tip.visible, false);
  run(ui, 0.3);
  assert.equal(tip.visible, true);
  assert.equal(tip.text, 'Alpha button');
  ui.layout();
  assert.ok(tip.rect.y >= a.rect.y + a.rect.height, 'below the button');
  assert.ok(tip.rect.x >= 0 && tip.rect.x + tip.rect.width <= ui.width, 'inside the screen');
  ui.pointerMove(700, 500);
  ui.update(0.016);
  assert.equal(tip.visible, false);
});

test('a tooltip near the bottom edge flips above the widget', () => {
  const ui = makeUi(),
    low = new Button({ text: 'Low', anchor: 'bottom-right', margin: 8, tooltip: 'Tip' });
  ui.add(low);
  ui.layout();
  const [x, y] = centre(low);
  ui.pointerMove(x, y);
  run(ui, 0.6);
  ui.layout();
  assert.equal(ui.tooltipWidget.visible, true);
  assert.ok(ui.tooltipWidget.rect.y + ui.tooltipWidget.rect.height <= low.rect.y, 'above');
  assert.ok(ui.tooltipWidget.rect.x + ui.tooltipWidget.rect.width <= ui.width);
});

test('keyboard focus shows the tooltip, and Escape hides it before anything else', () => {
  const { ui, a } = scene();
  ui.navigate('down');
  run(ui, 0.2);
  assert.equal(ui.focused, a);
  assert.equal(ui.tooltipWidget.visible, true);
  assert.equal(ui.cancel(), true);
  assert.equal(ui.tooltipWidget.visible, false);
  run(ui, 1);
  assert.equal(ui.tooltipWidget.visible, false, 'stays dismissed while focus stays put');
  assert.equal(ui.cancel(), false);
});

test('clicking the dimmed area closes a dismissible dialog and not an undismissible one', async () => {
  const ui = makeUi(),
    first = ui.dialog({ message: 'Close me', cancelValue: 'scrim' });
  ui.layout();
  assert.equal(ui.pointerDown(5, 5), true, 'the scrim takes the press');
  assert.equal(await first, 'scrim');
  const second = ui.dialog({ message: 'Stay', dismissible: false });
  ui.pointerDown(5, 5);
  ui.pointerUp(5, 5);
  assert.equal(ui.modalLayer.children.length, 1);
  ui.modalLayer.children[0].close('done');
  await second;
});

test('the screen behind a dialog is not reachable by the pointer', () => {
  const { ui, a, clicks } = scene();
  ui.dialog({ message: 'Modal' });
  ui.layout();
  const [x, y] = centre(a);
  ui.pointerDown(x, y);
  ui.pointerUp(x, y);
  assert.deepEqual(clicks, []);
});

test('uiActions makes bindings an Input accepts, and bindInput drives focus from a gamepad', () => {
  const pad = { buttons: Array.from({ length: 17 }, () => ({ value: 0 })), axes: [0, 0, 0, 0] },
    input = new Input(uiActions(), { target: new EventTarget(), gamepads: () => [pad] }),
    { ui, a, b, clicks } = scene();
  ui.bindInput(input);
  const press = (index, value = 1) => {
    pad.buttons[index].value = value;
    input.update();
    ui.update(0.016);
  };
  press(13);
  assert.equal(ui.focused, a);
  assert.equal(ui.inputMode, 'gamepad');
  assert.equal(a.focusVisible, true);
  press(13, 0);
  press(13);
  assert.equal(ui.focused, b);
  press(13, 0);
  press(0);
  assert.deepEqual(clicks, ['B']);
  press(0, 0);
  pad.axes[1] = -1;
  input.update();
  ui.update(0.016);
  assert.equal(ui.focused, a, 'the stick moves focus too');
  input.dispose();
});

test('a held direction repeats after a delay at a steady rate', () => {
  const pad = { buttons: Array.from({ length: 17 }, () => ({ value: 0 })), axes: [0, 0, 0, 0] },
    input = new Input(uiActions(), { target: new EventTarget(), gamepads: () => [pad] }),
    ui = makeUi(),
    m = new Menu({ items: Array.from({ length: 8 }, (_, i) => ({ label: `I${i}` })), anchor: 'top-left' });
  ui.add(m);
  ui.layout();
  ui.wrapFocus = false;
  ui.bindInput(input);
  pad.buttons[13].value = 1;
  input.update();
  ui.update(0.016);
  const first = ui.focused;
  for (let t = 0; t < 0.35; t += 0.05) {
    input.update();
    ui.update(0.05);
  }
  assert.equal(ui.focused, first, 'no repeat before the delay');
  for (let t = 0; t < 0.55; t += 0.05) {
    input.update();
    ui.update(0.05);
  }
  const index = m.children.indexOf(ui.focused);
  assert.ok(index >= 4, `repeating moved it on (index ${index})`);
  input.dispose();
});

test('bindInput names the missing action; keyboard bindings are opt in', () => {
  const ui = makeUi();
  assert.throws(
    () =>
      ui.bindInput({
        state: () => {
          throw new TypeError('unknown');
        },
      }),
    (e) => e instanceof TypeError && /ui\.up/.test(e.message) && /errors#ui/.test(e.message),
  );
  assert.throws(() => ui.bindInput(null), TypeError);
  const plain = uiActions(),
    keys = uiActions({ keyboard: true, gamepad: false });
  assert.ok(!plain[UI_ACTIONS.up].some((b) => b.type === 'key'));
  assert.deepEqual(
    keys[UI_ACTIONS.accept].map((b) => b.code),
    ['Enter', 'Space'],
  );
  assert.ok(!(UI_ACTIONS.previous in keys), 'actions without bindings are left out');
  assert.equal(uiActions({ pad: 2 })[UI_ACTIONS.down][0].gamepad, 2);
});

// --- DOM -----------------------------------------------------------------------------------------------------------

function dom() {
  const window = new JSDOM('<!doctype html><canvas id="c" width="800" height="600"></canvas>').window,
    canvas = window.document.getElementById('c');
  canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650 });
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  return { window, canvas };
}
const pointerEvent = (window, type, x, y, init = {}) => {
  const e = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    ...init,
  });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse' }, init.extra);
  return e;
};

test('attachInput turns canvas events into clicks, stops events the UI used and lets the rest through', () => {
  const { window, canvas } = dom(),
    { ui, a, clicks } = scene(),
    reached = [];
  canvas.addEventListener('pointerdown', () => reached.push('down'));
  const detach = attachInput(ui, canvas);
  const [x, y] = centre(a);
  const down = pointerEvent(window, 'pointerdown', 100 + x, 50 + y);
  canvas.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  canvas.dispatchEvent(pointerEvent(window, 'pointerup', 100 + x, 50 + y));
  assert.deepEqual(clicks, ['A']);
  assert.deepEqual(reached, [], 'the game did not see the click that hit a button');
  const empty = pointerEvent(window, 'pointerdown', 100 + 700, 50 + 500);
  canvas.dispatchEvent(empty);
  assert.equal(empty.defaultPrevented, false);
  assert.deepEqual(reached, ['down'], 'a press on empty space reaches the game');
  detach();
  canvas.dispatchEvent(pointerEvent(window, 'pointerdown', 100 + x, 50 + y));
  assert.equal(ui.focused, null, 'nothing after detach');
});

test('attachInput keyboard: arrows move focus once the UI has it, Tab walks and leaves, Escape closes a dialog', async () => {
  const { window, canvas } = dom(),
    { ui, a, b } = scene();
  attachInput(ui, canvas);
  assert.equal(canvas.getAttribute('tabindex'), '0');
  const key = (k, init = {}) => {
    const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    canvas.dispatchEvent(e);
    return e;
  };
  assert.equal(key('ArrowDown').defaultPrevented, false, 'the game keeps arrows while the UI has no focus');
  assert.equal(key('Tab').defaultPrevented, true);
  assert.equal(ui.focused, a);
  assert.equal(key('ArrowDown').defaultPrevented, true);
  assert.equal(ui.focused, b);
  assert.equal(key('Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(ui.focused, a);
  key('Tab');
  assert.equal(key('Tab').defaultPrevented, false, 'Tab past the last widget goes to the page');
  assert.equal(ui.focused, null);
  const answer = ui.dialog({ message: 'q' });
  assert.equal(key('Escape').defaultPrevented, true);
  assert.equal(await answer, undefined);
  assert.equal(key('Escape').defaultPrevented, false, 'nothing to close: the game gets Escape');
  assert.equal(key('ArrowDown', { ctrlKey: true }).defaultPrevented, false, 'modified keys are not ours');
});

test('attachInput can be limited, detached by an AbortSignal and disposed with using', () => {
  const { window, canvas } = dom(),
    { ui, a } = scene(),
    controller = new AbortController();
  attachInput(ui, canvas, { signal: controller.signal, keyboard: false });
  assert.equal(canvas.hasAttribute('tabindex'), false);
  const [x, y] = centre(a);
  canvas.dispatchEvent(pointerEvent(window, 'pointerdown', 100 + x, 50 + y));
  assert.equal(ui.focused, a);
  ui.pointerCancel();
  ui.focus(null);
  controller.abort();
  canvas.dispatchEvent(pointerEvent(window, 'pointerdown', 100 + x, 50 + y));
  assert.equal(ui.focused, null);
  {
    using detach = attachInput(ui, canvas);
    assert.equal(typeof detach, 'function');
  }
  assert.equal(canvas.hasAttribute('tabindex'), false, 'the tabindex it added is removed');
  const already = AbortSignal.abort();
  attachInput(ui, canvas, { signal: already });
  canvas.dispatchEvent(pointerEvent(window, 'pointerdown', 100 + x, 50 + y));
  assert.equal(ui.focused, null);
});

test('hit testing through Ui.hitTest uses CSS pixels', () => {
  const { ui, a } = scene();
  const [x, y] = centre(a);
  assert.equal(ui.hitTest(x, y), a);
  assert.equal(ui.hitTest(790, 590), null);
  const ui2 = new Ui({ measurer, width: 400, height: 300, reducedMotion: true, safeArea: [0, 0, 0, 0] });
  ui2.add(new Panel({ background: 'surface', anchor: 'top-left', width: 50, height: 50 }));
  assert.ok(ui2.hitTest(10, 10));
});
