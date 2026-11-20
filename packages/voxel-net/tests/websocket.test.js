import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { acceptKey, acceptWebSocket, connectWebSocket } from '../dist/server.js';

// An echo server on a free port: every binary message comes back.
async function echoServer(options = { maxMessage: 1 << 20 }) {
  const http = createServer((_req, res) => res.end()),
    closes = [];
  http.on('upgrade', (req, socket, head) => {
    const conn = acceptWebSocket(req, socket, head, options);
    if (!conn) return;
    conn.onmessage = (data) => conn.send(data);
    conn.onclose = (code) => closes.push(code);
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  const { port } = http.address();
  return { port, closes, close: () => new Promise((done) => http.close(done)) };
}

// A raw TCP client that has done the opening handshake; `frames` collects what the server sends after it.
async function rawClient(port) {
  const socket = connect(port, '127.0.0.1');
  await new Promise((done) => socket.once('connect', done));
  socket.write(
    'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  let data = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]);
  });
  await new Promise((done) => {
    const wait = () => (data.includes('\r\n\r\n') ? done() : setTimeout(wait, 5));
    wait();
  });
  const end = data.indexOf('\r\n\r\n') + 4;
  assert.match(data.subarray(0, end).toString(), /101 Switching Protocols[\s\S]*s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  data = data.subarray(end);
  return {
    socket,
    received: () => data,
    // A frame from a client: masked unless told otherwise.
    frame(opcode, payload, { fin = true, mask = true, length } = {}) {
      const n = length ?? payload.length,
        head = n < 126 ? 2 : n < 65536 ? 4 : 10,
        out = Buffer.alloc(head + (mask ? 4 : 0) + payload.length);
      out[0] = (fin ? 0x80 : 0) | opcode;
      if (n < 126) out[1] = n;
      else if (n < 65536) {
        out[1] = 126;
        out.writeUInt16BE(n, 2);
      } else {
        out[1] = 127;
        out.writeUInt32BE(0, 2);
        out.writeUInt32BE(n, 6);
      }
      if (mask) {
        out[1] |= 0x80;
        const key = [1, 2, 3, 4];
        out.set(key, head);
        for (let i = 0; i < payload.length; i++) out[head + 4 + i] = payload[i] ^ key[i & 3];
      } else out.set(payload, head);
      socket.write(out);
    },
  };
}
const settle = (ms = 50) => new Promise((done) => setTimeout(done, ms));

test('accept key matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test("Node's own WebSocket client round-trips messages of every length form", async () => {
  const server = await echoServer(),
    socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  socket.binaryType = 'arraybuffer';
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  for (const size of [0, 10, 125, 126, 1000, 65535, 65536, 200_000]) {
    const sent = Uint8Array.from({ length: size }, (_, i) => (i * 7 + size) & 255),
      back = new Promise((done) => {
        socket.onmessage = (event) => done(new Uint8Array(event.data));
      });
    socket.send(sent);
    assert.deepEqual(await back, sent, `${size} bytes`);
  }
  socket.close(1000);
  await settle();
  assert.deepEqual(server.closes, [1000]);
  await server.close();
});

test('the Node client connects, masks its frames and round-trips', async () => {
  const server = await echoServer(),
    conn = await connectWebSocket(`ws://127.0.0.1:${server.port}`),
    sent = Uint8Array.from({ length: 70_000 }, (_, i) => i & 255),
    back = new Promise((done) => {
      conn.onmessage = done;
    });
  conn.send(sent);
  assert.deepEqual(new Uint8Array(await back), sent);
  conn.close();
  await settle();
  await server.close();
});

test('fragments join into one message and pings are answered between them', async () => {
  const server = await echoServer(),
    client = await rawClient(server.port);
  client.frame(2, Buffer.from([1, 2, 3]), { fin: false });
  client.frame(9, Buffer.from('hi'));
  client.frame(0, Buffer.from([4, 5]));
  await settle();
  const got = client.received();
  // Pong (0x8a) carrying 'hi', then the joined binary message (0x82) unmasked.
  assert.deepEqual([...got], [0x8a, 2, 104, 105, 0x82, 5, 1, 2, 3, 4, 5]);
  client.socket.destroy();
  await server.close();
});

for (const [name, send, code] of [
  ['an unmasked client frame', (c) => c.frame(2, Buffer.from([1]), { mask: false }), 1002],
  ['a text frame', (c) => c.frame(1, Buffer.from('hello')), 1003],
  ['a message over the limit', (c) => c.frame(2, Buffer.alloc(0), { length: 5000 }), 1009],
  ['a continuation without a message', (c) => c.frame(0, Buffer.from([1])), 1002],
  ['reserved bits', (c) => c.socket.write(Buffer.from([0xc2, 0x80, 0, 0, 0, 0])), 1002],
])
  test(`${name} closes the connection with ${code}`, async () => {
    const server = await echoServer({ maxMessage: 4096 }),
      client = await rawClient(server.port);
    send(client);
    await settle();
    const got = client.received();
    assert.equal(got[0], 0x88, 'a close frame');
    assert.equal(got.readUInt16BE(2), code);
    assert.deepEqual(server.closes, [code]);
    client.socket.destroy();
    await server.close();
  });

test('a request that is not a WebSocket upgrade gets 400', async () => {
  const server = await echoServer(),
    socket = connect(server.port, '127.0.0.1');
  socket.write(
    'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  const reply = await new Promise((done) => socket.once('data', (d) => done(d.toString())));
  assert.match(reply, /^HTTP\/1\.1 400/);
  socket.destroy();
  await server.close();
});

test('an origin outside the allowed list gets 403, and connectWebSocket rejects a refused upgrade', async () => {
  const server = await echoServer({ origins: ['https://margoengine.com'] });
  await assert.rejects(connectWebSocket(`ws://127.0.0.1:${server.port}`), { name: 'MargoError', code: 'failed' });
  await assert.rejects(connectWebSocket('http://127.0.0.1:1'), TypeError);
  await server.close();
});

// A masked binary frame from a client (key 1 2 3 4), for messages written in the same TCP write as the upgrade.
const maskedFrame = (payload) => {
  const out = Buffer.alloc(6 + payload.length),
    key = [1, 2, 3, 4];
  out[0] = 0x82;
  out[1] = 0x80 | payload.length;
  out.set(key, 2);
  for (let i = 0; i < payload.length; i++) out[6 + i] = payload[i] ^ key[i & 3];
  return out;
};
const upgradeRequest =
  'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

// Bug 43: bytes that arrive with the upgrade request (`head`) were parsed in the constructor, before the caller could
// set onmessage, so a message in the same packet as the upgrade was dropped.
test('messages in the same TCP write as the upgrade reach onmessage set after the connection is made', {
  timeout: 10_000,
}, async () => {
  const server = await echoServer(),
    socket = connect(server.port, '127.0.0.1');
  await new Promise((done) => socket.once('connect', done));
  let data = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]);
  });
  socket.write(
    Buffer.concat([Buffer.from(upgradeRequest), maskedFrame(Buffer.from('one')), maskedFrame(Buffer.from('two'))]),
  );
  const started = Date.now();
  while (Date.now() - started < 2000 && !data.includes('two')) await settle(5);
  const body = data.subarray(data.indexOf('\r\n\r\n') + 4);
  assert.deepEqual(
    [...body],
    [0x82, 3, ...Buffer.from('one'), 0x82, 3, ...Buffer.from('two')],
    'both echoed, in order',
  );
  socket.destroy();
  await server.close();
});

