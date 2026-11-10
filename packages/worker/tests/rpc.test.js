import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { RpcClient, RpcPool, exposeRpc, rpcTransfer } from '../dist/rpc.js';

const pair = (t, handlers) => {
  const { port1, port2 } = new MessageChannel();
  const server = exposeRpc(handlers, port2),
    client = new RpcClient(port1);
  t.after(() => {
    client.dispose();
    server.dispose();
    port1.close();
    port2.close();
  });
  return { client, server, port1, port2 };
};
const worker = () => {
  const raw = new Worker(new URL('./rpc-worker.js', import.meta.url));
  const endpoint = new EventTarget();
  raw.on('message', (data) => endpoint.dispatchEvent(new MessageEvent('message', { data })));
  raw.on('error', () => endpoint.dispatchEvent(new Event('error')));
  endpoint.postMessage = (data, transfer) => raw.postMessage(data, transfer);
  endpoint.terminate = () => raw.terminate();
  return endpoint;
};

test('RPC progress is ordered, channel-isolated, transferable and stops after settlement or abort', {
  timeout: 3000,
}, async (t) => {
  let report;
  const { client, port1 } = pair(t, {
    run({ progress }) {
      report = progress;
      const bytes = new Uint8Array([17]);
      progress(bytes, [bytes.buffer]);
      assert.equal(bytes.byteLength, 0);
      progress('done');
      return 42;
    },
  });
  const other = new RpcClient(port1);
  t.after(() => other.dispose());
  const events = [],
    unrelated = [];
  assert.equal(await client.call('run', [], { onProgress: (value) => events.push(value) }), 42);
  assert.deepEqual(events, [new Uint8Array([17]), 'done']);
  report('late');
  await other.call('run', [], { onProgress: (value) => unrelated.push(value) });
  assert.equal(events.length, 2);
  assert.equal(unrelated.length, 2);
  await assert.rejects(
    client.call('run', [], {
      onProgress: () => {
        throw new Error('observer failed');
      },
    }),
    /observer failed/,
  );
  assert.equal(await client.call('run', []), 42, 'observer failure remains local to its call');
});

test('RPC resolves typed-shape calls, preserves this, multiplexes clients and leaves unrelated traffic alone', {
  timeout: 3000,
}, async (t) => {
  const { client, port1, port2 } = pair(t, {
    bias: 4,
    add(a, b) {
      return a + b + this.bias;
    },
  });
  const other = new RpcClient(port1);
  t.after(() => other.dispose());
  assert.deepEqual(await Promise.all([client.call('add', [2, 3]), other.call('add', [7, 8])]), [9, 19]);
  const message = new Promise((resolve) =>
    port1.addEventListener('message', ({ data }) => data.hello && resolve(data), { once: true }),
  );
  port2.postMessage({ hello: true });
  assert.deepEqual(await message, { hello: true });
  await assert.rejects(client.call('toString', []), { code: 'state' });
});

test('structured clone errors, remote errors and transferred results always settle', { timeout: 3000 }, async (t) => {
  const { client } = pair(t, {
    fail() {
      throw Object.assign(new TypeError('bad data'), { code: 'failed' });
    },
    move(buffer) {
      new Uint8Array(buffer)[0]++;
      return rpcTransfer(buffer, [buffer]);
    },
    bad() {
      return () => {};
    },
    primitive() {
      throw undefined;
    },
  });
  await assert.rejects(client.call('fail', []), { name: 'TypeError', message: 'bad data', code: 'failed' });
  await assert.rejects(client.call('bad', []), { name: 'DataCloneError' });
  await assert.rejects(client.call('primitive', []), { name: 'Error', message: 'undefined' });
  await assert.rejects(client.call('move', [() => {}]), { name: 'DataCloneError' });
  const buffer = new Uint8Array([41]).buffer;
  const result = client.call('move', [buffer], { transfer: [buffer] });
  assert.equal(buffer.byteLength, 0);
  assert.equal(new Uint8Array(await result)[0], 42);
});

test('pre-abort leaves inputs attached; running cancellation reaches handler and permits later calls', {
  timeout: 3000,
}, async (t) => {
  const entered = Promise.withResolvers(),
    cancelled = Promise.withResolvers();
  const { client } = pair(t, {
    async wait({ signal }) {
      entered.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      cancelled.resolve();
      return true;
    },
    sum(a, b) {
      return a + b;
    },
  });
  const controller = new AbortController(),
    buffer = new ArrayBuffer(4);
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(
    client.call('wait', [buffer], { signal: controller.signal, transfer: [buffer] }),
    /cancelled by caller/,
  );
  assert.equal(buffer.byteLength, 4);
  const running = new AbortController();
  const promise = client.call('wait', [], { signal: running.signal });
  const rejection = assert.rejects(promise, /stop/);
  await entered.promise;
  running.abort(new Error('stop'));
  await rejection;
  await cancelled.promise;
  assert.equal(await client.call('sum', [20, 22]), 42);
});

