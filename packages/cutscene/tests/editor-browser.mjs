// Real-browser proof of @margoengine/cutscene/editor (from the repository root after building packages):
// node packages/cutscene/tests/editor-browser.mjs
// Drives the panel with a real mouse and keyboard. The numbers are pixels of a panel at 100 pixels a second.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { waitReady, watchPage } from './page-ready.mjs';

const context = await openBrowser({ startPath: '/packages/cutscene/tests/editor-browser.html', port: 5344 }),
  { page } = context;
let pageErrors = [];
const near = (a, b, limit, what) => assert.ok(Math.abs(a - b) <= limit, `${what}: ${a} is not ${b} within ${limit}`);
const panel = (name, ...args) => page.evaluate(([n, a]) => window.panel[n](...a), [name, args]);
const box = async (selector) => {
  const found = await page.locator(selector).boundingBox();
  assert.ok(found, `${selector} is on the page`);
  return { x: found.x + found.width / 2, y: found.y + found.height / 2, left: found.x, width: found.width };
};
const item = (track, index) => `.mtl-item[data-track="${track}"][data-index="${index}"]`;
/** Left edge of the timeline in the page, and a time's x on the ruler at a zoom. */
const origin = async () => (await box('.mtl-ruler')).left;
const drag = async (from, to, y) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(from.x + ((to - from.x) * i) / 5, y ?? from.y);
  await page.mouse.up();
};
try {
  pageErrors = await watchPage(page);
  await waitReady(page, pageErrors);
  const left = await origin(),
    ruler = await box('.mtl-ruler');

  // Scrub: down on the ruler and along it; snap puts the playhead on the grid and it reports every step.
  await drag({ x: left + 50, y: ruler.y }, left + 152);
  near(await panel('time'), 1.5, 1e-9, 'scrubbed to 1.5 s, by the pull of the grid');
  const seeks = await page.evaluate(() => window.panel.log.seek);
  assert.ok(seeks.length >= 5 && seeks[0] < seeks.at(-1), `seek fired as it went: ${seeks}`);

  // Drag a key: the list stays sorted, the drag is one undo step, and the ruler kept out of it.
  await drag(await box(item('door', 1)), left + 402);
  assert.deepEqual(await panel('times', 'door'), [1, 4, 6]);
  assert.equal(await panel('undoCount'), 1, 'a whole drag is one edit');
  near((await box(item('door', 1))).x - left, 400, 1, 'the key is drawn at its new time');
  near(await panel('time'), 1.5, 1e-9, 'moving a key leaves the playhead');

  // Undo and redo on the keyboard.
  await page.keyboard.press('Control+z');
  assert.deepEqual(await panel('times', 'door'), [1, 3, 6]);
  await page.keyboard.press('Control+Shift+z');
  assert.deepEqual(await panel('times', 'door'), [1, 4, 6]);
  await page.keyboard.press('Control+z');

  // Snap pulls a key onto the clip's end at 4 s from up to 8 pixels away; off, it lands where the mouse let go.
  await drag(await box(item('door', 1)), left + 396);
  assert.deepEqual(await panel('times', 'door'), [1, 4, 6]);
  await page.keyboard.press('Control+z');
  await page.locator('.mtl-bar button', { hasText: 'Snap' }).click();
  await drag(await box(item('door', 1)), left + 396);
  near((await panel('times', 'door'))[1], 3.96, 0.011, 'no snap: to the pixel');
  await page.keyboard.press('Control+z');
  await page.locator('.mtl-bar button', { hasText: 'Snap' }).click();

  // Two items by Shift, moved together, keep their distance.
  await page.locator(item('door', 0)).click();
  await page.locator(item('door', 2)).click({ modifiers: ['Shift'] });
  assert.equal(await panel('selected'), 2);
  await page.keyboard.press('ArrowRight');
  assert.deepEqual((await panel('times', 'door')).map((t) => Number(t.toFixed(6))), [1.1, 3, 6.1]);
  await page.keyboard.press('Shift+ArrowLeft');
  assert.deepEqual((await panel('times', 'door')).map((t) => Number(t.toFixed(6))), [0.1, 3, 5.1]);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.equal(await panel('selected'), 0, 'undo clears a selection whose places are gone');

  // A move the document refuses: the first shot may not run into the second, and nothing changes.
  const count = await panel('undoCount');
  await drag(await box(item('edit', 0)), (await box(item('edit', 0))).x + 100);
  assert.deepEqual(await panel('times', 'edit'), [0, 2]);
  assert.equal(await panel('undoCount'), count);
  await page.keyboard.press('Escape');

  // The keyboard alone: click nothing, keying at the playhead on the current row, walking and deleting.
  await page.locator('.mtl-name[data-row="door"]').click();
  await page.locator('.mtl-ruler').focus();
  await page.keyboard.press('Home');
  assert.equal(await panel('time'), 0);
  for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowRight');
  near(await panel('time'), 2.5, 1e-9, 'twenty-five steps of a tenth');
  await page.keyboard.press('k');
  assert.deepEqual(await panel('times', 'door'), [1, 2.5, 3, 6]);
  assert.equal(await panel('selected'), 1, 'the new key is selected');
  assert.match(await panel('focused'), /key .*at 2\.50 seconds on door/, 'and named for a screen reader');
  await page.keyboard.press('Delete');
  assert.deepEqual(await panel('times', 'door'), [1, 3, 6]);
  await page.keyboard.press('End');
  near(await panel('time'), 10, 1e-9, 'End');

  // Every item can be reached with Tab.
  await page.locator('.mtl-ruler').focus();
  await page.keyboard.press('Tab');
  assert.match(await panel('focused'), /^key .*door/);

  // Zoom, by key and by wheel over a time, which stays under the pointer.
  await page.keyboard.press('Escape');
  const was = await panel('zoom');
  await page.keyboard.press('+');
  near(await panel('zoom'), was * 1.25, 1e-9, 'plus');
  await page.keyboard.press('-');
  near(await panel('zoom'), was, 1e-9, 'minus');
  // A panel narrower than the timeline, so the scroll has room: at the ends it stops, as any scroll does.
  await page.setViewportSize({ width: 800, height: 700 });
  const under = (await box(item('door', 1))).x;
  await page.mouse.move(under, ruler.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.waitForFunction((zoom) => window.panel.zoom() > zoom, was);
  near(await panel('zoom'), was * 1.25, 1e-9, 'wheel');
  near((await box(item('door', 1))).x, under, 1.5, 'the key under the pointer stays there');
  const widened = await box(item('music', 0));
  near(widened.width, 3 * was * 1.25, 1, 'clips widen with the zoom');

  // Export: a real download, and a real Cutscene reads the file.
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.mtl-bar button', { hasText: 'Export' }).click()]);
  assert.equal(download.suggestedFilename(), 'cutscene.json');
  const text = await readFile(await download.path(), 'utf8');
  assert.equal(JSON.parse(text).format, 'margo-cutscene');
  assert.deepEqual(JSON.parse(text).tracks[0].keys.map((key) => key.time), [1, 3, 6]);
  assert.equal(await panel('reads', text), true);

  // A phone: the page itself does not scroll sideways; the timeline does, inside the panel.
  await page.setViewportSize({ width: 390, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  assert.equal(await panel('dispose'), true);
  assert.deepEqual(pageErrors, []);
  console.log('ok editor: scrub, drag, snap, group move, refusal, keyboard, zoom, export, phone width');
} finally {
  await context.close();
}
