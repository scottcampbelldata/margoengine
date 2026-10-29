import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { CloseCode, GameClient } from '../dist/index.js';
import { openWebSocket } from '../dist/websocket.js';
import { dataChannelConnection } from '../dist/webrtc.js';
import { listenWebSocket, serve } from '../dist/node.js';
import { game } from './arena.js';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

test('a real-time server over WebSocket: two clients join, move and are seen by each other', {
  timeout: 20_000,
}, async (t) => {
  const served = await serve(game, { port: 0 });
  t.after(() => served.close());
  const url = `ws://127.0.0.1:${served.port}`,
    mover = await GameClient.join(game, await openWebSocket(url), { input: () => ({ x: 1, y: 0, boost: false }) }),
    watcher = await GameClient.join(game, await openWebSocket(url), { input: () => ({ x: 0, y: 0, boost: false }) });
  const start = watcher.interpolated().boxes.get(mover.player)?.x ?? Number.NaN;
  const frames = setInterval(() => {
    mover.update();
    watcher.update();
  }, 1000 / 60);
  await wait(1200);
  clearInterval(frames);
  assert.deepEqual(served.server.players.sort(), [mover.player, watcher.player].sort());
  const seen = watcher.interpolated().boxes.get(mover.player).x;
  assert.ok(seen > start + 1, `the watcher saw the mover go from ${start} to ${seen}`);
  assert.ok(mover.predicted.boxes.get(mover.player).x >= seen, 'the mover sees itself ahead of what others see');
  assert.ok(mover.stats.rtt < 250, `rtt ${mover.stats.rtt} ms on localhost`);
  mover.close();
  watcher.close();
});

// Raw RFC 6455 checks: write an upgrade and frames by hand, read what the server answers.
async function raw(port, headers, frames = []) {
  const socket = connect(port, '127.0.0.1');
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  await new Promise((done) => socket.once('connect', done));
  socket.write(`GET /play HTTP/1.1\r\nHost: x\r\n${headers}\r\n`);
  await wait(50);
  for (const frame of frames) socket.write(frame);
  await new Promise((done) => {
    socket.once('close', done);
    setTimeout(() => {
      socket.destroy();
      done();
    }, 500);
  });
  return Buffer.concat(chunks);
}
const upgrade = (extra = '') =>
  `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}`;
const masked = (opcode, payload, { fin = true, mask = true } = {}) => {
  const head = Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | payload.length]),
    key = Buffer.from([1, 2, 3, 4]),
    body = Buffer.from(payload.map((b, i) => (mask ? b ^ key[i & 3] : b)));
  return Buffer.concat(mask ? [head, key, body] : [head, body]);
};
const closeCode = (reply) => {
  const at = reply.indexOf('\r\n\r\n') + 4,
    frame = reply.subarray(at);
  return frame[0] === 0x88 ? frame.readUInt16BE(2) : undefined;
};

test('the WebSocket server follows RFC 6455: accept key, masking, binary only, size limit, origins, paths', async (t) => {
  const listener = await listenWebSocket({ path: '/play', origins: ['https://ok.example'], maxPayload: 16 });
  t.after(() => listener.close());
  const got = [];
  listener.onconnection = (connection) => {
    connection.onmessage = (data) => {
      got.push([...data]);
      connection.send(data);
    };
  };
  const origin = 'Origin: https://ok.example\r\n';
  // The accept key of RFC 6455 section 1.3's example.
  const echo = await raw(listener.port, upgrade(origin), [masked(2, [1, 2, 3])]);
  assert.match(
    echo.toString('latin1'),
    /101 Switching Protocols[\s\S]*Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/,
  );
  assert.deepEqual(got, [[1, 2, 3]]);
  assert.deepEqual([...echo.subarray(echo.indexOf('\r\n\r\n') + 4, echo.indexOf('\r\n\r\n') + 9)], [0x82, 3, 1, 2, 3]);
  // Fragmented binary message, with a ping in the middle.
  got.length = 0;
  await raw(listener.port, upgrade(origin), [masked(2, [1], { fin: false }), masked(9, []), masked(0, [2, 3])]);
  assert.deepEqual(got, [[1, 2, 3]]);
  assert.equal(closeCode(await raw(listener.port, upgrade(origin), [masked(2, [1], { mask: false })])), 1002);
  assert.equal(closeCode(await raw(listener.port, upgrade(origin), [masked(1, [104, 105])])), 1003);
  assert.equal(closeCode(await raw(listener.port, upgrade(origin), [masked(2, new Array(17).fill(0))])), 1009);
  assert.match((await raw(listener.port, upgrade('Origin: https://evil.example\r\n'))).toString(), /^HTTP\/1.1 403/);
  assert.match((await raw(listener.port, upgrade())).toString(), /^HTTP\/1.1 403/);
  assert.match(
    (await raw(listener.port, upgrade(origin).replace('Version: 13', 'Version: 8'))).toString(),
    /^HTTP\/1.1 400/,
  );
});

