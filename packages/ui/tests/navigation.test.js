import test from 'node:test';
import assert from 'node:assert/strict';
import { Button, Inventory, Label, List, Menu, Slider, Toggle, moveFocus } from '../dist/index.js';
import { makeUi } from './helpers.js';

const cell = (x, y, w = 50, h = 50) => ({ x, y, width: w, height: h });

test('moveFocus picks the nearest neighbour in a grid and prefers the same row or column', () => {
  const grid = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) grid.push(cell(c * 60, r * 60));
  const at = (r, c) => r * 4 + c;
  const others = (i) => grid.filter((_, j) => j !== i);
  const pick = (from, direction, wrap) => {
    const list = grid.filter((_, j) => j !== from),
      index = moveFocus(grid[from], list, direction, wrap);
    return index < 0 ? -1 : grid.indexOf(list[index]);
  };
  assert.equal(pick(at(1, 1), 'right'), at(1, 2));
  assert.equal(pick(at(1, 1), 'left'), at(1, 0));
  assert.equal(pick(at(1, 1), 'down'), at(2, 1));
  assert.equal(pick(at(1, 1), 'up'), at(0, 1));
  assert.equal(pick(at(0, 0), 'up'), -1);
  assert.equal(pick(at(0, 3), 'right'), -1);
  assert.equal(pick(at(0, 2), 'up', true), at(2, 2), 'wraps to the far end of the same column');
  assert.equal(pick(at(1, 3), 'right', true), at(1, 0), 'wraps along the row');
  assert.equal(others(0).length, 11);
});

test('moveFocus handles uneven layouts: a tall item beside two short ones', () => {
  const tall = cell(0, 0, 50, 110),
    top = cell(60, 0, 50, 50),
    bottom = cell(60, 60, 50, 50);
  assert.equal(moveFocus(tall, [top, bottom], 'right'), 0, 'the one level with its centre or its top, in order');
  assert.equal(moveFocus(top, [tall, bottom], 'left'), 0);
  assert.equal(moveFocus(bottom, [tall, top], 'left'), 0);
  assert.equal(moveFocus(top, [bottom], 'down'), 0);
  assert.equal(moveFocus(top, [], 'down'), -1);
  assert.equal(
    moveFocus(top, [cell(500, 500)], 'down'),
    0,
    'something far diagonal still counts when nothing lines up',
  );
});

function menu(count = 3, extra = {}) {
  const ui = makeUi();
  const clicks = [];
  const m = new Menu({
    title: 'Paused',
    items: Array.from({ length: count }, (_, i) => ({ label: `Item ${i}`, onSelect: () => clicks.push(i) })),
    ...extra,
  });
  ui.add(m);
  ui.layout();
  return { ui, m, clicks, buttons: m.children.slice(1) };
}

test('arrow keys move focus down and up a menu, show the ring, and wrap', () => {
  const { ui, buttons } = menu();
  assert.equal(ui.focused, null);
  assert.equal(ui.navigate('down'), true);
  assert.equal(ui.focused, buttons[0], 'the first press focuses the first button');
  assert.equal(buttons[0].focusVisible, true);
  assert.equal(ui.inputMode, 'keyboard');
  ui.navigate('down');
  ui.navigate('down');
  assert.equal(ui.focused, buttons[2]);
  ui.navigate('down');
  assert.equal(ui.focused, buttons[0], 'wraps to the first');
  ui.navigate('up');
  assert.equal(ui.focused, buttons[2], 'and back to the last');
  ui.wrapFocus = false;
  assert.equal(ui.navigate('down'), false);
  assert.equal(ui.focused, buttons[2]);
  assert.equal(ui.navigate('up'), true);
  assert.equal(ui.focused, buttons[1]);
});

test('focus events fire, accept clicks the focused button and shows a press flash', () => {
  const { ui, buttons, clicks } = menu();
  const seen = [];
  buttons[0].on('focus', () => seen.push('focus'));
  buttons[0].on('blur', () => seen.push('blur'));
  ui.navigate('down');
  ui.navigate('down');
  assert.deepEqual(seen, ['focus', 'blur']);
  assert.equal(ui.accept(), true);
  assert.deepEqual(clicks, [1]);
  assert.equal(buttons[1].pressed, true);
  ui.update(0.1);
  ui.update(0.1);
  assert.equal(buttons[1].pressed, false);
});

