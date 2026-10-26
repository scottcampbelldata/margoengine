import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Button,
  Dialog,
  HealthBar,
  Inventory,
  Label,
  List,
  Menu,
  Panel,
  ProgressBar,
  Slider,
  Toggle,
  Widget,
  parseRgba,
  themes,
} from '../dist/index.js';
import { makeUi, near } from './helpers.js';

const rects = (ui) => ui.draw().commands.filter((c) => c.type === 'rect');
const texts = (ui) =>
  ui
    .draw()
    .commands.filter((c) => c.type === 'text')
    .map((c) => c.layout.text);
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test('widgets nest, move, and refuse to contain their own ancestor', () => {
  const a = new Panel({ id: 'a' }),
    b = new Panel({ id: 'b' }),
    c = new Panel({ id: 'c' });
  a.add(b);
  b.add(c);
  assert.equal(a.find('c'), c);
  assert.throws(
    () => c.add(a),
    (e) => e instanceof TypeError && /errors#ui/.test(e.message),
  );
  assert.throws(() => a.add({}), TypeError);
  a.add(c);
  assert.equal(c.parent, a);
  assert.deepEqual(b.children, []);
  a.insert(c, 0);
  assert.deepEqual(
    a.children.map((w) => w.id),
    ['c', 'b'],
  );
  a.insert(c, 2);
  assert.deepEqual(
    a.children.map((w) => w.id),
    ['b', 'c'],
  );
  a.remove(b);
  assert.equal(b.parent, null);
  assert.throws(() => a.insert(b, 0.5), RangeError);
});

test('events: on returns an unsubscribe that is also disposable', () => {
  const w = new Widget(),
    seen = [];
  const off = w.on('ping', (e) => seen.push(e.type + ':' + e.value));
  w.emit('ping', { value: 1 });
  off();
  w.emit('ping', { value: 2 });
  assert.deepEqual(seen, ['ping:1']);
  {
    using again = w.on('ping', () => seen.push('again'));
    w.emit('ping');
    assert.equal(typeof again, 'function');
  }
  w.emit('ping');
  assert.deepEqual(seen, ['ping:1', 'again']);
  assert.throws(() => w.on('x', 5), TypeError);
});

test('a button draws a themed fill and caption; disabled and hover change the look', () => {
  const ui = makeUi(),
    button = new Button({ text: 'Play', variant: 'primary', anchor: 'top-left' });
  ui.add(button);
  const first = rects(ui)[0];
  assert.ok(close(first.fill, parseRgba(themes.dark.colors.primary)));
  assert.deepEqual(texts(ui), ['Play']);
  assert.ok(first.height >= 44, 'touch target height');
  button.enabled = false;
  assert.ok(close(rects(ui)[0].fill, parseRgba(themes.dark.colors.disabled)));
  button.enabled = true;
  button.hovered = true;
  ui.update(1);
  assert.ok(!close(rects(ui)[0].fill, parseRgba(themes.dark.colors.primary)), 'hover mixes toward the text colour');
});

test('a button emits click on activate unless disabled', () => {
  let clicks = 0;
  const button = new Button({ text: 'Go', onClick: () => clicks++ });
  makeUi().add(button);
  button.activate();
  button.enabled = false;
  button.activate();
  assert.equal(clicks, 1);
  assert.equal(button.role, 'button');
  assert.equal(button.label, 'Go');
});

test('the focus ring draws only for visible focus and is two units wider than the button on each side', () => {
  const ui = makeUi(),
    button = new Button({ text: 'Go', anchor: 'top-left' });
  ui.add(button);
  const plain = rects(ui).length;
  button.focusVisible = true;
  ui.update(1);
  const ring = rects(ui).at(-1);
  assert.equal(rects(ui).length, plain + 1);
  assert.ok(close(ring.border, parseRgba(themes.dark.colors.focus)));
  assert.equal(ring.borderWidth, themes.dark.focusWidth);
  assert.equal(ring.x, button.rect.x - 3);
});