// Bug 67 (audit E-02): the raw listener had no connection cap, no idle deadline and took any Origin. Its defaults now
// match RoomServer, VoxelServer and acceptWebSocket.
const hostOf = (port) => `localhost:${port}`;
// Like raw(), with the real Host and no waiting for a server close: resolves with what arrived within `ms`.
async function rawHost(port, headers, ms = 300) {
  const socket = connect(port, '127.0.0.1'),
    chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  await new Promise((done) => socket.once('connect', done));
  socket.write(`GET /play HTTP/1.1\r\nHost: ${hostOf(port)}\r\n${headers}\r\n`);
  await wait(ms);
  socket.destroy();
  return Buffer.concat(chunks).toString('latin1');
}

test('listenWebSocket origins: the default is the own host; "*" and a list opt out; no Origin still connects', async (t) => {
  const listener = await listenWebSocket();
  t.after(() => listener.close());
  const own = `http://${hostOf(listener.port)}`;
  assert.match(await rawHost(listener.port, upgrade(`Origin: ${own}\r\n`)), /^HTTP\/1.1 101/, 'own host');
  assert.match(await rawHost(listener.port, upgrade(`Origin: ${own.toUpperCase()}\r\n`)), /^HTTP\/1.1 101/, 'case');
  assert.match(await rawHost(listener.port, upgrade()), /^HTTP\/1.1 101/, 'a client with no Origin header');
  assert.match(await rawHost(listener.port, upgrade('Origin: https://evil.example\r\n')), /^HTTP\/1.1 403/);
  assert.match(
    await rawHost(listener.port, upgrade('Origin: http://localhost:1\r\n')),
    /^HTTP\/1.1 403/,
    'port differs',
  );
  const open = await listenWebSocket({ origins: '*' });
  t.after(() => open.close());
  assert.match(await rawHost(open.port, upgrade('Origin: https://evil.example\r\n')), /^HTTP\/1.1 101/, "'*'");
  const listed = await listenWebSocket({ origins: ['https://ok.example'] });
  t.after(() => listed.close());
  assert.match(await rawHost(listed.port, upgrade('Origin: https://ok.example\r\n')), /^HTTP\/1.1 101/);
  assert.match(await rawHost(listed.port, upgrade()), /^HTTP\/1.1 403/, 'a list refuses a client with no Origin');
  for (const origins of ['https://ok.example', 5, [1], {}, null])
    await assert.rejects(listenWebSocket({ origins }), TypeError, String(origins));
});

test('listenWebSocket maxConnections: the next upgrade gets 503 until one closes', async (t) => {
  const listener = await listenWebSocket({ maxConnections: 2 });
  t.after(() => listener.close());
  const held = [];
  listener.onconnection = (connection) => held.push(connection);
  const sockets = [];
  t.after(() => sockets.forEach((socket) => socket.destroy()));
  const hold = async () => {
    const socket = connect(listener.port, '127.0.0.1'),
      chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    await new Promise((done) => socket.once('connect', done));
    socket.write(`GET / HTTP/1.1\r\nHost: x\r\n${upgrade()}\r\n`);
    await wait(150);
    sockets.push(socket);
    return () => Buffer.concat(chunks).toString('latin1');
  };
  const [one, two, three] = [await hold(), await hold(), await hold()];
  assert.match(one(), /^HTTP\/1.1 101/);
  assert.match(two(), /^HTTP\/1.1 101/);
  assert.match(three(), /^HTTP\/1.1 503/, 'the third connection is over maxConnections');
  assert.equal(held.length, 2, 'the refused one never became a connection');
  held[0].close();
  await wait(100);
  const four = await hold();
  assert.match(four(), /^HTTP\/1.1 101/, 'a slot is free again');
  for (const socket of sockets) socket.destroy();
  for (const bad of [0, -1, 1.5, '3', Number.NaN])
    await assert.rejects(listenWebSocket({ maxConnections: bad }), RangeError, String(bad));
});