test('accept with nothing focused focuses the first widget instead of clicking', () => {
  const { ui, buttons, clicks } = menu();
  assert.equal(ui.accept(), true);
  assert.equal(ui.focused, buttons[0]);
  assert.deepEqual(clicks, []);
});

test('disabled and hidden widgets are skipped, and losing the focused widget clears focus', () => {
  const { ui, buttons } = menu(4);
  buttons[1].enabled = false;
  buttons[2].visible = false;
  ui.navigate('down');
  ui.navigate('down');
  assert.equal(ui.focused, buttons[3]);
  buttons[3].visible = false;
  assert.equal(ui.focused, null);
  ui.navigate('down');
  assert.equal(ui.focused, buttons[0]);
  buttons[0].enabled = false;
  assert.equal(ui.focused, null);
  assert.equal(ui.focus(buttons[0]), false, 'a disabled widget cannot take focus');
  assert.equal(ui.focus(buttons[3]), false, 'neither can a hidden one');
});

test('a focused slider takes left and right and passes up and down on', () => {
  const ui = makeUi(),
    slider = new Slider({ min: 0, max: 10, step: 1, value: 5, anchor: 'top-left', width: 300 }),
    button = new Button({ text: 'Below', anchor: 'top-left', margin: [100, 0, 0, 0] });
  ui.add(slider, button);
  ui.layout();
  ui.focus(slider, 'keyboard');
  ui.navigate('right');
  ui.navigate('right');
  assert.equal(slider.value, 7);
  ui.navigate('left');
  assert.equal(slider.value, 6);
  assert.equal(ui.focused, slider);
  ui.navigate('down');
  assert.equal(ui.focused, button);
});

test('tab steps through widgets in order, shift-tab goes back, and tab past the last leaves the UI', () => {
  const ui = makeUi(),
    a = new Button({ text: 'A', anchor: 'top-left' }),
    t = new Toggle({ text: 'T', anchor: 'top-left', margin: [60, 0, 0, 0] }),
    label = new Label({ text: 'not focusable', anchor: 'top-left', margin: [120, 0, 0, 0] });
  ui.add(a, t, label);
  ui.layout();
  assert.deepEqual(ui.focusables(), [a, t]);
  assert.equal(ui.tab(), true);
  assert.equal(ui.focused, a);
  assert.equal(ui.tab(), true);
  assert.equal(ui.focused, t);
  assert.equal(ui.tab(false), true);
  assert.equal(ui.focused, a);
  assert.equal(ui.tab(true), true);
  assert.equal(ui.tab(true), false, 'leaving');
  assert.equal(ui.focused, null);
  assert.equal(ui.tab(false), true, 'shift-tab from outside enters at the end');
  assert.equal(ui.focused, t);
});

test('arrow keys move through an inventory grid and accept picks up then puts down', () => {
  const ui = makeUi(),
    bag = new Inventory({ columns: 3, slots: 9, anchor: 'top-left', items: [{ id: 'a', name: 'A' }] });
  ui.add(bag);
  ui.layout();
  ui.focus(bag.slot(0), 'keyboard');
  ui.navigate('right');
  ui.navigate('down');
  assert.equal(ui.focused, bag.slot(4));
  ui.navigate('left');
  ui.navigate('up');
  assert.equal(ui.focused, bag.slot(0));
  ui.accept();
  assert.equal(bag.carried, 0);
  ui.navigate('down');
  ui.accept();
  assert.equal(bag.get(3).id, 'a');
  assert.equal(bag.carried, -1);
  ui.accept();
  assert.equal(bag.carried, 3);
  assert.equal(ui.cancel(), true, 'cancel puts the item back');
  assert.equal(bag.carried, -1);
});

