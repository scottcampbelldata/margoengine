import test from 'node:test';
import assert from 'node:assert/strict';
import { arrange, validateStyle, Panel, Label, Button } from '../dist/index.js';
import { box, makeUi, near, node, rectOf } from './helpers.js';

const screen = { x: 0, y: 0, width: 330, height: 300 };

test('a wrapping row moves children that do not fit onto new lines, separated by the row gap', () => {
  const kids = [box(100, 20), box(100, 30), box(100, 20), box(100, 40), box(100, 20)],
    root = node({ direction: 'row', wrap: true, gap: [10, 6], align: 'start' }, kids);
  arrange(root, screen);
  // 3 x 100 + 2 gaps of 10 = 320 fits in 330; a fourth would need 430.
  assert.deepEqual(kids.map((k) => [k.rect.x, k.rect.y]), [
    [0, 0],
    [110, 0],
    [220, 0],
    [0, 36], // the first line is 30 tall (its tallest child) plus the row gap of 6
    [110, 36],
  ]);
  near(root.contentHeight, 30 + 6 + 40, 'content height is both lines and the gap');
  // Without wrap the same five children stay on one line and shrink to fit.
  const flat = [box(100, 20), box(100, 30), box(100, 20), box(100, 40), box(100, 20)];
  arrange(node({ direction: 'row', gap: 10 }, flat), screen);
  assert.ok(flat.every((k) => k.rect.y > 0 && k.rect.width < 100), 'one shrunk line, centred across');
});

test('each line shares its own free space, justifies itself and aligns its children within its height', () => {
  const a = box(100, 20),
    b = box(100, 40),
    c = box(100, 20, { grow: 1 }),
    d = box(50, 10),
    root = node({ direction: 'row', wrap: true, gap: 10 }, [a, b, c, d]);
  arrange(root, { x: 0, y: 0, width: 300, height: 300 });
  // Line 1: a, b (210 of 300; c would need 320). Line 2: c grows to fill what d leaves.
  near(a.rect.y, 10, 'centred in the 40-tall first line');
  near(b.rect.y, 0);
  near(c.rect.y, 50, 'the second line starts at 40 + the gap of 10 and is as tall as c');
  near(c.rect.width, 300 - 10 - 50, 'c takes the second line free space');
  near(d.rect.x, 250);
  const j = [box(100, 20), box(100, 20), box(100, 20)];
  arrange(node({ direction: 'row', wrap: true, justify: 'center' }, j), { x: 0, y: 0, width: 250, height: 100 });
  near(j[0].rect.x, 25, 'first line of two centred');
  near(j[2].rect.x, 75, 'second line of one centred');
});

test('a child wider than the row has a line to itself and shrinks to it; stretch fills the line height', () => {
  const a = box(50, 20),
    b = box(500, 30),
    c = box(50, 20, { alignSelf: 'stretch' }),
    root = node({ direction: 'row', wrap: true }, [a, b, c]);
  arrange(root, { x: 0, y: 0, width: 200, height: 300 });
  assert.deepEqual(rectOf(a), [0, 0, 50, 20]);
  assert.deepEqual(rectOf(b), [0, 20, 200, 30]);
  assert.deepEqual(rectOf(c), [0, 50, 50, 20]);
});

test('an auto-height panel measures its wrapped lines, and Labels reflow when the panel narrows', () => {
  const ui = makeUi({ width: 400, height: 300 });
  const tags = ['fire', 'ice', 'poison', 'holy', 'shadow', 'storm'].map((text) => new Label({ text }));
  const bar = new Panel({ direction: 'row', wrap: true, gap: 8, width: 200, anchor: 'top-left', children: tags });
  ui.add(bar);
  ui.update(0);
  const lines = new Set(tags.map((t) => t.rect.y));
  assert.ok(lines.size > 1, `the tags wrap onto ${lines.size} lines`);
  const bottom = Math.max(...tags.map((t) => t.rect.y + t.rect.height));
  near(bar.rect.height, bottom - bar.rect.y, 'the panel is as tall as its lines');
  assert.ok(tags.every((t) => t.rect.x + t.rect.width <= bar.rect.x + 200 + 1e-6), 'no tag past the right edge');
  bar.setStyle({ width: 400 });
  ui.update(0);
  assert.equal(new Set(tags.map((t) => t.rect.y)).size, 1, 'wide enough: one line again');
});

test('a wrapping row with overflow scroll scrolls its lines vertically; wrap must be a boolean', () => {
  const kids = Array.from({ length: 12 }, () => box(90, 30)),
    root = node({ direction: 'row', wrap: true, gap: 10, overflow: 'scroll', align: 'start' }, kids);
  root.scrollY = 1000;
  arrange(root, { x: 0, y: 0, width: 200, height: 100 });
  // 2 per line, 6 lines: 6 x 30 + 5 x 10 = 230; the view is 100, so the scroll clamps at 130.
  near(root.contentHeight, 230);
  near(root.scrollY, 130);
  near(kids[11].rect.y, 200 - 130);
  assert.throws(() => validateStyle({ wrap: 'yes' }), TypeError);
  assert.doesNotThrow(() => new Button({ text: 'ok', wrap: false }));
});
