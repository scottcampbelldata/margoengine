import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { entries } from '../scripts/errors/entries.js';
import { errorsPage } from '../scripts/errors/page.mjs';

// margoengine.com/errors (site/errors.html) and the core and stage throws come from one source; these checks keep
// them from drifting apart.
// Core, the stage, compute and sciviz (whose messages link to their #compute and #sciviz entries) go through the same
// checks.
const sources = ['packages/core/src', 'packages/stage/src', 'packages/compute/src', 'packages/sciviz/src'].flatMap(
    (dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => ({ file: `${dir}/${f}`, text: readFileSync(`${dir}/${f}`, 'utf8') })),
  ),
  ids = new Map(entries.map((e) => [e.id, e])),
  // fault('code', message[, 'anchor']), typeError(message, 'anchor'), rangeError(message, 'anchor').
  call =
    /\b(?:(fault)\(\s*'(\w+)',\s*|(typeError|rangeError)\(\s*)('[^']*'|"[^"]*"|`[^`]*`|\w+(?:\.\w+)*)(?:,\s*'([\w-]+)')?,?\s*\)/g;

test('the committed errors page matches scripts/errors/entries.js', () => {
  assert.equal(readFileSync('site/errors.html', 'utf8').replace(/\r\n/g, '\n'), errorsPage());
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, 'entry ids are unique');
  for (const e of entries) assert.match(e.id, /^[a-z][a-z-]*$/, `${e.id}: anchor id`);
});

test('core and stage throw only through the linked helpers', () => {
  for (const { file, text } of sources) {
    assert.doesNotMatch(
      text,
      /new (Error|TypeError|RangeError)\(/,
      `${file}: throw through fault, typeError or rangeError`,
    );
    assert.doesNotMatch(
      text,
      /\bmargoError\(/,
      `${file}: use fault(code, message, anchor) so the message links to its help`,
    );
  }
});

test('every link from core and the stage points at an entry, and every MargoError code has one', () => {
  let calls = 0;
  for (const { file, text } of sources)
    for (const m of text.matchAll(call)) {
      calls++;
      const [, faultCall, code, other, message, anchor] = m,
        helper = faultCall ?? other,
        id = anchor ?? code;
      assert.ok(id, `${file}: ${m[0]} names no help anchor`);
      assert.ok(ids.has(id), `${file}: ${m[0]} links to #${id}, which site/errors.html lacks`);
      if (helper === 'fault') assert.equal(ids.get(code)?.kind, 'code', `${file}: code '${code}' needs a code entry`);
      // A literal message is listed under the entry it links to, so the page names what developers see.
      if (/^['"]/.test(message))
        assert.ok(
          ids.get(id).messages.includes(message.slice(1, -1)),
          `${file}: '${message}' is not listed under #${id}`,
        );
    }
  assert.ok(calls > 60, `found ${calls} throw sites`);
});

test('a thrown message ends with its help link', async () => {
  const { fault, typeError, rangeError } = await import('../packages/shared/errors.js');
  const error = fault('disposed', 'Mesh disposed');
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, 'disposed');
  assert.equal(error.message, 'Mesh disposed; see https://margoengine.com/errors#disposed');
  assert.equal(
    typeError('Invalid camera', 'arguments').message,
    'Invalid camera; see https://margoengine.com/errors#arguments',
  );
  assert.ok(rangeError('Invalid pick', 'views') instanceof RangeError);
});
