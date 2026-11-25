import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_STARTUP_ERROR, waitsForReady, watchStartupErrors } from '../scripts/support/page-startup.js';

// KB-C34i (2026-11-11): shadows scale-browser.mjs waited its whole 120 s for window.ready after the page had thrown
// "WebGPU adapter unavailable" from engine.create. A wait on window.ready now ends at once on such an error.
function fakePage() {
  const listeners = {},
    frame = {};
  const page = {
    ready: false,
    on(event, callback) {
      (listeners[event] ??= []).push(callback);
    },
    emit(event, value) {
      for (const callback of listeners[event] ?? []) callback(value);
    },
    mainFrame: () => frame,
    frame,
    async evaluate() {
      return page.ready;
    },
    // Never settles on its own before its timeout, like a page that never becomes ready.
    waitForFunction(_predicate, _arg, { timeout = 30_000 } = {}) {
      return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout ${timeout}ms exceeded.`)), timeout).unref(),
      );
    },
  };
  return page;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a wait on window.ready fails at once on an uncaught error thrown before the page was ready, naming it', async () => {
  const page = fakePage();
  watchStartupErrors(page);
  const t0 = performance.now(),
    waiting = page.waitForFunction(() => window.ready, null, { timeout: 120_000 });
  page.emit('pageerror', new Error('WebGPU adapter unavailable'));
  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, PAGE_STARTUP_ERROR);
    assert.match(error.message, /threw before it set window\.ready: WebGPU adapter unavailable/);
    return true;
  });
  // wall-clock: the bound tells "at once" from the 120 s timeout.
  assert.ok(performance.now() - t0 < 10_000);
});

test('an error thrown before the wait began fails the wait too; a new document clears it', async () => {
  const page = fakePage();
  const { errors } = watchStartupErrors(page);
  page.emit('pageerror', new Error('engine.create rejected'));
  await tick();
  await assert.rejects(page.waitForFunction('window.ready'), { code: PAGE_STARTUP_ERROR });
  assert.equal(errors.length, 1);
  page.emit('framenavigated', page.frame);
  const fresh = page.waitForFunction(() => window.ready, null, { timeout: 50 });
  await assert.rejects(fresh, /Timeout 50ms exceeded/);
});

test('a crash before ready fails the wait; errors once ready, and other waits, are left to the suite', async () => {
  const crashed = fakePage();
  watchStartupErrors(crashed);
  const waiting = crashed.waitForFunction(() => window.ready);
  crashed.emit('crash');
  await assert.rejects(waiting, /crashed before it set window\.ready/);

  const ready = fakePage();
  ready.ready = true;
  const { errors } = watchStartupErrors(ready);
  ready.emit('pageerror', new Error('provoked by the suite'));
  await tick();
  assert.equal(errors.length, 0);
  await assert.rejects(
    ready.waitForFunction(() => window.ready, null, { timeout: 50 }),
    /Timeout 50ms/,
  );

  const other = fakePage();
  watchStartupErrors(other);
  other.emit('pageerror', new Error('not about readiness'));
  await tick();
  await assert.rejects(
    other.waitForFunction(() => window.done, null, { timeout: 50 }),
    /Timeout 50ms/,
  );
  assert.equal(
    waitsForReady(() => window.ready),
    true,
  );
  assert.equal(
    waitsForReady(() => window.readyState),
    false,
  );
});
