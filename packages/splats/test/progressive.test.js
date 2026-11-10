import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readSplatsProgressive } from '../dist/progressive.js';
import { parseSplat, parsePly, parseSpz } from '../dist/data.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
async function* packets(bytes, step) {
  for (let i = 0; i < bytes.length; i += step) yield bytes.subarray(i, i + step);
}
const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const sorted = (data) =>
  Array.from({ length: data.positions.length / 3 }, (_, i) => [
    ...data.positions.subarray(i * 3, i * 3 + 3),
    ...data.colors.subarray(i * 4, i * 4 + 4),
    ...data.covariances.subarray(i * 6, i * 6 + 6),
    ...(data.sphericalHarmonics?.subarray(
      (i * data.sphericalHarmonics.length) / (data.positions.length / 3),
      ((i + 1) * data.sphericalHarmonics.length) / (data.positions.length / 3),
    ) ?? []),
  ]).sort(compare);
for (const [format, name, parse] of [
  ['splat', 'raccoon-v2.splat', parseSplat],
  ['ply', 'raccoon-v2.ply', parsePly],
  ['spz', 'raccoon-v2.spz', parseSpz],
  ['spz', 'raccoon-v3.spz', parseSpz],
  ['spz', 'raccoon-v4.spz', parseSpz],
]) {
  test(`stream ${name} preserves every attribute and emits before EOF`, { timeout: 30000 }, async () => {
    const bytes = fixture(name),
      expected = await parse(bytes),
      total = expected.positions.length / 3;
    let consumed = 0;
    const output = [];
    async function* stream() {
      for await (const chunk of packets(bytes, 4093)) {
        consumed += chunk.length;
        yield chunk;
      }
    }
    let early = false;
    for await (const batch of readSplatsProgressive(stream(), { format, count: total, batchSize: 257 })) {
      if (consumed < bytes.length) early = true;
      assert.equal(batch.total, total);
      if (format === 'spz' && batch.first === 0 && batch.data.positions.length === expected.positions.length) {
        output.length = 0;
        output.push(...sorted(batch.data));
      } else output.push(...sorted(batch.data));
    }
    assert.ok(early, 'complete records emitted while network data is still pending');
    assert.deepEqual(output.sort(compare), sorted(expected));
  });
}
test('coarse records first, incomplete rows buffered, truncation rejected', async () => {
  const bytes = fixture('raccoon-v2.splat').subarray(0, 96).slice();
  const v = new DataView(bytes.buffer);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) v.setFloat32(i * 32 + 12 + j * 4, i + 1, true);
  const out = [];
  for await (const b of readSplatsProgressive(packets(bytes, 96), { format: 'splat', count: 3 })) out.push(b);
  assert.deepEqual([...out[0].data.positions.subarray(0, 3)], [...parseSplat(bytes).positions.subarray(6, 9)]);
  await assert.rejects(async () => {
    for await (const b of readSplatsProgressive(packets(bytes.subarray(0, 95), 13), { format: 'splat', count: 3 }))
      void b;
  }, /truncated/);
});
test('gzip checksum errors surface after preview, cancellation cancels pending reader', async () => {
  const bytes = gzipSync(gunzipSync(fixture('raccoon-v2.spz')));
  bytes[bytes.length - 8] ^= 1;
  await assert.rejects(async () => {
    for await (const b of readSplatsProgressive(packets(bytes, 4096), { format: 'spz' })) void b;
  });
  const abort = new AbortController();
  let cancelled = false;
  const source = new ReadableStream({
    pull() {
      abort.abort(new Error('cancelled'));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(async () => {
    for await (const b of readSplatsProgressive(source, { format: 'splat', count: 1, signal: abort.signal })) void b;
  }, /cancelled/);
  assert.ok(cancelled);
});
test('ASCII PLY split numeric tokens and final row without newline', async () => {
  const fields = [
    'x',
    'y',
    'z',
    'f_dc_0',
    'f_dc_1',
    'f_dc_2',
    'opacity',
    'scale_0',
    'scale_1',
    'scale_2',
    'rot_0',
    'rot_1',
    'rot_2',
    'rot_3',
  ];
  const bytes = new TextEncoder().encode(
    `ply\r\nformat ascii 1.0\r\nelement vertex 2\r\n${fields.map((f) => `property float ${f}\r\n`).join('')}end_header\r\n0.125 0 0 1 0 0 3 -2 -2 -2 1 0 0 0\n2.25 0 0 0 1 0 3 -1 -1 -1 1 0 0 0`,
  );
  const all = [];
  for await (const b of readSplatsProgressive(packets(bytes, 1), { format: 'ply' })) all.push(...sorted(b.data));
  assert.deepEqual(all.sort(compare), sorted(parsePly(bytes)));
});

for (const stalledCleanup of [false, true])
  test(`abort rejects a pending async iterable read (stalled cleanup ${stalledCleanup})`, {
    timeout: 10000,
  }, async () => {
    const controller = new AbortController(),
      reason = new Error('cancelled iterable');
    let announce,
      finishRead,
      finishClose,
      finished = false,
      closed = 0;
    const started = new Promise((resolve) => {
      announce = resolve;
    });
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            announce();
            return new Promise((resolve) => {
              finishRead = resolve;
            });
          },
          async return() {
            closed++;
            if (stalledCleanup)
              await new Promise((resolve) => {
                finishClose = resolve;
              });
            return { done: true };
          },
        };
      },
    };
    const iterator = readSplatsProgressive(source, { format: 'splat', count: 1, signal: controller.signal });
    const pending = iterator.next().then(
      () => {
        assert.fail('cancelled read resolved');
      },
      (error) => {
        assert.equal(error, reason);
        finished = true;
      },
    );
    await started;
    controller.abort(reason);
    // An event-loop turn drains promise reactions without waiting for source IO or measuring a time budget.
    await new Promise(setImmediate);
    const rejectedOnAbort = finished,
      closedOnAbort = closed;
    finishRead({ done: true });
    finishClose?.();
    await pending;
    assert.ok(rejectedOnAbort, 'abort must reject before source IO finishes');
    assert.equal(closedOnAbort, 1, 'abort must request iterator cleanup');
  });

