// LoadOnce, the app-wide load behind `Physics.load` and `Physics2D.load`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadOnce } from '../packages/shared/load-once.js';

test('calls during a load share it, and a loaded value is kept', async () => {
  let runs = 0;
  const value = {},
    once = new LoadOnce(async () => (runs++, value));
  assert.equal(once.value, null);
  const [a, b] = await Promise.all([once.load(), once.load()]);
  assert.equal(a, value);
  assert.equal(b, value);
  assert.equal(await once.load(), value);
  assert.equal(once.value, value);
  assert.equal(runs, 1);
});

test('a failed load leaves nothing behind, so the next call tries again', async () => {
  let runs = 0;
  const value = {},
    once = new LoadOnce(async () => {
      if (++runs === 1) throw new Error('offline');
      return value;
    });
  await assert.rejects(once.load(), /offline/);
  assert.equal(once.value, null);
  assert.equal(await once.load(), value);
  assert.equal(runs, 2);
});

test('a signal stops one wait; the load carries on for the others', async () => {
  let finish;
  const value = {},
    once = new LoadOnce(() => new Promise((resolve) => (finish = () => resolve(value)))),
    controller = new AbortController(),
    stopped = once.load(controller.signal),
    other = once.load();
  await Promise.resolve();
  controller.abort();
  await assert.rejects(stopped, { name: 'AbortError' });
  finish();
  assert.equal(await other, value);
  await assert.rejects(once.load(AbortSignal.abort()), { name: 'AbortError' }, 'aborted before the call');
});