test('focusing a row in a scrolling list scrolls it into view', () => {
  const ui = makeUi(),
    list = new List({
      items: Array.from({ length: 30 }, (_, i) => `Row ${i}`),
      height: 150,
      width: 200,
      anchor: 'top-left',
    });
  ui.add(list);
  ui.layout();
  ui.focus(list.children[0], 'keyboard');
  for (let i = 0; i < 12; i++) ui.navigate('down');
  ui.layout();
  assert.equal(ui.focused, list.children[12]);
  assert.ok(list.scrollY > 0);
  const row = list.children[12].rect;
  assert.ok(
    row.y >= list.rect.y - 1 && row.y + row.height <= list.rect.y + list.rect.height + 1,
    'the row is inside the list',
  );
});

test('a dialog traps focus, focuses its first button, and returns focus on close', async () => {
  const { ui, buttons } = menu();
  ui.focus(buttons[1], 'keyboard');
  const answer = ui.dialog({
    title: 'Sure?',
    buttons: [
      { label: 'Yes', value: 'y' },
      { label: 'No', value: 'n' },
    ],
  });
  const dialog = ui.modalLayer.children[0];
  ui.layout();
  assert.equal(ui.focused, dialog.firstButton);
  assert.deepEqual(ui.focusables(), dialog.children.at(-1).children, 'only the dialog buttons are reachable');
  ui.tab();
  assert.equal(ui.focused.text, 'No');
  assert.equal(ui.tab(), true, 'tab wraps inside a dialog');
  assert.equal(ui.focused.text, 'Yes');
  ui.navigate('up');
  assert.ok(dialog.children.at(-1).children.includes(ui.focused), 'arrows stay inside');
  assert.equal(ui.cancel(), true);
  assert.equal(await answer, undefined);
  assert.equal(ui.focused, buttons[1], 'focus is back where it was');
});

test('accept on a dialog button resolves it and a second dialog stacks above the first', async () => {
  const ui = makeUi();
  const first = ui.dialog({ message: 'one', buttons: [{ label: 'A', value: 1 }] });
  const second = ui.dialog({ message: 'two', buttons: [{ label: 'B', value: 2 }] });
  assert.equal(ui.focused.text, 'B');
  ui.accept();
  assert.equal(await second, 2);
  assert.equal(ui.focused.text, 'A', 'focus returns to the first dialog');
  ui.accept();
  assert.equal(await first, 1);
});

test('captureKeys and wantsKeys decide whether keys belong to the UI', () => {
  const { ui, buttons } = menu();
  assert.equal(ui.wantsKeys(), false);
  ui.captureKeys = true;
  assert.equal(ui.wantsKeys(), true);
  ui.captureKeys = false;
  ui.focus(buttons[0]);
  assert.equal(ui.wantsKeys(), true);
  ui.focus(null);
  assert.equal(ui.wantsKeys(), false);
  ui.dialog({ message: 'x' });
  assert.equal(ui.wantsKeys(), true);
});

test('execute maps commands and rejects use after dispose', () => {
  const { ui, buttons } = menu();
  assert.equal(ui.execute('down'), true);
  assert.equal(ui.focused, buttons[0]);
  assert.equal(ui.execute('next'), true);
  assert.equal(ui.focused, buttons[1]);
  assert.equal(ui.execute('previous'), true);
  assert.equal(ui.execute('accept'), true);
  assert.equal(ui.execute('cancel'), false, 'nothing to cancel');
  ui.dispose();
  assert.throws(
    () => ui.navigate('down'),
    (e) => e.code === 'disposed',
  );
});

test('the focus ring shows for the keyboard and hides for the pointer', () => {
  const { ui, buttons } = menu();
  ui.navigate('down');
  assert.equal(buttons[0].focusVisible, true);
  ui.pointerMove(5, 5);
  assert.equal(ui.inputMode, 'pointer');
  assert.equal(buttons[0].focusVisible, false, 'moving the mouse hides the ring');
  assert.equal(ui.focused, buttons[0], 'but keeps the focus');
  ui.navigate('down');
  assert.equal(buttons[1].focusVisible, true);
});
