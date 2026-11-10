import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Button, Panel, attachInput, attachMirror, themes, parseRgba, contrastRatio } from '../dist/index.js';
import { TextArea, TextInput, attachTextInputs } from '../dist/input.js';
import { makeUi } from './helpers.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function page() {
  const dom = new JSDOM(
    '<div style="position:relative"><canvas tabindex="0"></canvas><button id="after">After</button></div>',
  );
  const doc = dom.window.document,
    canvas = doc.querySelector('canvas'),
    ui = makeUi();
  const a = new TextInput({ label: 'Name', value: 'hello world', anchor: 'top-left' });
  const b = new TextArea({ label: 'Message', value: 'a\nb', anchor: 'top-left', margin: [60, 0, 0, 0] });
  ui.add(a, b);
  ui.layout();
  const offCanvas = attachInput(ui, canvas),
    offMirror = attachMirror(ui, canvas);
  const off = attachTextInputs(ui, canvas);
  return {
    ui,
    a,
    b,
    doc,
    canvas,
    window: dom.window,
    off,
    close() {
      off();
      offCanvas();
      offMirror();
      dom.window.close();
      ui.dispose();
    },
  };
}
test('single-line sanitization, multiline normalization, selection and constrained grapheme insertion', () => {
  const a = new TextInput({ value: 'a\r\nb', maxLength: 5 }),
    b = new TextArea({ value: 'a\r\nb\rc' });
  assert.equal(a.value, 'ab');
  assert.equal(b.value, 'a\nb\nc');
  a.select();
  a.insertText('👩‍💻');
  assert.equal(a.value, '👩‍💻');
  assert.equal(a.selectionEnd, 5);
  a.select();
  a.insertText('👩‍💻x');
  assert.equal(a.value, '👩‍💻');
  a.setSelectionRange(8, 2);
  assert.equal(a.selectionStart, 2);
  assert.equal(a.selectionEnd, 2);
  assert.throws(() => a.setSelectionRange(NaN), /finite/);
  assert.throws(() => new TextInput({ maxLength: -2 }), /maxLength/);
  a.readOnly = true;
  a.select();
  a.insertText('x');
  assert.equal(a.value, '👩‍💻');
});
test('caret, clipped scrolling, masked password and selection are canvas draw commands', () => {
  const ui = makeUi(),
    a = new TextInput({ value: 'secret👩‍💻', type: 'password', width: 80, anchor: 'top-left' });
  ui.add(a);
  ui.focus(a, 'keyboard');
  a.select();
  ui.update(0);
  const commands = ui.draw().commands;
  const text = commands
    .filter((c) => c.type === 'text')
    .map((c) => c.layout.text)
    .join('');
  assert.equal(text, '••••••••••••••', 'normal and selected glyph layers both remain masked');
  assert.ok(!JSON.stringify(commands).includes('secret'));
  assert.ok(commands.some((c) => c.type === 'clip' && c.width < 80));
  assert.ok(commands.filter((c) => c.type === 'rect').length >= 9, 'background, selection spans, caret and focus ring');
  ui.dispose();
});
test('native text fields are accessible, mirror edits and selections, and preserve element identity', async () => {
  const p = page();
  try {
    const el = p.doc.querySelector('input[data-margo-text-input]'),
      area = p.doc.querySelector('textarea');
    assert.equal(el.getAttribute('aria-label'), 'Name');
    assert.equal(area.getAttribute('aria-label'), 'Message');
    p.ui.focus(p.a, 'keyboard');
    assert.equal(p.doc.activeElement, el);
    const changes = [];
    p.a.on('change', (e) => changes.push(e.value));
    el.value = 'edited';
    el.setSelectionRange(1, 4, 'backward');
    el.dispatchEvent(new p.window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    await settle();
    assert.equal(p.a.value, 'edited');
    assert.deepEqual(changes, ['edited']);
    assert.equal(p.a.selectionStart, 1);
    assert.equal(p.a.selectionDirection, 'backward');
    p.a.placeholder = 'hint';
    await settle();
    assert.equal(p.doc.querySelector('input[data-margo-text-input]'), el);
    assert.equal(el.selectionEnd, 4);
    p.a.value = 'program';
    await settle();
    assert.deepEqual(changes, ['edited']);
    assert.equal(el.value, 'program');
    p.a.enabled = false;
    await settle();
    assert.equal(el.disabled, true);
  } finally {
    p.close();
  }
});
test('composition is not canceled, Enter submits only outside IME, multiline Enter is native', async () => {
  const p = page();
  try {
    const el = p.doc.querySelector('input[data-margo-text-input]'),
      area = p.doc.querySelector('textarea');
    let submits = 0;
    p.a.on('submit', () => submits++);
    el.dispatchEvent(new p.window.CompositionEvent('compositionstart', { bubbles: true }));
    el.value = '日本';
    el.setSelectionRange(2, 2);
    el.dispatchEvent(
      new p.window.InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' }),
    );
    const composingEnter = new p.window.KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(composingEnter);
    assert.equal(composingEnter.defaultPrevented, false);
    assert.equal(submits, 0);
    await settle();
    assert.equal(p.a.value, '日本');
    assert.equal(p.a.composing, true);
    el.dispatchEvent(new p.window.CompositionEvent('compositionend', { bubbles: true }));
    el.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(submits, 1);
    assert.equal(p.a.composing, false);
    const enter = new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    area.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, false);
  } finally {
    p.close();
  }
});
test('Tab follows widget order across the two mirrors, leaves either edge and removal cleans up', async () => {
  const p = page();
  try {
    const button = new Button({ text: 'Go', anchor: 'bottom' });
    p.ui.add(button);
    await settle();
    p.ui.focus(p.b, 'keyboard');
    p.doc.activeElement.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    assert.equal(p.ui.focused, button);
    assert.equal(p.doc.activeElement.textContent, 'Go');
    p.doc.activeElement.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    assert.equal(p.ui.focused, p.b, 'reverse Tab from ordinary mirror reaches text area');
    p.ui.focus(button, 'keyboard');
    p.doc.activeElement.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    assert.equal(p.ui.focused, null);
    assert.equal(p.doc.activeElement.id, 'after', 'the final widget leaves the Ui, without duplicate editor stops');
    const panel = new Panel({ children: [new TextInput({ label: 'Modal' })] });
    p.ui.modalLayer.add(panel);
    await settle();
    // A generic panel does not trap focus. A real Dialog does; the field must still be removed on detach.
    p.a.removeFromParent();
    await settle();
    assert.equal(p.doc.querySelector('[data-margo-text-input="' + p.a.id + '"]'), null);
    p.off();
    assert.equal(p.doc.querySelector('[data-margo-ui="text-inputs"]'), null);
  } finally {
    p.close();
  }
});
test('native focus waits for pointer release so canvas blur cannot cancel text selection', async () => {
  const p = page();
  try {
    p.canvas.focus();
    p.ui.pointerDown(p.a.rect.x + 13, p.a.rect.y + 20);
    await settle();
    assert.equal(p.doc.activeElement, p.canvas, 'canvas retains focus during capture');
    p.ui.pointerMove(700, p.a.rect.y + 20);
    p.ui.pointerUp(700, p.a.rect.y + 20);
    await settle();
    assert.equal(p.a.selectionEnd, p.a.value.length, 'drag reaches the end');
    assert.equal(p.doc.activeElement.dataset.margoTextInput, p.a.id, 'released pointer hands focus to native editor');
  } finally {
    p.close();
  }
});