test('listenWebSocket firstMessageTimeout: a silent connection is closed with timeout; a message or the default keeps it', async (t) => {
  const listener = await listenWebSocket({ firstMessageTimeout: 200 });
  t.after(() => listener.close());
  const closed = [];
  listener.onconnection = (connection) => {
    connection.onclose = (code, reason) => closed.push([code, reason]);
  };
  const silent = await raw(listener.port, upgrade());
  assert.equal(closeCode(silent), CloseCode.timeout, 'closed with the timeout code');
  assert.match(String(closed[0]?.[1]), /no message within 200 ms \(firstMessageTimeout\)/);
  // A ping is not a message; a binary message is, and then the connection stays open past the deadline.
  closed.length = 0;
  await raw(listener.port, upgrade(), [masked(9, [])]);
  assert.equal(closed.length, 1, 'a ping alone does not keep the connection');
  closed.length = 0;
  const socket = connect(listener.port, '127.0.0.1');
  await new Promise((done) => socket.once('connect', done));
  socket.write(`GET / HTTP/1.1\r\nHost: x\r\n${upgrade()}\r\n`);
  await wait(50);
  socket.write(masked(2, [1]));
  await wait(450);
  assert.deepEqual(closed, [], 'a connection that sent a message stays open past firstMessageTimeout');
  socket.destroy();
  for (const bad of [0, -5, Number.POSITIVE_INFINITY, Number.NaN, '10', 2 ** 31])
    await assert.rejects(listenWebSocket({ firstMessageTimeout: bad }), RangeError, String(bad));
  // The documented default is 10 s, and a zero-config server still runs a game for a client that sends at once.
  const served = await serve(game, { port: 0 });
  t.after(() => served.close());
  const client = await GameClient.join(game, await openWebSocket(`ws://127.0.0.1:${served.port}`), {
    input: () => ({ x: 0, y: 0, boost: false }),
  });
  assert.ok(served.server.players.includes(client.player));
  client.close();
});

// Bug 49: maxPayload limits messages, so a ping between fragments does not count; a close reason is cut by UTF-8
// bytes on a character boundary, so the close frame stays within the 125 bytes a control frame may hold.
test('the WebSocket server: control frames are outside maxPayload; close reasons fit a control frame', async (t) => {
  const listener = await listenWebSocket({ maxPayload: 16 });
  t.after(() => listener.close());
  const got = [];
  listener.onconnection = (connection) => {
    connection.onmessage = (data) => got.push([...data]);
  };
  const reply = await raw(listener.port, upgrade(), [
    masked(2, new Array(10).fill(1), { fin: false }),
    masked(9, new Array(10).fill(7)),
    masked(0, new Array(6).fill(2)),
  ]);
  assert.deepEqual(got, [[...new Array(10).fill(1), ...new Array(6).fill(2)]], '16 bytes of message arrive whole');
  const frames = reply.subarray(reply.indexOf('\r\n\r\n') + 4);
  assert.deepEqual([...frames.subarray(0, 12)], [0x8a, 10, ...new Array(10).fill(7)], 'the ping got its pong');
  // 2 + 3 x 60 bytes of reason: cut to 'ab' and 40 euro signs (122 bytes), never inside a character.
  listener.onconnection = (connection) => connection.close(CloseCode.protocol, `ab${'€'.repeat(60)}`);
  const closing = await raw(listener.port, upgrade());
  const frame = closing.subarray(closing.indexOf('\r\n\r\n') + 4);
  assert.equal(frame[0], 0x88);
  assert.ok(frame[1] <= 125, `close payload is ${frame[1]} bytes`);
  assert.equal(frame.readUInt16BE(2), CloseCode.protocol);
  assert.equal(frame.subarray(4, 2 + frame[1]).toString('utf8'), `ab${'€'.repeat(40)}`);
});

