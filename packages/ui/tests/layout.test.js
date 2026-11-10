import test from 'node:test';
import assert from 'node:assert/strict';
import { arrange, edges, resolutionScale, validateStyle, Panel, Label, Button } from '../dist/index.js';
import { box, makeUi, near, node, rectOf } from './helpers.js';

const screen = { x: 0, y: 0, width: 400, height: 300 };

test('a column stacks children with a gap and stretches them to its width', () => {
  const a = box(50, 20),
    b = box(80, 30),
    root = node({ direction: 'column', gap: 10 }, [a, b]);
  arrange(root, screen);
  assert.deepEqual(a.rect, { x: 0, y: 0, width: 400, height: 20 });
  assert.deepEqual(b.rect, { x: 0, y: 30, width: 400, height: 30 });
});

test('a row centres children across and grow shares the free width', () => {
  const a = box(100, 20),
    b = box(0, 40, { grow: 1 }),
    c = box(0, 10, { grow: 3 }),
    root = node({ direction: 'row', gap: 10 }, [a, b, c]);
  arrange(root, screen);
  // 400 - 100 - 2 gaps of 10 = 280 free, split 1 : 3.
  assert.deepEqual(rectOf(a), [0, 140, 100, 20]);
  near(b.rect.width, 70);
  near(c.rect.width, 210);
  near(b.rect.x, 110);
  near(c.rect.x, 190);
  near(b.rect.y, 130);
  near(c.rect.y, 145);
});

test("'fill' on the main axis grows and on the cross axis fills", () => {
  const a = box(10, 10, { width: 'fill' }),
    b = box(10, 10, { height: 'fill' }),
    root = node({ direction: 'row' }, [a, b]);
  arrange(root, screen);
  near(a.rect.width, 390);
  near(b.rect.height, 300);
});

test('justify places children when nothing grows', () => {
  const make = (justify) => {
    const a = box(50, 10),
      b = box(50, 10),
      root = node({ direction: 'row', justify }, [a, b]);
    arrange(root, screen);
    return [a.rect.x, b.rect.x];
  };
  assert.deepEqual(make('start'), [0, 50]);
  assert.deepEqual(make('center'), [150, 200]);
  assert.deepEqual(make('end'), [300, 350]);
  assert.deepEqual(make('space-between'), [0, 350]);
  assert.deepEqual(make('space-around'), [75, 275]);
  assert.deepEqual(make('space-evenly'), [100, 250]);
});

test('shrink takes space from children in proportion to their size when the parent is too small', () => {
  const a = box(300, 10),
    b = box(100, 10),
    root = node({ direction: 'row' }, [a, b]);
  arrange(root, { x: 0, y: 0, width: 200, height: 50 });
  near(a.rect.width, 150);
  near(b.rect.width, 50);
  assert.equal(a.rect.x + a.rect.width, b.rect.x);
});

test('percent sizes resolve against the parent content box; padding and margin shrink it', () => {
  const a = box(1, 1, { width: '50%', height: '25%', margin: 5 }),
    root = node({ direction: 'stack', padding: [10, 20] }, [a]);
  arrange(root, screen);
  // content 360 x 280; the child is 50% of it, anchored top left by 'stretch' with an explicit size.
  near(a.rect.width, 180);
  near(a.rect.x, 25);
  near(a.rect.y, 15);
});

test('anchored children in a stack sit in their corner at their margin', () => {
  const corner = (anchor) => {
    const child = box(100, 40, { anchor, margin: 16 }),
      root = node({ direction: 'stack' }, [child]);
    arrange(root, screen);
    return rectOf(child);
  };
  assert.deepEqual(corner('top-left'), [16, 16, 100, 40]);
  assert.deepEqual(corner('top-right'), [284, 16, 100, 40]);
  assert.deepEqual(corner('bottom-left'), [16, 244, 100, 40]);
  assert.deepEqual(corner('bottom-right'), [284, 244, 100, 40]);
  assert.deepEqual(corner('center'), [150, 130, 100, 40]);
  assert.deepEqual(corner('top'), [150, 16, 100, 40]);
  assert.deepEqual(corner('left'), [16, 130, 100, 40]);
});

test('position absolute takes a child out of a column flow', () => {
  const flow = box(100, 50),
    pinned = box(30, 30, { position: 'absolute', anchor: 'bottom-right' }),
    root = node({ direction: 'column' }, [pinned, flow]);
  arrange(root, screen);
  assert.deepEqual(rectOf(flow), [0, 0, 400, 50]);
  assert.deepEqual(rectOf(pinned), [370, 270, 30, 30]);
});