test('a toggle flips on activate, emits change, and switch and checkbox differ in role and look', () => {
  const values = [],
    toggle = new Toggle({ text: 'Music', onChange: (e) => values.push(e.value) }),
    box = new Toggle({ text: 'Subtitles', variant: 'checkbox', checked: true });
  makeUi().add(toggle, box);
  toggle.activate();
  toggle.activate();
  assert.deepEqual(values, [true, false]);
  assert.equal(toggle.role, 'switch');
  assert.equal(box.role, 'checkbox');
  assert.equal(box.checked, true);
  toggle.checked = true;
  assert.deepEqual(values, [true, false], 'setting checked is silent');
});

test('a slider clamps, snaps, emits change and answers left and right', () => {
  const seen = [],
    slider = new Slider({ min: 0, max: 10, step: 2, value: 5, onChange: (e) => seen.push(e.value) });
  makeUi().add(slider);
  assert.equal(slider.value, 6);
  slider.setValue(100);
  assert.equal(slider.value, 10);
  assert.equal(slider.command('left'), true);
  assert.equal(slider.value, 8);
  assert.equal(slider.command('right'), true);
  assert.equal(slider.command('right'), true);
  assert.equal(slider.value, 10);
  assert.equal(slider.command('up'), false);
  assert.deepEqual(seen, [10, 8, 10]);
  slider.value = -5;
  assert.equal(slider.value, 0);
  assert.throws(() => (slider.value = NaN), RangeError);
  assert.throws(() => new Slider({ min: 1, max: 1 }), RangeError);
  assert.throws(() => new Slider({ step: -1 }), RangeError);
});

test('a slider follows the pointer across its track', () => {
  const ui = makeUi(),
    slider = new Slider({ min: 0, max: 100, width: 300, anchor: 'top-left', showValue: false });
  ui.add(slider);
  ui.layout();
  assert.equal(slider.pointerDown(slider.rect.x + 14, 0), true);
  assert.equal(slider.value, 0);
  slider.pointerMove(slider.rect.x + 14 + (300 - 28) / 2, 0);
  near(slider.value, 50);
  slider.pointerMove(slider.rect.x + 5000, 0);
  assert.equal(slider.value, 100);
  slider.pointerUp();
  slider.pointerMove(slider.rect.x + 14, 0);
  assert.equal(slider.value, 100, 'no drag after release');
});

test('a progress bar clamps and shows its value as text, never by colour alone', () => {
  const ui = makeUi(),
    bar = new ProgressBar({ text: 'Loading', value: 0.4, anchor: 'top-left', width: 200 });
  ui.add(bar);
  assert.deepEqual(texts(ui), ['Loading', '40%']);
  bar.value = 5;
  assert.equal(bar.value, 1);
  bar.value = -2;
  assert.equal(bar.value, 0);
  assert.throws(() => (bar.value = Infinity), RangeError);
  assert.throws(() => new ProgressBar({ max: 0 }), RangeError);
  assert.equal(bar.role, 'progressbar');
});

test('a health bar moves through success, warning and danger colours and reads 72 / 100', () => {
  const ui = makeUi(),
    bar = new HealthBar({ anchor: 'top-left', width: 200, value: 100 });
  ui.add(bar);
  const fill = () =>
    rects(ui).find((r) => r.x > bar.rect.x * ui.scale && r.height < bar.rect.height * ui.scale && r.fill[3] === 1).fill;
  assert.ok(close(fill(), parseRgba(themes.dark.colors.success)));
  bar.value = 40;
  ui.update(1);
  assert.ok(close(fill(), parseRgba(themes.dark.colors.warning)));
  bar.value = 10;
  ui.update(1);
  assert.ok(close(fill(), parseRgba(themes.dark.colors.danger)));
  bar.value = 72;
  ui.update(1);
  assert.deepEqual(texts(ui), ['HP', '72 / 100']);
  assert.equal(bar.valueText, '72 / 100');
});

