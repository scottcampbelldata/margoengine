import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualKeyboard } from '../dist/keyboard.js';
import { TextInput, TextArea } from '../dist/input.js';
import { WorldPanel, WorldPanels } from '../dist/world.js';
import { makeUi } from './helpers.js';

test('keyboard edits selected text, shifts once, caps locks, submits and respects field guards', () => {
  const field = new TextInput({ value: 'planet' }),
    keyboard = new VirtualKeyboard({ target: field });
  let changes = 0,
    submits = 0;
  field.on('change', () => changes++);
  field.on('submit', () => submits++);
  field.setSelectionRange(0, 6);
  keyboard.press('Shift');
  keyboard.press('m');
  keyboard.press('a');
  keyboard.press('CapsLock');
  keyboard.press('r');
  keyboard.press('Shift');
  keyboard.press('s');
  assert.equal(field.value, 'MaRs');
  assert.equal(changes, 4);
  keyboard.press('Enter');
  assert.equal(submits, 1);
  field.readOnly = true;
  assert.equal(keyboard.press('a'), false);
  field.readOnly = false;
  field.composing = true;
  assert.equal(keyboard.press('Backspace'), false);
  field.composing = false;
  field.enabled = false;
  assert.equal(keyboard.press('a'), false);
  field.enabled = true;
  keyboard.connect(null);
  assert.equal(keyboard.press('a'), false);
  assert.throws(() => new VirtualKeyboard({ rows: [[]] }), RangeError);
});
test('backspace and delete operate on graphemes, maxLength preserves clusters, multiline Enter inserts', () => {
  const field = new TextArea({ value: 'A👩‍🚀e\u0301Z' }),
    keyboard = new VirtualKeyboard({ target: field });
  keyboard.press('End');
  keyboard.press('Backspace');
  keyboard.press('Backspace');
  assert.equal(field.value, 'A👩‍🚀');
  keyboard.press('Home');
  keyboard.press('Delete');
  assert.equal(field.value, '👩‍🚀');
  keyboard.press('ArrowRight');
  keyboard.press('Enter');
  assert.equal(field.value, '👩‍🚀\n');
  keyboard.press('ArrowLeft');
  keyboard.press('Backspace');
  assert.equal(field.value, '\n');
  const short = new TextInput({ maxLength: 2 });
  keyboard.connect(short);
  keyboard.press('😀');
  keyboard.press('a');
  assert.equal(short.value, '😀');
});
test('same-UI focus reconnects, gamepad activation retains target, XR rays activate the same keys', () => {
  const ui = makeUi({ width: 700, height: 400 }),
    field = new TextInput({ width: 200, height: 44, anchor: 'top-left' }),
    keyboard = new VirtualKeyboard({
      anchor: 'bottom',
      rows: [
        ['a', 'b'],
        ['Backspace', 'Enter'],
      ],
    });
  ui.add(field, keyboard);
  ui.update(0);
  ui.focus(field, 'gamepad');
  const first = keyboard.children[0].children[0];
  ui.focus(first, 'gamepad');
  ui.execute('accept', 'gamepad');
  assert.equal(field.value, 'a');
  assert.equal(keyboard.target, field);
  ui.execute('right', 'gamepad');
  ui.execute('accept', 'gamepad');
  assert.equal(field.value, 'ab');
  const panel = new WorldPanel(ui, { width: 7, height: 4 }),
    panels = new WorldPanels();
  panels.add(panel);
  const back = keyboard.children[1].children[0],
    r = back.rect,
    ray = { origin: [(r.x + r.width / 2) / 100 - 3.5, 2 - (r.y + r.height / 2) / 100, 2], direction: [0, 0, -1] };
  panels.pointer(ray, true, { id: 1, type: 'pen' });
  panels.pointer(ray, false, { id: 1, type: 'pen' });
  assert.equal(field.value, 'a');
  const second = new TextInput();
  ui.add(second);
  ui.focus(second);
  assert.equal(keyboard.target, second);
  keyboard.dispose();
  ui.focus(field);
  assert.equal(keyboard.ui, null);
  ui.dispose();
  panels.dispose();
});