test('connectWebSocket keeps a message and a close that came with the 101 for handlers set after it resolves', {
  timeout: 10_000,
}, async () => {
  // A server that answers the upgrade, a binary frame and a close frame in one write.
  const http = createServer((_req, res) => res.end());
  http.on('upgrade', (req, socket) => {
    socket.write(
      Buffer.concat([
        Buffer.from(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
        ),
        Buffer.from([0x82, 5, ...Buffer.from('hello')]),
        Buffer.from([0x88, 2, 0x03, 0xe8]),
      ]),
    );
    socket.end();
    socket.resume(); // read the client's close reply, so the socket ends and http.close() returns
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  const conn = await connectWebSocket(`ws://127.0.0.1:${http.address().port}`),
    events = [];
  await settle(20); // the handlers come late on purpose
  conn.onmessage = (data) => events.push(Buffer.from(data).toString());
  conn.onclose = (code) => events.push(code);
  await settle(20);
  assert.deepEqual(events, ['hello', 1000]);
  await new Promise((done) => http.close(done));
});

test('messages with no handler set are kept only up to 4 x maxMessage bytes, then the connection closes 1008', {
  timeout: 10_000,
}, async () => {
  const http = createServer((_req, res) => res.end()),
    codes = [];
  let connection;
  http.on('upgrade', (req, socket, head) => {
    connection = acceptWebSocket(req, socket, head, { maxMessage: 125 });
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  const client = await rawClient(http.address().port);
  for (let i = 0; i < 6; i++) client.frame(2, Buffer.alloc(100, i));
  await settle(100);
  connection.onclose = (code) => codes.push(code);
  await settle(20);
  assert.deepEqual(codes, [1008]);
  client.socket.destroy();
  await new Promise((done) => http.close(done));
});

// RFC 6455 5.5: a control frame carries at most 125 bytes, so a close reason is cut to 123 bytes of UTF-8, on a whole
// character. It was cut at 120 UTF-16 units, so 100 'é' (200 bytes) went out as a 202-byte close frame.
test('a long non-ASCII close reason is cut to fit a 125-byte control frame on a whole character', async () => {
  const http = createServer((_req, res) => res.end());
  http.on('upgrade', (req, socket, head) => {
    const conn = acceptWebSocket(req, socket, head);
    conn.onmessage = () => conn.close(4000, 'é'.repeat(100));
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  const client = await rawClient(http.address().port);
  client.frame(2, Buffer.from([1]));
  await settle();
  const got = client.received();
  assert.equal(got[0], 0x88, 'a close frame');
  assert.ok(got[1] <= 125, `payload ${got[1]} bytes fits a control frame`);
  assert.equal(got.readUInt16BE(2), 4000);
  assert.equal(got.subarray(4, 2 + got[1]).toString('utf8'), 'é'.repeat(61));
  client.socket.destroy();
  await new Promise((done) => http.close(done));
});

// RFC 6455 7.4 and 8.1 (Autobahn cases 7.5 and 7.9): a close code a peer may not send fails the connection with 1002,
// and a reason that is not UTF-8 with 1007. Both were taken and reported as given.
for (const [name, payload, code] of [
  ['code 1005', [0x03, 0xed], 1002],
  ['code 999', [0x03, 0xe7], 1002],
  ['code 1004', [0x03, 0xec], 1002],
  ['code 1006', [0x03, 0xee], 1002],
  ['code 1016', [0x03, 0xf8], 1002],
  ['code 2999', [0x0b, 0xb7], 1002],
  ['a reason that is not UTF-8', [0x03, 0xe8, 0xce, 0xba, 0xff], 1007],
])
  test(`a close frame with ${name} fails the connection with ${code}`, async () => {
    const server = await echoServer(),
      client = await rawClient(server.port);
    client.frame(8, Buffer.from(payload));
    await settle();
    const got = client.received();
    assert.equal(got[0], 0x88, 'a close frame');
    assert.equal(got.readUInt16BE(2), code);
    assert.deepEqual(server.closes, [code]);
    client.socket.destroy();
    await server.close();
  });

test('close codes a peer may send are echoed and reported', async () => {
  for (const code of [1000, 1003, 1007, 1014, 3000, 4999]) {
    const server = await echoServer(),
      client = await rawClient(server.port),
      body = Buffer.alloc(2);
    body.writeUInt16BE(code);
    client.frame(8, Buffer.concat([body, Buffer.from('κ')]));
    await settle();
    const got = client.received();
    assert.equal(got.readUInt16BE(2), code);
    assert.deepEqual(server.closes, [code]);
    client.socket.destroy();
    await server.close();
  }
});

// RFC 6455 4.4: a version the server does not speak is answered with 426 and the versions it does.
test('a request for another WebSocket version gets 426 naming version 13', async () => {
  const server = await echoServer(),
    socket = connect(server.port, '127.0.0.1');
  socket.write(
    'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n\r\n',
  );
  const reply = await new Promise((done) => socket.once('data', (d) => done(d.toString())));
  assert.match(reply, /^HTTP\/1\.1 426 Upgrade Required\r\n/);
  assert.match(reply, /\r\nSec-WebSocket-Version: 13\r\n/);
  socket.destroy();
  await server.close();
});
