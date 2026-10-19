// packages/shared/worker-pool.js (JobPool) against a fake Worker whose replies the tests send by hand, so the order of
// events is exact. Real workers run it in packages/voxel/tests/mesher-worker.test.js (VoxelMesher on worker_threads).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobPool } from '../packages/shared/worker-pool.js';

class FakeWorker {
  static created = [];
  constructor() {
    this.received = [];
    this.terminated = false;
    FakeWorker.created.push(this);
  }
  postMessage(message, transfer = []) {
    this.received.push(structuredClone(message, { transfer }));
  }
  reply(data, transfer = []) {
    this.onmessage?.({ data: structuredClone(data, { transfer }) });
  }
  terminate() {
    this.terminated = true;
  }
}
const pool = (size) => {
  FakeWorker.created = [];
  return new JobPool(() => new FakeWorker(), size);
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const isCode = (code, pattern) => (error) =>
  error.name === 'MargoError' && error.code === code && pattern.test(error.message);

test('jobs run lowest priority first, equal priorities in call order, on workers started up to the pool size', async () => {
  const jobs = pool(1),
    order = [];
  const done = [
    ['a', 0],
    ['b', 5],
    ['c', 1],
    ['d', 1],
    ['e', -1],
  ].map(([name, priority]) => jobs.run({ name }, { priority }).then((result) => order.push(result)));
  const [worker] = FakeWorker.created;
  assert.equal(FakeWorker.created.length, 1);
  for (let i = 0; i < 5; i++) {
    worker.reply({ result: worker.received[i].name });
    await tick();
  }
  await Promise.all(done);
  assert.deepEqual(
    worker.received.map((m) => m.name),
    ['a', 'e', 'c', 'd', 'b'],
  );
  assert.deepEqual(order, ['a', 'e', 'c', 'd', 'b']);

  const two = pool(2),
    results = [1, 2, 3].map((value) => two.run({ value }));
  assert.equal(FakeWorker.created.length, 2, 'a third job waits instead of starting a third worker');
  const [w1, w2] = FakeWorker.created;
  w2.reply({ result: 20 });
  assert.equal(w2.received.length, 2, 'the first free worker takes the queued job');
  w1.reply({ result: 10 });
  w2.reply({ result: 30 });
  assert.deepEqual(await Promise.all(results), [10, 20, 30]);
  jobs.dispose();
  two.dispose();
});

test('a message function runs when a worker takes the job; undefined resolves without posting', async () => {
  const jobs = pool(1),
    calls = [];
  const first = jobs.run({ n: 1 });
  const second = jobs.run(() => (calls.push('second'), { n: 2 }));
  const skipped = jobs.run(() => (calls.push('skipped'), undefined), { priority: -1 });
  assert.deepEqual(calls, [], 'queued jobs have not built their messages');
  const [worker] = FakeWorker.created;
  worker.reply({ result: 1 });
  assert.deepEqual(calls, ['skipped', 'second']);
  assert.equal(await skipped, undefined);
  assert.deepEqual(
    worker.received.map((m) => m.n),
    [1, 2],
  );
  worker.reply({ result: 2 });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  const thrown = jobs.run(() => {
      throw new RangeError('bad job');
    }),
    after = jobs.run({ n: 3 });
  await assert.rejects(thrown, /bad job/);
  assert.equal(worker.received.at(-1).n, 3, 'the next job still runs');
  worker.reply({ result: 3 });
  assert.equal(await after, 3);
  jobs.dispose();
});

test('buffers move to the worker without copies and come back the same way', async () => {
  const jobs = pool(1),
    words = new Uint32Array([1, 2, 3]),
    result = jobs.run({ input: { words }, nested: [new Uint8Array(4)] });
  assert.equal(words.byteLength, 0, 'the posted buffer is detached here');
  const [worker] = FakeWorker.created,
    { input } = worker.received[0];
  assert.deepEqual([...input.words], [1, 2, 3]);
  const reply = new Uint32Array([7, 8]);
  worker.reply({ result: reply }, [reply.buffer]);
  assert.deepEqual([...(await result)], [7, 8]);
  jobs.dispose();
});

test('cancel: a queued job leaves the queue; a running job rejects at once and its late reply is dropped', async () => {
  const jobs = pool(1),
    running = new AbortController(),
    queued = new AbortController();
  const a = jobs.run({ name: 'a' }, { signal: running.signal });
  const b = jobs.run({ name: 'b' }, { signal: queued.signal });
  const c = jobs.run({ name: 'c' });
  queued.abort(new Error('b cancelled'));
  await assert.rejects(b, /b cancelled/);
  running.abort(new Error('a cancelled'));
  await assert.rejects(a, /a cancelled/);
  const [worker] = FakeWorker.created;
  assert.equal(worker.received.length, 1, 'the cancelled job still holds its worker until the reply');
  worker.reply({ result: 'a' }); // late: dropped
  assert.deepEqual(
    worker.received.map((m) => m.name),
    ['a', 'c'],
    'b never reached the worker',
  );
  worker.reply({ result: 'c' });
  assert.equal(await c, 'c');
  const late = new AbortController();
  late.abort(new Error('already'));
  await assert.rejects(jobs.run({}, { signal: late.signal }), /already/);
  jobs.dispose();
});

test('timeout: the worker is terminated, the job rejects and a fresh worker takes the queue', async () => {
  const jobs = pool(1),
    stuck = jobs.run({ name: 'stuck' }, { timeout: 20 }),
    next = jobs.run({ name: 'next' }, { timeout: 1000 });
  await assert.rejects(stuck, isCode('failed', /timed out after 20 ms/));
  const [old, fresh] = FakeWorker.created;
  assert.equal(old.terminated, true);
  assert.deepEqual(
    fresh.received.map((m) => m.name),
    ['next'],
  );
  fresh.reply({ result: 'ok' });
  assert.equal(await next, 'ok');
  jobs.dispose();
});

test('a crash rejects only the running job; the queue continues on a restarted worker; error replies keep their class', async () => {
  const jobs = pool(1),
    a = jobs.run({ name: 'a' }),
    b = jobs.run({ name: 'b' });
  let prevented = false;
  FakeWorker.created[0].onerror({ message: 'boom', preventDefault: () => (prevented = true) });
  await assert.rejects(a, isCode('failed', /Worker failed: boom/));
  assert.ok(prevented && FakeWorker.created[0].terminated);
  const fresh = FakeWorker.created[1];
  assert.deepEqual(
    fresh.received.map((m) => m.name),
    ['b'],
  );
  fresh.reply({ error: { name: 'RangeError', message: 'too big' } });
  await assert.rejects(b, (error) => error instanceof RangeError && error.message === 'too big');
  const c = jobs.run({});
  fresh.onmessageerror();
  await assert.rejects(c, isCode('failed', /could not be deserialized/));
  const d = jobs.run({});
  FakeWorker.created.at(-1).reply(42);
  await assert.rejects(d, TypeError);
  jobs.dispose();
});

test('dispose rejects queued and running jobs, terminates the workers and refuses new jobs', async () => {
  const jobs = pool(2),
    pending = [1, 2, 3].map((value) => jobs.run({ value }));
  jobs.dispose();
  for (const job of pending) await assert.rejects(job, isCode('disposed', /disposed/));
  assert.ok(FakeWorker.created.every((worker) => worker.terminated));
  await assert.rejects(jobs.run({}), isCode('disposed', /create a new pool/));
  assert.throws(() => new JobPool(() => new FakeWorker(), 0), RangeError);
});