test('bleed ignores the parent padding', () => {
  const full = node({ bleed: true }, []),
    inset = node({}, []),
    root = node({ direction: 'stack', padding: 20 }, [full, inset]);
  arrange(root, screen);
  assert.deepEqual(rectOf(full), [0, 0, 400, 300]);
  assert.deepEqual(rectOf(inset), [20, 20, 360, 260]);
});

test('hidden children take no space', () => {
  const hidden = { ...box(100, 100), visible: false },
    shown = box(10, 10),
    root = node({ direction: 'column', gap: 8 }, [hidden, shown]);
  arrange(root, screen);
  near(shown.rect.y, 0);
});

test('a grid fills cells row by row', () => {
  const cells = Array.from({ length: 5 }, () => box(10, 10)),
    root = node({ direction: 'grid', columns: 3, cellWidth: 40, cellHeight: 30, gap: [5, 6] }, cells);
  arrange(root, screen);
  assert.deepEqual(rectOf(cells[0]), [0, 0, 40, 30]);
  assert.deepEqual(rectOf(cells[2]), [90, 0, 40, 30]);
  assert.deepEqual(rectOf(cells[3]), [0, 36, 40, 30]);
});

test('a scrolling column keeps its content size, clamps the scroll offset and shifts the children', () => {
  const items = Array.from({ length: 10 }, () => box(10, 50)),
    root = node({ direction: 'column', overflow: 'scroll' }, items);
  root.scrollY = 1000;
  arrange(root, { x: 0, y: 0, width: 100, height: 200 });
  assert.equal(root.contentHeight, 500);
  assert.equal(root.scrollY, 300);
  assert.equal(items[0].rect.y, -300);
  root.scrollY = -5;
  arrange(root, { x: 0, y: 0, width: 100, height: 200 });
  assert.equal(root.scrollY, 0);
  assert.equal(items[0].rect.y, 0);
  assert.equal(items[9].rect.height, 50);
});

test('offset shifts a box and its children without moving its neighbours', () => {
  const inner = box(10, 10),
    moved = node({ offset: [7, 3], direction: 'column' }, [inner]),
    next = box(10, 10),
    root = node({ direction: 'column' }, [moved, next]);
  arrange(root, screen);
  near(moved.rect.x, 7);
  near(inner.rect.x, 7);
  near(inner.rect.y, 3);
  near(next.rect.y, 10);
});

test('min and max sizes bound a box', () => {
  const a = box(5, 5, { minWidth: 40, alignSelf: 'start' }),
    b = box(500, 5, { maxWidth: 100, alignSelf: 'start' }),
    root = node({ direction: 'column' }, [a, b]);
  arrange(root, screen);
  near(a.rect.width, 40);
  near(b.rect.width, 100);
});