test('openWebSocket: a long multibyte close reason is cut to 123 UTF-8 bytes instead of throwing', async (t) => {
  const listener = await listenWebSocket();
  t.after(() => listener.close());
  const heard = new Promise((done) => {
    listener.onconnection = (connection) => (connection.onclose = (code, reason) => done([code, reason]));
  });
  const connection = await openWebSocket(`ws://127.0.0.1:${listener.port}`);
  connection.close(CloseCode.protocol, 'é'.repeat(100));
  assert.deepEqual(await heard, [CloseCode.protocol, 'é'.repeat(61)]);
});

test('openWebSocket rejects with a coded error when nothing listens, and honours an AbortSignal', async () => {
  const listener = await listenWebSocket();
  const port = listener.port;
  listener.close();
  await listener.closed;
  await assert.rejects(openWebSocket(`ws://127.0.0.1:${port}`), (e) => e.code === 'failed');
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(openWebSocket(`ws://127.0.0.1:${port}`, { signal: controller.signal }), /cancelled/);
  await assert.rejects(openWebSocket('ws://x', { WebSocket: 0 }), (e) => e.code === 'unsupported');
});

// Node 22's WebSocket fires only 'error' (never 'close') when the connection is refused, so openWebSocket used to wait
// forever there (bug 39). A socket that does just that must reject with `failed` on every runtime.
test('openWebSocket rejects with `failed` on an error that no close follows', async () => {
  let closed = 0;
  class ErrorOnly extends EventTarget {
    constructor() {
      super();
      setTimeout(() => this.dispatchEvent(new Event('error')), 0);
    }
    close() {
      closed++;
    }
  }
  await assert.rejects(openWebSocket('ws://127.0.0.1:9', { WebSocket: ErrorOnly }), (e) => e.code === 'failed');
  assert.equal(closed, 1, 'the failed socket is closed');
});

// A stand-in for a pair of RTCDataChannels: what one sends, the other's 'message' event gets (async, like the real one).
function channelPair(label) {
  const make = () => {
    const channel = new EventTarget();
    Object.assign(channel, {
      label,
      readyState: 'open',
      bufferedAmount: 0,
      binaryType: 'blob',
      sent: 0,
      send(data) {
        channel.sent++;
        const copy = data.slice().buffer;
        queueMicrotask(() => channel.peer.dispatchEvent(Object.assign(new Event('message'), { data: copy })));
      },
      close() {
        if (channel.readyState === 'closed') return;
        channel.readyState = 'closed';
        channel.dispatchEvent(new Event('close'));
        channel.peer.close();
      },
    });
    return channel;
  };
  const a = make(),
    b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

test('WebRTC data channels: reliable and unreliable messages keep their channel; close reaches both ends', async () => {
  const [ra, rb] = channelPair('netcode-reliable'),
    [ua, ub] = channelPair('netcode-unreliable');
  const a = dataChannelConnection({ reliable: ra, unreliable: ua }),
    b = dataChannelConnection({ reliable: rb, unreliable: ub });
  const got = [];
  b.onmessage = (data, channel) => got.push([data[0], channel]);
  a.send(new Uint8Array([1]));
  a.send(new Uint8Array([2]), 'unreliable');
  await wait(0);
  assert.deepEqual(got, [
    [1, 'reliable'],
    [2, 'unreliable'],
  ]);
  assert.equal(ra.binaryType, 'arraybuffer');
  // Without an unreliable channel, unreliable messages go reliably.
  const [rc, rd] = channelPair('only');
  const c = dataChannelConnection({ reliable: rc }),
    d = dataChannelConnection({ reliable: rd });
  const seen = [];
  d.onmessage = (data, channel) => seen.push([data[0], channel]);
  c.send(new Uint8Array([9]), 'unreliable');
  await wait(0);
  assert.deepEqual(seen, [[9, 'reliable']]);
  let closed = 0;
  b.onclose = (code) => (closed = code);
  a.close();
  assert.equal(a.open, false);
  assert.equal(b.open, false);
  assert.equal(closed, CloseCode.normal);
  assert.throws(() => dataChannelConnection({}), /createDataChannels/);
});