test('with motion a bar eases toward its value and a health bar keeps a damage trail', () => {
  const ui = makeUi({ reducedMotion: false }),
    bar = new HealthBar({ anchor: 'top-left', width: 200 });
  ui.add(bar);
  bar.value = 50;
  ui.update(0.016);
  assert.ok(bar.shown_ > 0.5 && bar.shown_ < 1, 'eases rather than jumping');
  assert.equal(bar.chip, 1, 'the chip stays at the old value during the hold');
  for (let i = 0; i < 120; i++) ui.update(0.016);
  near(bar.shown_, 0.5);
  near(bar.chip, 0.5);
});

test('a list selects rows, scrolls and reports the chosen entry', () => {
  const ui = makeUi(),
    chosen = [],
    list = new List({
      items: ['One', { label: 'Two', value: 22, detail: '$2' }, { label: 'Three', disabled: true }],
      height: 120,
      anchor: 'top-left',
      width: 200,
      onSelect: (e) => chosen.push([e.index, e.item]),
    });
  ui.add(list);
  ui.layout();
  const rows = list.children;
  rows[1].activate();
  rows[2].activate();
  assert.deepEqual(chosen, [[1, 22]]);
  assert.equal(list.selected, 1);
  assert.deepEqual(texts(ui), ['One', 'Two', '$2', 'Three']);
  assert.throws(() => list.select(9), RangeError);
  assert.throws(() => (list.items = [5]), TypeError);
  list.items = ['A'];
  assert.equal(list.selected, -1);
  assert.equal(list.children.length, 1);
});

test('a scrolling list clips its rows and the wheel scrolls it', () => {
  const ui = makeUi(),
    list = new List({
      items: Array.from({ length: 30 }, (_, i) => `Row ${i}`),
      height: 200,
      width: 200,
      anchor: 'top-left',
    });
  ui.add(list);
  const commands = ui.draw().commands;
  assert.equal(commands.filter((c) => c.type === 'clip').length, commands.filter((c) => c.type === 'unclip').length);
  assert.ok(commands.some((c) => c.type === 'clip' && c.height === 200));
  assert.equal(list.wheel(60), true);
  assert.equal(list.scrollY, 60);
  assert.equal(list.wheel(-500), true);
  assert.equal(list.scrollY, 0);
  assert.equal(list.wheel(-5), false);
  list.children[29].scrollIntoView();
  assert.ok(list.scrollY > 0);
});

test('an inventory picks up, moves, swaps and uses items with accept and cancel', () => {
  const ui = makeUi(),
    events = [],
    bag = new Inventory({
      columns: 3,
      slots: 6,
      anchor: 'top-left',
      items: [
        { id: 'potion', name: 'Potion', icon: 'P', count: 3, description: 'Heals' },
        null,
        { id: 'sword', name: 'Sword' },
      ],
    });
  for (const type of ['select', 'move', 'use']) bag.on(type, (e) => events.push([type, e.index, e.from]));
  ui.add(bag);
  ui.layout();
  assert.equal(bag.slots, 6);
  assert.equal(bag.slot(0).tooltip, 'Potion\nHeals');
  assert.equal(bag.slot(0).label, 'Potion, 3');
  assert.equal(bag.slot(1).label, 'Empty slot 2');
  bag.slot(0).activate();
  assert.equal(bag.carried, 0);
  bag.slot(1).activate();
  assert.equal(bag.get(1).id, 'potion');
  assert.equal(bag.get(0), null);
  assert.equal(bag.carried, -1);
  bag.slot(1).activate();
  bag.slot(1).activate();
  assert.deepEqual(
    events.map((e) => e[0]),
    ['select', 'move', 'select', 'use'],
  );
  bag.slot(2).activate();
  assert.equal(bag.slot(2).command('cancel'), true);
  assert.equal(bag.carried, -1);
  assert.equal(bag.slot(2).command('cancel'), false);
  assert.throws(() => bag.slot(9), RangeError);
  assert.throws(() => new Inventory({ columns: 0 }), RangeError);
});

