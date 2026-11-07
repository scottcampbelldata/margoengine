import test from 'node:test';
import assert from 'node:assert/strict';
import { CloseCode, GameClient, GameServer } from '../dist/index.js';
import { acceptWebTransport, openWebTransport, webTransportConnection } from '../dist/webtransport.js';
import { game } from './arena.js';

// Stand-in for a browser's WebTransport and an HTTP/3 server's session: the W3C shape over in-memory streams. The real
// thing is proved by tests/webtransport-proof (Chrome against an outside HTTP/3 server).
function pipe() {
  const { readable, writable } = new TransformStream();
  return { readable, writable };
}
function pair({ maxDatagramSize = 1200, queue = 16, legacy = false } = {}) {
  const to = { d: pipe(), s: [] },
    from = { d: pipe(), s: [] };
  const incoming = [new TransformStream(undefined, undefined, { highWaterMark: 4 }), new TransformStream()];
  const make = (send, receive, incomingOut, incomingIn) => {
    let closed;
    const session = {
      sent: [],
      ready: Promise.resolve(),
      closed: new Promise((resolve) => (closed = resolve)),
      peer: null,
      close(info = {}) {
        session.closeInfo = info;
        closed(info);
        session.peer?.end(info);
      },
      end: (info) => closed(info),
      datagrams: {
        readable: receive.d.readable,
        maxDatagramSize,
        ...(legacy
          ? { writable: send.d.writable }
          : {
              createWritable: () =>
                new WritableStream(
                  {
                    async write(chunk) {
                      session.sent.push(chunk);
                      const writer = send.d.writable.getWriter();
                      await writer.write(chunk);
                      writer.releaseLock();
                    },
                  },
                  new CountQueuingStrategy({ highWaterMark: queue }),
                ),
            }),
      },
      async createBidirectionalStream() {
        const up = pipe(),
          down = pipe(),
          writer = incomingOut.writable.getWriter();
        await writer.write({ readable: up.readable, writable: down.writable });
        writer.releaseLock();
        return { readable: down.readable, writable: up.writable };
      },
      incomingBidirectionalStreams: incomingIn.readable,
    };
    return session;
  };
  const client = make(to, from, incoming[0], incoming[1]),
    server = make(from, to, incoming[1], incoming[0]);
  client.peer = server;
  server.peer = client;
  return { client, server };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const open = async (options) => {
  const { client, server } = pair(options),
    Class = function () {
      return client;
    },
    near = await openWebTransport('https://game.test/play', { WebTransport: Class }),
    far = await acceptWebTransport(server);
  return { near, far, client, server };
};
const collect = (connection) => {
  const got = [];
  connection.onmessage = (data, channel) => got.push([channel, [...data]]);
  return got;
};

test('webtransport: reliable goes on the stream in order, unreliable as datagrams', async () => {
  const { near, far, client } = await open();
  const got = collect(far),
    back = collect(near);
  near.send(new Uint8Array([1, 2]), 'reliable');
  near.send(new Uint8Array([3]));
  near.send(new Uint8Array([9]), 'unreliable');
  far.send(new Uint8Array([7]), 'unreliable');
  far.send(new Uint8Array([]), 'reliable');
  await settle();
  assert.deepEqual(got.filter(([c]) => c === 'reliable').map(([, d]) => d), [[1, 2], [3]]);
  assert.deepEqual(got.filter(([c]) => c === 'unreliable').map(([, d]) => d), [[9]]);
  assert.deepEqual(back.sort(), [['reliable', []], ['unreliable', [7]]]);
  assert.equal(client.sent.length, 1, 'only the unreliable message went as a datagram');
});

test('webtransport: frames split across reads and joined in one read come out whole', async () => {
  const up = pipe(),
    down = pipe(),
    session = pair().client,
    connection = webTransportConnection(session, { readable: up.readable, writable: down.writable }),
    got = collect(connection),
    writer = up.writable.getWriter();
  const frame = (bytes) => [bytes.length, 0, 0, 0, ...bytes];
  const stream = new Uint8Array([...frame([1, 2, 3]), ...frame([4]), ...frame([5, 6])]);
  for (const cut of [[0, 1], [1, 5], [5, 9], [9, stream.length]]) {
    await writer.write(stream.subarray(...cut));
    await settle();
  }
  assert.deepEqual(got.map(([, d]) => d), [[1, 2, 3], [4], [5, 6]]);
});

test('webtransport: a message too big for a datagram goes on the stream, not into silence', async () => {
  const { near, far, client } = await open({ maxDatagramSize: 8 });
  const got = collect(far);
  near.send(new Uint8Array(8).fill(1), 'unreliable');
  near.send(new Uint8Array(9).fill(2), 'unreliable');
  await settle();
  assert.equal(client.sent.length, 1);
  assert.equal(got.length, 2);
  assert.deepEqual(got.find(([, d]) => d[0] === 2)[0], 'reliable');
});

test('webtransport: unreliable messages are dropped while the link is behind, reliable ones never', async () => {
  let release;
  const hold = new Promise((resolve) => (release = resolve)),
    session = pair().client,
    writes = [],
    sink = () => new WritableStream({ write: (chunk) => (writes.push(chunk), hold) }, new CountQueuingStrategy({ highWaterMark: 2 }));
  session.datagrams.createWritable = sink;
  const connection = webTransportConnection(session, { readable: pipe().readable, writable: pipe().writable });
  for (let i = 0; i < 10; i++) connection.send(new Uint8Array([i]), 'unreliable');
  release();
  await settle();
  assert.deepEqual(writes.map((w) => w[0]), [0, 1], 'the queue holds 2; the rest are stale by the time they could go');

  // A message too big for a datagram waits on the stream only while the stream is not behind.
  let open;
  const stuck = new Promise((resolve) => (open = resolve)),
    lines = [],
    slow = new WritableStream({ write: (chunk) => (lines.push(chunk.length), stuck) }),
    big = webTransportConnection(pair({ maxDatagramSize: 4 }).client, { readable: pipe().readable, writable: slow }, { dropUnreliableAbove: 50 });
  big.send(new Uint8Array(100), 'reliable');
  big.send(new Uint8Array(100), 'unreliable');
  big.send(new Uint8Array(30), 'reliable');
  open();
  await settle();
  assert.deepEqual(lines, [104, 34], 'the oversized unreliable one was dropped, both reliable ones went');
});

test('webtransport: the close code and reason reach the other end, once, from either side', async () => {
  const { near, far, client } = await open();
  const closes = [];
  near.onclose = (code, reason) => closes.push(['near', code, reason]);
  far.onclose = (code, reason) => closes.push(['far', code, reason]);
  far.close(CloseCode.full, 'server full');
  far.close(CloseCode.protocol, 'again');
  await settle();
  assert.deepEqual(closes.sort(), [
    ['far', CloseCode.full, 'server full'],
    ['near', CloseCode.full, 'server full'],
  ]);
  assert.equal(near.open, false);
  near.send(new Uint8Array(1));
  near.close();
  assert.equal(client.closeInfo, undefined, 'closing twice does nothing');
});

test('webtransport: a reason over 1,024 bytes is cut on a character boundary', async () => {
  const { near, client } = await open();
  near.close(CloseCode.normal, 'é'.repeat(600));
  assert.equal(new TextEncoder().encode(client.closeInfo.reason).length, 1024);
});

test('webtransport: a session that fails closes the connection with what it says', async () => {
  let fail;
  const session = { ...pair().client, closed: new Promise((_, reject) => (fail = reject)) },
    connection = webTransportConnection(session, pipe()),
    closes = [];
  connection.onclose = (code, reason) => closes.push([code, reason]);
  fail(new Error('network lost'));
  await settle();
  assert.deepEqual(closes, [[CloseCode.timeout, 'network lost']]);
});

test('webtransport: a length past the limit closes the connection instead of waiting for it', async () => {
  const up = pipe(),
    session = pair().client,
    connection = webTransportConnection(session, { readable: up.readable, writable: pipe().writable }, { maxMessageBytes: 16 }),
    closes = [];
  connection.onclose = (code) => closes.push(code);
  await up.writable.getWriter().write(new Uint8Array([255, 255, 255, 255]));
  await settle();
  assert.deepEqual(closes, [CloseCode.rateLimit]);
});

test('webtransport: opening says what went wrong; a signal aborts', async () => {
  await assert.rejects(openWebTransport('https://x.test/', { WebTransport: undefined }), { code: 'unsupported' });
  const refused = function () {
    return { ready: Promise.reject(new Error('no route')), closed: Promise.reject(new Error('no route')), close() {} };
  };
  await assert.rejects(openWebTransport('https://x.test/', { WebTransport: refused }), { code: 'failed' });
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await assert.rejects(openWebTransport('https://x.test/', { signal: stop.signal }), /stopped/);
  let closed;
  const hanging = function () {
    let fail;
    return {
      ready: new Promise((_, reject) => (fail = reject)),
      closed: new Promise(() => {}),
      close(info) {
        closed = info;
        fail(new Error('closed'));
      },
    };
  };
  const later = new AbortController(),
    opening = openWebTransport('https://x.test/', { WebTransport: hanging, signal: later.signal });
  later.abort(new Error('changed my mind'));
  await assert.rejects(opening, /changed my mind/);
  assert.equal(closed.reason, 'aborted');
  const { server } = pair();
  server.incomingBidirectionalStreams = new ReadableStream({ start: (c) => c.close() });
  await assert.rejects(acceptWebTransport(server), { code: 'failed' });
  assert.throws(() => webTransportConnection({ ...pair().client, datagrams: { readable: pipe().readable } }, pipe()), TypeError);
});

test('webtransport: the older writable property works, and a whole game runs over it', async () => {
  const { near, far } = await open({ legacy: true });
  const server = new GameServer(game);
  server.accept(far);
  const joining = GameClient.join(game, near, { input: () => ({ x: 1, y: 0, boost: false }) });
  const ticks = setInterval(() => server.step(), 5);
  const client = await joining;
  for (let i = 0; i < 40; i++) {
    client.update();
    await settle();
  }
  clearInterval(ticks);
  assert.ok(client.stats.snapshots > 5);
  assert.ok(client.authoritative.boxes.has(client.player));
  client.close();
  server.close();
});
