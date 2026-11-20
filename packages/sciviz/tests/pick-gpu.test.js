import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuPicking } from '../dist/pick-gpu.js';
import { readFileSync } from 'node:fs';

const fake = (ready = () => Promise.resolve()) => ({ renderer: { device: {} }, ready });
test('GPU picking is optional, rejects unsupported backends and allocates nothing on construction', () => {
  assert.throws(() => new GpuPicking({ renderer: {} }), /WebGPU/);
  const pick = new GpuPicking(fake());
  pick.dispose();
  pick[Symbol.dispose]();
  assert.throws(
    () => pick.attachHover(),
    (error) => error.code === 'disposed',
  );
});
test('GPU query validates every bound before touching GPU state', async () => {
  using pick = new GpuPicking(fake());
  for (const options of [
    { radius: -1 },
    { radius: Infinity },
    { opacityThreshold: 0 },
    { opacityThreshold: 1.1 },
    { timeout: 0 },
    { timeout: NaN },
  ])
    await assert.rejects(pick.pick(1, 2, options), /finite coordinates/);
  await assert.rejects(pick.pick(NaN, 2), /finite coordinates/);
});
test('a deadline above the largest host timer rejects as a coded range error instead of firing early or throwing', async () => {
  using pick = new GpuPicking(fake(() => new Promise(() => {})));
  for (const timeout of [2 ** 31, 2 ** 32, 2 ** 53, 1e300]) {
    let result;
    assert.doesNotThrow(() => (result = pick.pick(1, 2, { timeout })));
    await assert.rejects(result, (error) => error instanceof RangeError && /timeout in \(0, 2147483647\]/.test(error.message));
  }
  // The largest accepted deadline is still pending (not fired early) when the picker is disposed.
  const longest = pick.pick(1, 2, { timeout: 2 ** 31 - 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  pick.dispose();
  await assert.rejects(longest, /Create a new GpuPicking/);
});
test('cancellation, deadlines and disposal settle queued requests even while figure ready is unresolved', async () => {
  const pick = new GpuPicking(fake(() => new Promise(() => {})));
  const reason = new Error('cancelled request'),
    abort = new AbortController();
  const a = pick.pick(1, 2, { signal: abort.signal });
  const b = pick.pick(3, 4, { timeout: 20 });
  abort.abort(reason);
  await assert.rejects(a, (error) => error === reason);
  await assert.rejects(b, (error) => error.name === 'TimeoutError');
  const c = pick.pick(1, 2);
  pick.dispose();
  await assert.rejects(c, /Create a new GpuPicking/);
  await assert.rejects(pick.pick(1, 2), /Create a new GpuPicking/);
});
test('hover installer restores CPU picking and never calls the CPU picker itself', () => {
  let handler,
    removals = 0;
  using pick = new GpuPicking({
    ...fake(),
    setHoverPicker(h) {
      handler = h;
      return () => {
        removals++;
      };
    },
  });
  const stop = pick.attachHover();
  assert.equal(typeof handler, 'function');
  stop();
  pick.attachHover();
  assert.equal(removals, 2);
});
test('ID shaders keep full integer indices and pick inputs never project items on the CPU', () => {
  const source = readFileSync(new URL('../src/pick-gpu.ts', import.meta.url), 'utf8');
  assert.match(source, /format:\s*'rgba32uint'/);
  assert.match(source, /bytesPerRow:\s*256/);
  assert.doesNotMatch(source, /projectPoint|nearestPoint|for\s*\([^)]*index/);
});
