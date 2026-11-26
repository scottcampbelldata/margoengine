// AssetQueue and AssetRegistry: ordering, concurrency, retry, progress, cancellation, swaps and the missing-key callback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetQueue, AssetRegistry } from '../dist/assets.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const response = (body, ok = true, status = 200) => ({
  ok,
  status,
  headers: { get: () => null },
  body: null,
  text: async () => body,
  json: async () => JSON.parse(body),
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  blob: async () => body,
});

test('tasks run with the concurrency limit, report success per task and one finish event', async () => {
  const queue = new AssetQueue({ concurrency: 2 });
  let running = 0,
    peak = 0;
  const log = [];
  for (const name of ['a', 'b', 'c', 'd'])
    queue.add(
      name,
      async () => {
        peak = Math.max(peak, ++running);
        await tick();
        running--;
        return name.toUpperCase();
      },
      { onSuccess: (value) => log.push(value) },
    );
  const events = [];
  queue.on('finish', (r) => events.push(r.ok));
  const progress = [];
  queue.on('progress', (p) => progress.push(p.fraction));
  const result = await queue.run();
  assert.equal(peak, 2);
  assert.deepEqual(log.sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual(events, [true]);
  assert.equal(result.done.length, 4);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]));
  assert.equal(queue.tasks[0].value, 'A');
  assert.equal(queue.tasks[0].state, 'done');
});

test('a failing task is retried with backoff, then reported; the rest still finish; retryFailed runs it again', async () => {
  const queue = new AssetQueue({ retries: 2, retryDelay: 1 });
  let flaky = 0,
    broken = 0,
    healed = false;
  queue.add('flaky', async ({ attempt }) => (++flaky < 3 ? Promise.reject(new Error('later')) : `ok on ${attempt}`));
  queue.add('broken', async () => (++broken, healed ? 'fixed' : Promise.reject(new Error('nope'))), { retries: 0 });
  const errors = [];
  queue.on('error', (task) => errors.push(task.name));
  const result = await queue.run();
  assert.equal(queue.tasks[0].value, 'ok on 3');
  assert.equal(queue.tasks[0].attempts, 3);
  assert.deepEqual(errors, ['broken']);
  assert.equal(result.ok, false);
  assert.equal(result.failed[0].error.message, 'nope');
  assert.equal(broken, 1);
  healed = true;
  const again = await queue.retryFailed();
  assert.equal(again.ok, true);
  assert.equal(queue.tasks[1].value, 'fixed');
});

test('abort cancels running and pending tasks and passes the signal to the loader', async () => {
  const queue = new AssetQueue({ concurrency: 1 });
  let seen;
  queue.add('slow', ({ signal }) => {
    seen = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  });
  queue.add('never', async () => 1);
  const controller = new AbortController();
  const run = queue.run(controller.signal);
  await tick();
  controller.abort(new Error('stop'));
  const result = await run;
  assert.ok(seen.aborted);
  assert.deepEqual(result.cancelled.map((t) => t.name), ['slow', 'never']);
  assert.equal(result.ok, false);
});

test('fetch helpers read text, JSON and bytes, and an HTTP error fails the task', async () => {
  const files = { '/a.txt': 'hello', '/b.json': '{"n":2}', '/c.bin': 'xyz' };
  const queue = new AssetQueue({ fetch: async (url) => (files[url] ? response(files[url]) : response('', false, 404)) });
  queue.addText('text', '/a.txt');
  queue.addJSON('json', '/b.json');
  queue.addBinary('bin', '/c.bin');
  queue.addText('missing', '/nope');
  const result = await queue.run();
  assert.deepEqual(queue.tasks.slice(0, 3).map((t) => t.value instanceof Uint8Array ? [...t.value] : t.value), ['hello', { n: 2 }, [120, 121, 122]]);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error.message, /HTTP 404/);
});

test('queue input is validated', () => {
  assert.throws(() => new AssetQueue({ concurrency: 0 }), /concurrency/);
  assert.throws(() => new AssetQueue({ retries: -1 }), /retries/);
  const queue = new AssetQueue();
  queue.add('x', async () => 1);
  assert.throws(() => queue.add('x', async () => 2), /unique/);
  assert.throws(() => queue.add('', async () => 2), /name/);
  assert.throws(() => queue.add('y', 'not a function'), /load function/);
  const running = queue.run();
  assert.throws(() => queue.add('z', async () => 1), /running/);
  return running;
});