test('IME state ends when native editing loses focus, is removed or detached', async () => {
  const p = page();
  try {
    p.ui.focus(p.a, 'keyboard');
    let el = p.doc.activeElement;
    el.dispatchEvent(new p.window.CompositionEvent('compositionstart', { bubbles: true }));
    assert.equal(p.a.composing, true);
    el.blur();
    await settle();
    assert.equal(p.a.composing, false);
    p.ui.focus(p.b, 'keyboard');
    el = p.doc.activeElement;
    el.dispatchEvent(new p.window.CompositionEvent('compositionstart', { bubbles: true }));
    p.b.removeFromParent();
    await settle();
    assert.equal(p.b.composing, false);
    p.ui.focus(p.a, 'keyboard');
    el = p.doc.activeElement;
    el.dispatchEvent(new p.window.CompositionEvent('compositionstart', { bubbles: true }));
    p.off();
    assert.equal(p.a.composing, false);
  } finally {
    p.close();
  }
});

test('native editing restarts the visible caret even when value and selection stay unchanged', async () => {
  const p = page();
  try {
    p.ui.focus(p.a, 'keyboard');
    await settle();
    for (let i = 0; i < 6; i++) p.ui.update(0.1);
    await settle();
    const caret = () => p.ui.draw().commands.some((c) => c.type === 'rect' && c.width === 1);
    assert.equal(caret(), false, 'the caret has entered its off phase');
    const before = p.a.value;
    p.doc.activeElement.dispatchEvent(new p.window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    assert.equal(p.a.value, before);
    assert.equal(p.a.selectionStart, 0);
    assert.equal(caret(), true, 'the reset blink state invalidates the draw list immediately');
    for (let i = 0; i < 6; i++) p.ui.update(0.1);
    await settle();
    assert.equal(caret(), false);
    p.ui.pointerDown(p.a.rect.x + 12, p.a.rect.y + 20);
    p.ui.pointerUp(p.a.rect.x + 12, p.a.rect.y + 20);
    assert.equal(p.a.selectionStart, 0);
    assert.equal(caret(), true, 'a click at the same caret position also restarts its visible phase');
  } finally {
    p.close();
  }
});

test('aborted attachment is disposable and creates no remaining native nodes', () => {
  const p = page();
  try {
    p.off();
    const signal = AbortSignal.abort();
    const off = attachTextInputs(p.ui, p.canvas, { signal });
    assert.equal(p.doc.querySelector('[data-margo-ui="text-inputs"]'), null);
    off[Symbol.dispose]();
  } finally {
    p.close();
  }
});

test('selected text uses its theme foreground and selection repaint visits each glyph only once', () => {
  for (const theme of Object.values(themes)) {
    const ui = makeUi({ theme }),
      field = new TextArea({ value: 'some text\n'.repeat(200), height: 100 });
    ui.add(field);
    ui.focus(field, 'keyboard');
    field.select();
    ui.update(0);
    const texts = ui.draw().commands.filter((c) => c.type === 'text');
    const normal = texts[0],
      selected = texts.slice(1);
    assert.ok(selected.length > 0);
    assert.ok(selected.every((c) => JSON.stringify(c.color) === JSON.stringify(parseRgba(theme.colors.onPrimary))));
    assert.ok(contrastRatio(theme.colors.onPrimary, theme.colors.primary) >= 4.5);
    assert.equal(
      selected.reduce((n, c) => n + c.layout.glyphs.length, 0),
      normal.layout.glyphs.length,
      'selection repaint is linear, including many wrapped lines',
    );
    ui.dispose();
  }
});

test('right-to-left text and pointer caret share the native field reading edge', () => {
  const ui = makeUi(),
    field = new TextInput({ value: 'مرحبا', width: 240, anchor: 'top-left' });
  ui.add(field);
  ui.focus(field, 'keyboard');
  field.setSelectionRange(field.value.length);
  ui.update(0);
  const command = ui.draw().commands.find((c) => c.type === 'text');
  assert.equal(command.x + command.layout.bounds.right * command.scale, field.rect.x + field.rect.width - 12);
  field.pointerDown(field.rect.x + field.rect.width - 13, field.rect.y + 20);
  assert.equal(field.selectionStart, 0, 'right edge is the logical start');
  ui.dispose();
});