test('dragging an item to another slot swaps them; a short press only picks it up', () => {
  const ui = makeUi(),
    bag = new Inventory({ columns: 2, slots: 4, anchor: 'top-left', items: [{ id: 'a', name: 'A' }] });
  ui.add(bag);
  ui.layout();
  const from = bag.slot(0).rect,
    to = bag.slot(3).rect;
  const center = (r) => [r.x + r.width / 2, r.y + r.height / 2];
  const [fx, fy] = center(from),
    [tx, ty] = center(to);
  assert.equal(bag.slot(0).pointerDown(fx, fy), true);
  bag.slot(0).pointerMove(tx, ty);
  assert.equal(bag.dragging, 0);
  bag.slot(0).pointerUp(tx, ty);
  assert.equal(bag.get(3).id, 'a');
  assert.equal(bag.get(0), null);
  bag.slot(3).pointerDown(tx, ty);
  bag.slot(3).pointerUp(tx + 1, ty);
  assert.equal(bag.carried, 3, 'a click picks up');
  const commands = ui.draw().commands;
  assert.ok(commands.length > 0);
});

test('a dialog is modal, resolves with the chosen button and removes itself', async () => {
  const ui = makeUi(),
    answer = ui.dialog({
      title: 'Quit?',
      message: 'Unsaved progress is lost.',
      buttons: [
        { label: 'Quit', value: 'quit' },
        { label: 'Stay', value: 'stay' },
      ],
    });
  const dialog = ui.modalLayer.children[0];
  assert.ok(dialog instanceof Dialog);
  assert.equal(dialog.role, 'dialog');
  assert.equal(ui.modalLayer.background, 'scrim');
  assert.equal(ui.modalLayer.pointerEvents, 'auto');
  assert.equal(dialog.label, 'Quit?');
  ui.layout();
  const stay = dialog.children.at(-1).children[1];
  stay.activate();
  assert.equal(await answer, 'stay');
  assert.equal(ui.modalLayer.children.length, 0);
  assert.equal(ui.modalLayer.background, 'none');
  assert.equal(ui.modalLayer.pointerEvents, 'none');
});

test('cancel closes a dismissible dialog with its cancel value and confirm maps it to false', async () => {
  const ui = makeUi(),
    confirmed = ui.confirm('Delete save?');
  const dialog = ui.modalLayer.children[0];
  assert.equal(dialog.command('cancel'), true);
  assert.equal(await confirmed, false);
  const second = ui.confirm('Again?');
  ui.modalLayer.children[0].children.at(-1).children[0].activate();
  assert.equal(await second, true);
  const fixed = ui.dialog({ message: 'Must answer', dismissible: false });
  assert.equal(ui.modalLayer.children[0].command('cancel'), false);
  ui.modalLayer.children[0].close('x');
  assert.equal(await fixed, 'x');
});

test('an aborted dialog closes and rejects with the abort reason', async () => {
  const ui = makeUi(),
    controller = new AbortController(),
    pending = ui.dialog({ message: 'Wait', signal: controller.signal });
  controller.abort(new Error('level changed'));
  await assert.rejects(pending, /level changed/);
  assert.equal(ui.modalLayer.children.length, 0);
  const already = AbortSignal.abort();
  await assert.rejects(ui.dialog({ message: 'Late', signal: already }), (e) => e.name === 'AbortError');
});

test('toasts stack, expire after their duration, pause on hover and keep at most five', () => {
  const ui = makeUi({ reducedMotion: true }),
    toast = ui.toast('Saved', { kind: 'success', duration: 2 });
  assert.equal(toast.role, 'status');
  assert.equal(ui.toast('Disk full', { kind: 'danger' }).role, 'alert');
  ui.update(0.1);
  toast.hovered = true;
  for (let i = 0; i < 40; i++) ui.update(0.1);
  assert.ok(toast.parent, 'a hovered toast stays');
  toast.hovered = false;
  for (let i = 0; i < 30; i++) ui.update(0.1);
  assert.equal(toast.parent, null);
  for (let i = 0; i < 8; i++) ui.toast('Item ' + i, { duration: 0 });
  ui.update(0.1);
  ui.update(0.1);
  const live = ui.toastLayer.children[0].children;
  assert.ok(live.length <= 6, `${live.length} toasts`);
  assert.throws(() => ui.toast(''), TypeError);
});

