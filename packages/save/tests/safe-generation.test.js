// safeStorage generations are 64-bit: the newest + 1 at 2^64 - 1 used to wrap to 0, so the next read picked the
// older copy, and check() rounded generations above 2^53 - 1 to the nearest double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../../shared/crc32.js';
import { memoryStorage } from '../dist/index.js';
import { safeStorage } from '../dist/safe.js';

const bytes = (value) => new TextEncoder().encode(value);
const text = (value) => new TextDecoder().decode(value);

/** The stored frame with its generation set to `generation` and the CRC-32 made good again. */
function withGeneration(frame, generation) {
  const out = frame.slice(),
    view = new DataView(out.buffer),
    end = out.length - 4;
  view.setBigUint64(12, generation);
  view.setUint32(end, crc32(out.subarray(0, end)), true);
  return out;
}

async function store(generations) {
  const inner = memoryStorage(),
    safe = safeStorage(inner);
  await safe.write('k', bytes('older save'));
  await safe.write('k', bytes('newest save'));
  await inner.write('k~a', withGeneration(await inner.read('k~a'), generations[0]));
  await inner.write('k~b', withGeneration(await inner.read('k~b'), generations[1]));
  return { inner, safe };
}

test('a write at generation 2^64 - 1 throws before any copy changes, and the newest save stands', async () => {
  const top = 2n ** 64n - 1n,
    { inner, safe } = await store([top - 1n, top]),
    before = [await inner.read('k~a'), await inner.read('k~b')];
  await assert.rejects(
    safe.write('k', bytes('one more')),
    (error) => error.name === 'MargoError' && error.code === 'failed' && /generation/.test(error.message),
  );
  assert.deepEqual([await inner.read('k~a'), await inner.read('k~b')], before);
  assert.equal(text(await safe.read('k')), 'newest save');
});

test('generations past 2^53 - 1 still advance exactly, and check() refuses to round them', async () => {
  const big = 2n ** 60n + 1n,
    { safe } = await store([big - 1n, big]);
  await safe.write('k', bytes('next save'));
  assert.equal(text(await safe.read('k')), 'next save');
  await assert.rejects(
    safe.check('k'),
    (error) => error.name === 'MargoError' && error.code === 'failed' && /2\^53/.test(error.message),
  );
  const edge = BigInt(Number.MAX_SAFE_INTEGER),
    { safe: exact } = await store([edge - 1n, edge]);
  assert.deepEqual(await exact.check('k'), { ok: true, good: 2, bad: 0, generation: Number.MAX_SAFE_INTEGER });
});