test('edges expands one, two and four values and rejects bad ones', () => {
  assert.deepEqual(edges(4), [4, 4, 4, 4]);
  assert.deepEqual(edges([1, 2]), [1, 2, 1, 2]);
  assert.deepEqual(edges([1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(edges(undefined), [0, 0, 0, 0]);
  assert.throws(() => edges([1, 2, 3]), TypeError);
  assert.throws(() => edges(NaN), RangeError);
});

test('invalid styles throw errors that name the field and link to the help page', () => {
  assert.throws(
    () => validateStyle({ width: -1 }),
    (e) => e instanceof RangeError && /width/.test(e.message) && /errors#ui/.test(e.message),
  );
  assert.throws(() => validateStyle({ width: 'wide' }), TypeError);
  assert.throws(() => validateStyle({ columns: 0 }), RangeError);
  assert.throws(() => validateStyle({ grow: -1 }), RangeError);
  assert.throws(() => validateStyle({ offset: [1] }), RangeError);
  assert.throws(() => new Panel({ padding: 'x' }), TypeError);
});

test('text wraps to the width it is given and sets the height of a label', () => {
  const ui = makeUi(),
    label = new Label({ text: 'one two three four', size: 20 });
  ui.add(new Panel({ width: 100, children: [label] }));
  ui.layout();
  // 20 units per em, half an em per character: 10 per character, 10 characters per 100 units.
  assert.ok(label.rect.width <= 100);
  assert.equal(label.rect.height, 25 * 2);
  const wide = new Label({ text: 'one two three four', size: 20 });
  ui.add(new Panel({ width: 400, children: [wide] }));
  ui.layout();
  assert.equal(wide.rect.height, 25);
});

test('the user text scale grows text and reflows the layout', () => {
  const ui = makeUi(),
    button = new Button({ text: 'Play', anchor: 'top-left' });
  ui.add(button);
  ui.layout();
  const before = button.rect.width;
  ui.textScale = 2;
  ui.layout();
  assert.ok(button.rect.width > before + 20, `${button.rect.width} vs ${before}`);
  assert.throws(() => (ui.textScale = 4), RangeError);
});

test('resolution scaling follows the reference size, between the limits', () => {
  assert.equal(resolutionScale(1920, 1080), 1);
  assert.equal(resolutionScale(1920, 1080, 2), 2);
  const ref = { reference: [1280, 720], match: 1 };
  near(resolutionScale(1920, 1080, ref), 1.5);
  near(resolutionScale(1920, 720, { reference: [1280, 720], match: 0 }), 1.5);
  near(resolutionScale(2560, 720, { reference: [1280, 720] }), Math.sqrt(2));
  assert.equal(resolutionScale(100, 100, { reference: [1280, 720], min: 0.5 }), 0.5);
  assert.equal(resolutionScale(100000, 100000, { reference: [1280, 720], max: 4 }), 4);
  assert.throws(() => resolutionScale(1, 1, 0), RangeError);
  assert.throws(() => resolutionScale(1, 1, { reference: [0, 1] }), RangeError);
  assert.throws(() => resolutionScale(1, 1, { reference: [1, 1], match: 2 }), RangeError);
});

test('the Ui lays out in UI units: a reference size changes the units and the draw scale', () => {
  const ui = makeUi({ width: 1920, height: 1080, pixelRatio: 2, scale: { reference: [1280, 720], match: 0.5 } });
  near(ui.width, 1280);
  near(ui.height, 720);
  near(ui.scale, 3);
  const panel = new Panel({ background: 'surface', width: 100, height: 50, anchor: 'top-left', margin: 10 });
  ui.add(panel);
  const rect = ui.draw().commands.find((c) => c.type === 'rect');
  assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [30, 30, 300, 150]);
  ui.resize(960, 540, 1);
  near(ui.width, 1280);
  near(ui.scale, 0.75);
});

test('the safe area insets the screen layer; bleed widgets fill the whole screen', () => {
  const ui = makeUi({ safeArea: [20, 10, 30, 40] }),
    hud = new Panel({ anchor: 'top-left', width: 50, height: 50 }),
    backdrop = new Panel({ bleed: true, background: 'surface' });
  ui.add(backdrop, hud);
  ui.layout();
  assert.deepEqual(rectOf(hud), [40, 20, 50, 50]);
  assert.deepEqual(rectOf(backdrop), [0, 0, 800, 600]);
  const corner = new Panel({ anchor: 'bottom-right', width: 50, height: 50 });
  ui.add(corner);
  ui.layout();
  assert.deepEqual(rectOf(corner), [740, 520, 50, 50]);
  ui.setSafeArea([0, 0, 0, 0]);
  ui.layout();
  assert.deepEqual(rectOf(hud), [0, 0, 50, 50]);
});

// CSS Flexible Box Layout Level 1, section 9.7: a clamped item is frozen and the rest of the space goes round again.
test('space a maxWidth child cannot take goes to the other growing children', () => {
  const a = box(0, 10, { grow: 1, maxWidth: 50 }),
    b = box(0, 10, { grow: 1 }),
    root = node({ direction: 'row' }, [a, b]);
  arrange(root, screen);
  // One pass gave a 50 and b 200, leaving 150 empty; 9.7 freezes a at 50 and b takes the other 350.
  near(a.rect.width, 50);
  near(b.rect.width, 350);
});

test('a shortage a minWidth child cannot give up comes from the other children', () => {
  const a = box(300, 10, { minWidth: 280 }),
    b = box(300, 10),
    root = node({ direction: 'row' }, [a, b]);
  arrange(root, screen);
  // 200 short: equal scaled shrink asks 100 of each; a stops at 280, so b gives the other 180.
  near(a.rect.width, 280);
  near(b.rect.width, 120);
});

test('grow factors summing below 1 take only that fraction of the free space', () => {
  const a = box(100, 10, { grow: 0.5 }),
    root = node({ direction: 'row' }, [a]);
  arrange(root, screen);
  // 300 free, factor sum 0.5: a grows by 150 (9.7 step 4b).
  near(a.rect.width, 250);
});