test('transport failure, disposal and hard deadline reject every pending call', { timeout: 3000 }, async (t) => {
  const { client, port1 } = pair(t, { wait: () => new Promise(() => {}) });
  const pending = assert.rejects(client.call('wait', []), { code: 'failed' });
  port1.dispatchEvent(new Event('messageerror'));
  await pending;
  assert.equal(client.disposed, true);
  const second = pair(t, { wait: () => new Promise(() => {}) });
  await assert.rejects(second.client.call('wait', [], { timeout: 10 }), { code: 'timeout' });
  assert.equal(second.client.disposed, true);
  const third = pair(t, { wait: () => new Promise(() => {}) });
  const disposed = assert.rejects(third.client.call('wait', []), { code: 'state' });
  third.client.dispose();
  third.client.dispose();
  await disposed;
  for (const timeout of [0, -1, NaN, Infinity]) await assert.rejects(third.client.call('wait', [], { timeout }));
});

test('server disposal aborts handlers and rejects active calls', { timeout: 3000 }, async (t) => {
  const entered = Promise.withResolvers();
  let signal;
  const { client, server } = pair(t, {
    wait(context) {
      signal = context.signal;
      entered.resolve();
      return new Promise(() => {});
    },
  });
  const rejected = assert.rejects(client.call('wait', []), { code: 'state' });
  await entered.promise;
  server.dispose();
  await rejected;
  assert.equal(signal.aborted, true);
});

test('real worker pool executes tasks and moves buffers both ways', { timeout: 10000 }, async (t) => {
  const pool = new RpcPool(worker, { size: 2 });
  t.after(() => pool.dispose());
  assert.equal(pool.size, 2);
  assert.deepEqual(
    await Promise.all(Array.from({ length: 20 }, (_, i) => pool.call('sum', [i, 1]))),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  const buffer = new Uint8Array([8]).buffer;
  const output = await pool.call('buffer', [buffer], { transfer: [buffer] });
  assert.equal(buffer.byteLength, 0);
  assert.equal(new Uint8Array(output)[0], 9);
  await assert.rejects(pool.call('fail', []), { code: 'failed' });
  assert.equal(await pool.call('sum', [40, 2]), 42);
});

test('pool keeps cancelled slot occupied until handler ends; queued abort preserves transfers and FIFO', {
  timeout: 3000,
}, async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    cancelled = Promise.withResolvers();
  let active = 0,
    peak = 0;
  const order = [],
    ports = [];
  const pool = new RpcPool(
    () => {
      const { port1, port2 } = new MessageChannel();
      ports.push(port1, port2);
      const server = exposeRpc(
        {
          async task(id, { signal }) {
            peak = Math.max(peak, ++active);
            order.push(id);
            if (id === 1) {
              signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
              entered.resolve();
              await release.promise;
            }
            active--;
            return id;
          },
        },
        port2,
      );
      port1.terminate = () => {
        server.dispose();
        port1.close();
        port2.close();
      };
      return port1;
    },
    { size: 1, maxQueue: 2 },
  );
  t.after(() => {
    release.resolve();
    pool.dispose();
  });
  const running = new AbortController();
  const first = assert.rejects(pool.call('task', [1], { signal: running.signal }), /stop/);
  await entered.promise;
  running.abort(new Error('stop'));
  await first;
  await cancelled.promise;
  const queued = new AbortController(),
    buffer = new ArrayBuffer(4);
  const dropped = assert.rejects(pool.call('task', [buffer], { signal: queued.signal, transfer: [buffer] }), /drop/);
  const second = pool.call('task', [2]);
  assert.equal(pool.queued, 2);
  await assert.rejects(pool.call('task', [3]), { code: 'state' });
  queued.abort(new Error('drop'));
  await dropped;
  assert.equal(buffer.byteLength, 4);
  assert.deepEqual(order, [1]);
  release.resolve();
  assert.equal(await second, 2);
  assert.equal(peak, 1);
  assert.deepEqual(order, [1, 2]);
});

test('pool validates bounds, cleans up partial factories and settles queued disposal', { timeout: 3000 }, async (t) => {
  for (const options of [{ size: 0 }, { size: 1.5 }, { maxQueue: -1 }])
    assert.throws(() => new RpcPool(worker, options), RangeError);
  let terminated = 0;
  assert.throws(
    () =>
      new RpcPool((index) => {
        if (index) throw new Error('factory failed');
        const endpoint = new EventTarget();
        endpoint.postMessage = () => {};
        endpoint.terminate = () => terminated++;
        return endpoint;
      }),
    /factory failed/,
  );
  assert.equal(terminated, 1);
  const pool = new RpcPool(worker, { size: 1 });
  t.after(() => pool.dispose());
  const running = assert.rejects(pool.call('wait', []), { code: 'state' });
  const queued = assert.rejects(pool.call('sum', [1, 2]), { code: 'state' });
  pool.dispose();
  pool.dispose();
  await Promise.all([running, queued]);
  await assert.rejects(pool.call('sum', [1, 2]), { code: 'state' });
});