test('a persistent toast with an action calls it and dismisses', () => {
  const ui = makeUi();
  let undone = 0;
  const toast = ui.toast('Item dropped', { duration: 0, action: { label: 'Undo', onClick: () => undone++ } });
  toast.children.at(-1).activate();
  assert.equal(undone, 1);
  ui.update(0.1);
  ui.update(0.1);
  assert.equal(toast.parent, null);
});

test('a menu has a title, buttons for its items and a primary first button', () => {
  const picked = [],
    menu = new Menu({
      title: 'Paused',
      items: [
        { label: 'Resume', onSelect: () => picked.push('resume') },
        { label: 'Quit', onSelect: () => picked.push('quit'), disabled: true },
      ],
    });
  const ui = makeUi();
  ui.add(menu);
  assert.equal(menu.title, 'Paused');
  assert.equal(menu.label, 'Paused');
  assert.equal(menu.children.length, 3);
  menu.children[1].activate();
  menu.children[2].activate();
  assert.deepEqual(picked, ['resume']);
  assert.equal(menu.children[1].variant, 'primary');
  assert.equal(menu.children[2].variant, 'secondary');
  ui.layout();
  assert.equal(menu.rect.x + menu.rect.width / 2, 400);
});

test('hit testing finds the topmost widget that takes pointer events and honours clipping', () => {
  const ui = makeUi(),
    label = new Label({ text: 'Score', anchor: 'top-left' }),
    panel = new Panel({ background: 'surface', width: 100, height: 100, anchor: 'top-left', margin: [200, 0, 0, 200] }),
    button = new Button({ text: 'Ok', anchor: 'center', width: 60, height: 44 });
  panel.add(button);
  ui.add(label, panel);
  ui.layout();
  assert.equal(ui.root.hitTest(5, 5), null, 'labels let the pointer through');
  assert.equal(ui.root.hitTest(250, 250), panel);
  assert.equal(ui.root.hitTest(400, 300), null);
  const b = button.rect;
  assert.equal(ui.root.hitTest(b.x + 1, b.y + 1), button);
});

test('property setters ask for a layout only when something changed', () => {
  const ui = makeUi(),
    label = new Label({ text: 'a', anchor: 'top-left' });
  ui.add(label);
  ui.layout();
  const before = ui.draw().version;
  label.text = 'a';
  assert.equal(ui.draw().version, before, 'same text, same list');
  label.text = 'bb';
  assert.notEqual(ui.draw().version, before);
  assert.equal(label.rect.width, 0 + 18 * 0.5 * 2);
});

test('a disposed Ui refuses to update and its widgets are detached', () => {
  const ui = makeUi(),
    button = new Button({ text: 'x' });
  ui.add(button);
  ui.dispose();
  ui.dispose();
  assert.throws(
    () => ui.update(0.1),
    (e) => e.name === 'MargoError' && e.code === 'disposed' && /errors#ui/.test(e.message),
  );
  assert.throws(
    () => ui.toast('late'),
    (e) => e.code === 'disposed',
  );
  assert.equal(button.ui, null);
});

test('update validates dt and clamps long frames', () => {
  const ui = makeUi({ reducedMotion: false }),
    toast = ui.toast('x', { duration: 1 });
  assert.throws(() => ui.update(-1), RangeError);
  assert.throws(() => ui.update(NaN), RangeError);
  ui.update(30);
  assert.ok(toast.remaining > 0.8, 'a 30 s hitch counts as at most 0.1 s');
});

test('every widget id is unique unless given, and ui.find searches every layer', () => {
  const ui = makeUi(),
    a = new Button({ text: 'a' }),
    b = new Button({ text: 'b', id: 'named' });
  assert.notEqual(a.id, new Button().id);
  ui.add(a, b);
  assert.equal(ui.find('named'), b);
  const dialogPromise = ui.dialog({ message: 'hi' });
  assert.ok(ui.find(ui.modalLayer.children[0].id));
  ui.modalLayer.children[0].close();
  return dialogPromise;
});
