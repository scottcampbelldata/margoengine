import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardLabels, layoutBindingLabel } from '../dist/layout.js';
const keyboard = (fn) => Object.assign(new EventTarget(), { getLayoutMap: fn });
test('native Keyboard Map without draft event methods still loads and refreshes', async () => {
  let glyph = 'a';
  const labels = new KeyboardLabels({ keyboard: { getLayoutMap: async () => new Map([['KeyQ', glyph]]) } });
  assert.equal(await labels.refresh(), true);
  assert.equal(labels.label({ type: 'key', code: 'KeyQ' }), 'A');
  glyph = 'q';
  await labels.refresh();
  assert.equal(labels.label({ type: 'key', code: 'KeyQ' }), 'Q');
  labels.dispose();
});
test('AZERTY, QWERTZ, unicode, punctuation and chords use native glyphs without changing binding codes', async () => {
  const binding = { type: 'key', code: 'KeyQ', modifiers: ['ctrl', 'shift'] };
  const labels = new KeyboardLabels({
    keyboard: keyboard(
      async () =>
        new Map([
          ['KeyQ', 'a'],
          ['KeyY', 'z'],
          ['Digit2', 'é'],
          ['Semicolon', 'ö'],
          ['Backquote', '`'],
          ['Space', ' '],
        ]),
    ),
  });
  assert.equal(await labels.refresh(), true);
  assert.equal(labels.available, true);
  assert.equal(labels.label(binding), 'Ctrl+Shift+A');
  assert.equal(binding.code, 'KeyQ');
  for (const [code, expected] of [
    ['KeyY', 'Z'],
    ['Digit2', 'é'],
    ['Semicolon', 'ö'],
    ['Backquote', '`'],
    ['Space', 'Space'],
    ['ArrowUp', 'Up'],
  ])
    assert.equal(labels.label({ type: 'key', code }), expected);
  assert.equal(labels.label({ type: 'gamepad-button', index: 0 }, 'playstation'), 'Cross');
  labels.dispose();
  assert.equal(layoutBindingLabel(binding, new Map([['KeyQ', '\u0000']])), 'Ctrl+Shift+Q');
});
test('unsupported and expected permission denials fall back; unexpected errors remain observable', async () => {
  const absent = new KeyboardLabels({ keyboard: null });
  assert.equal(await absent.refresh(), false);
  assert.equal(absent.label({ type: 'key', code: 'KeyW' }), 'W');
  absent.dispose();
  for (const name of ['SecurityError', 'NotAllowedError', 'NotSupportedError']) {
    const labels = new KeyboardLabels({
      keyboard: keyboard(async () => {
        throw new DOMException('policy', name);
      }),
    });
    assert.equal(await labels.refresh(), false);
    assert.equal(labels.available, false);
    assert.equal(labels.lastError, null);
    labels.dispose();
  }
  const error = new TypeError('bad browser integration'),
    source = keyboard(async () => {
      throw error;
    }),
    labels = new KeyboardLabels({ keyboard: source });
  await assert.rejects(labels.refresh(), error);
  assert.equal(labels.lastError, error);
  const failed = new Promise((resolve) => labels.addEventListener('error', resolve, { once: true }));
  source.dispatchEvent(new Event('layoutchange'));
  await failed;
  assert.equal(labels.lastError, error);
  labels.dispose();
});
test('layoutchange refreshes labels and older asynchronous results cannot overwrite newer layouts', async () => {
  const requests = [],
    source = keyboard(() => new Promise((resolve) => requests.push(resolve))),
    labels = new KeyboardLabels({ keyboard: source });
  const first = labels.refresh(),
    second = labels.refresh();
  await Promise.resolve();
  await Promise.resolve();
  requests[1](new Map([['KeyQ', 'a']]));
  assert.equal(await second, true);
  requests[0](new Map([['KeyQ', 'q']]));
  assert.equal(await first, false);
  assert.equal(labels.label({ type: 'key', code: 'KeyQ' }), 'A');
  const changed = new Promise((resolve) => labels.addEventListener('change', resolve, { once: true }));
  source.dispatchEvent(new Event('layoutchange'));
  await Promise.resolve();
  await Promise.resolve();
  requests[2](new Map([['KeyQ', 'x']]));
  await changed;
  assert.equal(labels.label({ type: 'key', code: 'KeyQ' }), 'X');
  labels.dispose();
});
test('abort, timeout, disposal and invalid source data never publish a late map', async () => {
  let resolve;
  const labels = new KeyboardLabels({
    keyboard: keyboard(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
    timeout: 50,
  });
  const controller = new AbortController(),
    pending = labels.refresh({ signal: controller.signal });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  resolve(new Map([['KeyQ', 'x']]));
  await Promise.resolve();
  assert.equal(labels.available, false);
  const bounded = labels.refresh();
  await assert.rejects(bounded, { name: 'TimeoutError' });
  const disposed = labels.refresh();
  labels.dispose();
  await assert.rejects(disposed, { code: 'disposed' });
  assert.throws(() => labels.label({ type: 'key', code: 'KeyQ' }), { code: 'disposed' });
  labels[Symbol.dispose]();
  const malformed = new KeyboardLabels({ keyboard: keyboard(async () => new Map([['KeyQ', 3]])) });
  await assert.rejects(malformed.refresh(), TypeError);
  malformed.dispose();
  for (const timeout of [0, -1, NaN, Infinity]) assert.throws(() => new KeyboardLabels({ timeout }), RangeError);
});
