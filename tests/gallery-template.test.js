// The Harrow Head template's pure logic and its place in the checks (scripts/test-gallery-browser.mjs runs the pages).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eggCounter, initialSection } from '../examples/gallery/gallery.js';
import { demoSources } from '../scripts/support/affected-gpu.mjs';
import { galleryView } from '../scripts/support/visual-demos.js';

test('deep links: ?section wins, then the hash, then the first section; an unknown id opens the first', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(initialSection(ids, '?section=b', '#c'), 'b');
  assert.equal(initialSection(ids, '', '#c'), 'c');
  assert.equal(initialSection(ids, '', ''), 'a');
  assert.equal(initialSection(ids, '?section=gone', ''), 'a');
});

test('the dedication needs three presses inside the window, and a slow press starts over', () => {
  let now = 10_000,
    found = 0;
  const press = eggCounter(
    () => found++,
    () => now,
  );
  press();
  press();
  assert.equal(found, 0);
  press();
  assert.equal(found, 1);
  press();
  now += 2000;
  press();
  press();
  assert.equal(found, 1);
  press();
  assert.equal(found, 2);
});

test('the dedication is in no page copy, and its wording is exact', () => {
  for (const page of ['index.html', 'khronos.html']) {
    const html = readFileSync(new URL(`../examples/gallery/${page}`, import.meta.url), 'utf8');
    assert.ok(!html.includes('Margie'), page);
  }
  const source = readFileSync(new URL('../examples/gallery/gallery.js', import.meta.url), 'utf8');
  assert.ok(source.includes(String.raw`'Margo engine ❤️ made for Margie'`));
});

test('a gallery visual view maps to its page source', () => {
  const view = galleryView('lamp-room', 'hero');
  assert.deepEqual(demoSources(view), ['examples/gallery/lamp-room.html']);
  assert.match(view.path, /^gallery\/lamp-room\.html\?section=hero/);
});