test('registry: define, load once, share the load, JSON map in and out', async () => {
  let loads = 0;
  const registry = new AssetRegistry({ loadURL: async (url, type) => (loads++, `${type ?? 'bytes'}:${url}`) });
  registry.fromJSON({ logo: '/logo.png', config: { url: '/config.json', type: 'json' } });
  assert.deepEqual(registry.toJSON(), { logo: '/logo.png', config: { url: '/config.json', type: 'json' } });
  const [a, b] = await Promise.all([registry.load('logo'), registry.load('logo')]);
  assert.equal(a, 'bytes:/logo.png');
  assert.equal(b, a);
  assert.equal(loads, 1);
  assert.equal(registry.get('config'), undefined);
  assert.equal(await registry.load('config'), 'json:/config.json');
  assert.throws(() => registry.define('logo', '/x'), /already defined/);
  registry.define('made', async (key) => `made ${key}`);
  assert.equal(await registry.load('made'), 'made made');
  assert.deepEqual(registry.toJSON().made, undefined);
});

test('registry: swap replaces a loaded value, disposes the old one and tells subscribers', async () => {
  const disposed = [];
  const registry = new AssetRegistry({ loadURL: async (url) => url, dispose: (value, key) => disposed.push([value, key]) });
  registry.define('skin', '/skin-a.png');
  const seen = [];
  const stop = registry.subscribe('skin', (value) => seen.push(value));
  assert.deepEqual(seen, []);
  await registry.load('skin');
  assert.equal(await registry.swap('skin', '/skin-b.png'), '/skin-b.png');
  assert.deepEqual(seen, ['/skin-a.png', '/skin-b.png']);
  assert.deepEqual(disposed, [['/skin-a.png', 'skin']]);
  stop();
  await registry.swap('skin', '/skin-c.png');
  assert.equal(seen.length, 2);
  assert.equal(registry.get('skin'), '/skin-c.png');
  // Swapping a key nobody loaded or watches defines the new source and loads nothing.
  registry.define('idle', '/idle-a');
  assert.equal(await registry.swap('idle', '/idle-b'), undefined);
  assert.equal(await registry.load('idle'), '/idle-b');
  await assert.rejects(registry.swap('nope', '/x'), /not defined/);
});

test('registry: a swap during a load cancels it and the new source wins', async () => {
  let release;
  const registry = new AssetRegistry({
    loadURL: (url, type, signal) =>
      url === '/slow'
        ? new Promise((resolve, reject) => {
            release = () => resolve('slow value');
            signal.addEventListener('abort', () => reject(signal.reason));
          })
        : Promise.resolve(url),
  });
  registry.define('k', '/slow');
  const first = registry.load('k');
  await tick();
  const second = registry.swap('k', '/fast');
  await second.catch(() => {});
  release?.();
  assert.equal(await registry.load('k'), '/fast');
  await assert.rejects(first);
});

test('registry: onMissing handles an undefined key and a failing one once, or load rejects', async () => {
  const calls = [];
  const registry = new AssetRegistry({
    loadURL: async (url) => {
      if (url === '/gone') throw new Error('404');
      return url;
    },
    onMissing: (key, reason, error) => {
      calls.push([key, reason, error?.message]);
      return key === 'refuse' ? undefined : '/placeholder';
    },
  });
  assert.equal(await registry.load('ghost'), '/placeholder');
  assert.equal(registry.has('ghost'), true);
  registry.define('broken', '/gone');
  assert.equal(await registry.load('broken'), '/placeholder');
  assert.deepEqual(calls, [['ghost', 'undefined', undefined], ['broken', 'failed', '404']]);
  await assert.rejects(registry.load('refuse'), /not defined/);
  registry.define('bad-and-bad', '/gone');
  const stubborn = new AssetRegistry({ loadURL: async () => Promise.reject(new Error('always')), onMissing: () => '/also-bad' });
  stubborn.define('x', '/bad');
  await assert.rejects(stubborn.load('x'), /always/);
});

test('registry: remove and dispose release values and block further use', async () => {
  const disposed = [];
  const registry = new AssetRegistry({ loadURL: async (url) => url, dispose: (v) => disposed.push(v) });
  registry.define('a', '/a').define('b', '/b');
  await Promise.all([registry.load('a'), registry.load('b')]);
  assert.equal(registry.remove('a'), true);
  assert.equal(registry.remove('a'), false);
  registry[Symbol.dispose]();
  assert.deepEqual(disposed.sort(), ['/a', '/b']);
  assert.throws(() => registry.define('c', '/c'), /disposed/);
  await assert.rejects(registry.load('b'), /disposed/);
});
