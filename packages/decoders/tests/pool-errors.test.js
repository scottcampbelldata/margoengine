// A decoder worker reports a failure as a message and a code; the pool rebuilds the error the caller sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerPool } from '../dist/pool.js';

/** A worker that answers each job with the error the job names. */
const failing = () => {
  const worker = {
    postMessage: ({ id, code }) =>
      queueMicrotask(() => worker.onmessage({ data: { id, error: 'no picture', ...(code && { code }) } })),
    terminate: () => {},
  };
  return worker;
};

test('a worker failure keeps its code', async () => {
  const pool = new WorkerPool(1, failing);
  const rejection = (code) => pool.run({ code }, []).then(assert.fail, (error) => error);
  // 'unsupported' once arrived as a plain Error with no code (an AVIF with an unsupported item, through AVIFDecoder).
  for (const code of ['failed', 'unsupported']) {
    const error = await rejection(code);
    assert.deepEqual([error.name, error.code, error.message], ['MargoError', code, 'no picture']);
  }
  assert.ok((await rejection('range')) instanceof RangeError);
  const plain = await rejection(undefined);
  assert.deepEqual([plain.name, plain.code], ['Error', undefined]);
  pool.dispose();
});