test('abort releases a pending stream reader while underlying cancellation is pending', {
  timeout: 10000,
}, async () => {
  const controller = new AbortController(),
    reason = new Error('cancelled stream');
  let announce,
    finishClose,
    finished = false,
    closed = 0;
  const started = new Promise((resolve) => {
    announce = resolve;
  });
  const source = new ReadableStream({
    pull() {
      announce();
    },
    cancel() {
      closed++;
      return new Promise((resolve) => {
        finishClose = resolve;
      });
    },
  });
  const iterator = readSplatsProgressive(source, { format: 'splat', count: 1, signal: controller.signal });
  const pending = iterator.next().then(
    () => {
      assert.fail('cancelled read resolved');
    },
    (error) => {
      assert.equal(error, reason);
      finished = true;
    },
  );
  await started;
  controller.abort(reason);
  await new Promise(setImmediate);
  const rejectedOnAbort = finished,
    lockedOnAbort = source.locked;
  finishClose();
  await pending;
  assert.ok(rejectedOnAbort, 'abort must reject before underlying cancellation finishes');
  assert.equal(closed, 1);
  assert.equal(lockedOnAbort, false);
});

test('abort between batches stops records already buffered from the same chunk', async () => {
  const controller = new AbortController(),
    reason = new Error('stop buffered records');
  const iterator = readSplatsProgressive(packets(fixture('raccoon-v2.splat').subarray(0, 64), 64), {
    format: 'splat',
    count: 2,
    batchSize: 1,
    signal: controller.signal,
  });
  assert.equal((await iterator.next()).value.first, 0);
  controller.abort(reason);
  await assert.rejects(iterator.next(), (error) => error === reason);
});
