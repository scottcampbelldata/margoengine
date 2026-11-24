// connectVoxelNet's onClose over real sockets: a page sees every way its connection ends, once.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { connectVoxelNet } from '../dist/index.js';
import { VoxelServer } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const blocks = testBlocks(),
  wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function start(t, options = {}) {
  const server = new VoxelServer({ blocks, workers: 1, ...options }),
    { port } = await server.listen(0);
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${port}` };
}
// A client recording its onClose and onError calls; `closed` resolves at the first onClose.
function connect(url, name = 'page') {
  const client = connectVoxelNet(url, new VoxelWorld({ blocks }), { name, view: 2 }),
    closes = [],
    errors = [];
  let ended;
  const closed = new Promise((done) => (ended = done));
  client.onClose = (event) => {
    closes.push(event);
    ended(event);
  };
  client.onError = (error) => errors.push(error);
  return { client, closes, errors, closed };
}
const welcomed = async (client) => {
  const end = performance.now() + 10_000;
  while (!client.welcome) {
    assert.ok(performance.now() < end, 'no welcome within 10 s');
    await wait(10);
  }
};

test('a clean server shutdown reaches onClose as 1001 with its reason, and no onError', async (t) => {
  const { server, url } = await start(t),
    page = connect(url);
  await welcomed(page.client);
  await server.close();
  assert.deepEqual(await page.closed, { code: 1001, reason: 'server closing', byClient: false });
  await wait(50);
  assert.equal(page.closes.length, 1, 'exactly once');
  assert.equal(page.errors.length, 0);
});

test('a close the client starts says so, once, even when asked twice', async (t) => {
  const { url } = await start(t),
    page = connect(url);
  await welcomed(page.client);
  page.client.close();
  page.client.close();
  const event = await page.closed;
  assert.equal(event.byClient, true);
  assert.equal(event.code, 1005, 'a close without a status: what WebSocket reports');
  await wait(50);
  assert.equal(page.closes.length, 1);
  assert.equal(page.errors.length, 0);
});

test('a close before the socket opened is the client too', async (t) => {
  const { url } = await start(t),
    page = connect(url);
  page.client.close();
  assert.equal((await page.closed).byClient, true);
  await wait(50);
  assert.equal(page.closes.length, 1);
  assert.equal(page.errors.length, 0);
});

test('a refusal reaches onError first and then onClose, and closing from onError does not claim the close', async (t) => {
  const { url } = await start(t, { authenticate: () => false }),
    page = connect(url),
    order = [];
  page.client.onError = (error) => {
    order.push('error');
    page.errors.push(error);
    page.client.close();
  };
  const onClose = page.client.onClose;
  page.client.onClose = (event) => {
    order.push('close');
    onClose(event);
  };
  assert.deepEqual(await page.closed, { code: 1008, reason: 'not authorized', byClient: false });
  await wait(50);
  assert.deepEqual(order, ['error', 'close']);
  assert.equal(page.errors[0].code, 'failed');
});

// A fake socket here: a throw inside a real socket's event goes to the process, where the test runner fails the test.
test('onClose still comes when an onError handler throws', (t) => {
  const real = globalThis.WebSocket,
    listeners = {};
  t.after(() => {
    globalThis.WebSocket = real;
  });
  globalThis.WebSocket = class {
    readyState = 0;
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
    close() {}
    send() {}
  };
  const client = connectVoxelNet('ws://fake', new VoxelWorld({ blocks })),
    closes = [];
  client.onClose = (event) => closes.push(event);
  client.onError = () => {
    throw new Error('handler broke');
  };
  assert.throws(() => listeners.close({ code: 1006, reason: '' }), /handler broke/);
  assert.deepEqual(closes, [{ code: 1006, reason: '', byClient: false }]);
});

test('a server that is not there, or that drops the connection, is an unclean close with an error', async () => {
  // A port that was free a moment ago: nothing listens on it.
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  const page = connect(`ws://127.0.0.1:${port}`),
    event = await page.closed;
  assert.equal(event.code, 1006);
  assert.equal(event.byClient, false);
  await wait(50);
  assert.equal(page.closes.length, 1);
  assert.equal(page.errors.length, 1);
});
