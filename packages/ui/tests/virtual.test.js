import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualList } from '../dist/index.js';
import { makeUi, near } from './helpers.js';

// Defaults: padding 4, gap 2, row height 44, so a row starts every 46 units.
const STEP = 46;
const rows = (list) => list.children.filter((c) => c.role === 'option');

function setup(options = {}) {
  const ui = makeUi(),
    calls = [];
  const list = new VirtualList({
    count: 100_000,
    height: 240,
    width: 300,
    anchor: 'top-left',
    row: (i) => {
      calls.push(i);
      return { label: `Item ${i}`, detail: `${i % 7} g`, value: { id: i } };
    },
    ...options,
  });
  ui.add(list);
  ui.update(0);
  return { ui, list, calls };
}

test('a list of 100,000 rows builds only the rows in view plus the overscan, and its content height is exact', () => {
  const { list, calls } = setup();
  // 232 units inside the padding show rows 0 to 5; 4 more are built below.
  assert.deepEqual(list.range, [0, 10]);
  assert.equal(rows(list).length, 10);
  assert.ok(calls.length <= 10 * 2, `row() called ${calls.length} times`);
  assert.ok(Math.max(...calls) < 10, 'no row past the overscan was asked for');
  // Spacer for rows 10 to 99,999 plus the rows: 100,000 rows of 44 and 99,999 gaps of 2 (content is inside the padding).
  near(list.contentHeight, 100_000 * 44 + 99_999 * 2, 'content height');
  rows(list).forEach((row, k) => near(row.rect.y, list.rect.y + 4 + k * STEP, `row ${k} y`));
});

test('scrolling builds the rows that come into view at their true place and drops the rest', () => {
  const { ui, list, calls } = setup();
  calls.length = 0;
  list.wheel(50_000 * STEP);
  ui.update(0);
  const [first, last] = list.range;
  assert.equal(first, 50_000 - 4);
  assert.ok(last - first <= 6 + 8 + 1, `built ${last - first} rows`);
  assert.equal(rows(list).length, last - first, 'only the range is built');
  for (const row of rows(list))
    near(row.rect.y, list.rect.y + 4 + row.index * STEP - list.scrollY, `row ${row.index} sits where it would in a full list`);
  assert.ok(calls.every((i) => i >= first && i < last), 'row() only for built rows');
  // To the end: the last row ends at the bottom of the view.
  list.wheel(1e9);
  ui.update(0);
  assert.equal(list.range[1], 100_000);
  const end = rows(list).at(-1);
  assert.equal(end.index, 99_999);
  near(end.rect.y + end.rect.height, list.rect.y + list.rect.height - 4, 'the last row ends at the bottom');
});

test('selection survives scrolling away and back, and select emits the entry value', () => {
  const { ui, list } = setup({ selected: 3 });
  const seen = [];
  list.on('select', (e) => seen.push([e.index, e.item.id]));
  assert.equal(list.selected, 3);
  assert.equal(rows(list)[3].selected, true);
  list.select(70_000, true);
  assert.deepEqual(seen, [[70_000, 70_000]], 'the row need not be built to be selected');
  list.scrollToIndex(70_000);
  ui.update(0);
  assert.equal(rows(list).find((r) => r.index === 70_000).selected, true);
  assert.equal(rows(list).filter((r) => r.selected).length, 1);
  // A row pressed with the pointer selects through the list.
  const row = rows(list).find((r) => r.index === 70_001);
  row.activate();
  assert.deepEqual(seen.at(-1), [70_001, 70_001]);
  assert.throws(() => list.select(100_000), RangeError);
});

test('arrow keys move focus through every row, scrolling and building as they go', () => {
  const { ui, list } = setup({ count: 40 });
  assert.equal(ui.focus(rows(list)[0]), true);
  for (let i = 0; i < 25; i++) assert.equal(ui.navigate('down'), true, `down ${i}`);
  ui.update(0);
  assert.equal(ui.focused?.index, 25, 'row 25 has the focus');
  const r = ui.focused.rect;
  assert.ok(r.y >= list.rect.y && r.y + r.height <= list.rect.y + list.rect.height + 1e-6, 'and it is in view');
  for (let i = 0; i < 25; i++) ui.navigate('up');
  assert.equal(ui.focused?.index, 0);
  near(list.scrollY, 0, 'back at the top');
  // Past the last row the UI moves on as from a full list's end: with nothing below, focus wraps to row 0, scrolled
  // to the top, not to the first row that happens to be built.
  assert.equal(list.focusIndex(39), true);
  ui.update(0);
  assert.equal(ui.navigate('down'), true);
  assert.equal(ui.focused?.index, 0);
  near(list.scrollY, 0, 'wrapped to the top');
  assert.equal(ui.navigate('up'), true);
  assert.equal(ui.focused?.index, 39, 'and up from row 0 wraps to the last row');
});

test('a focused row scrolled out of the built range gives up the focus instead of staying on a dropped widget', () => {
  const { ui, list } = setup();
  ui.focus(rows(list)[1]);
  list.wheel(10_000);
  ui.update(0);
  assert.equal(ui.focused, null);
});

test('count and refresh rebuild the rows; bad options throw', () => {
  let label = 'a';
  const { ui, list } = setup({ row: (i) => `${label}${i}`, selected: 5 });
  assert.equal(rows(list)[0].text, 'a0');
  label = 'b';
  list.refresh();
  ui.update(0);
  assert.equal(rows(list)[0].text, 'b0');
  list.count = 3;
  ui.update(0);
  assert.equal(list.selected, -1, 'a selection past the new end is cleared');
  assert.equal(rows(list).length, 3);
  near(list.contentHeight, 3 * 44 + 2 * 2, 'three rows');
  list.count = 0;
  ui.update(0);
  assert.equal(list.children.length, 0);
  assert.throws(() => new VirtualList({ count: -1 }), RangeError);
  assert.throws(() => new VirtualList({ count: 1.5 }), RangeError);
  assert.throws(() => new VirtualList({ rowHeight: 0 }), RangeError);
  assert.throws(() => new VirtualList({ overscan: -1 }), RangeError);
  assert.throws(() => new VirtualList({ row: 'x' }), TypeError);
  assert.throws(() => new VirtualList({ count: 1, row: () => 5 }), TypeError);
});
