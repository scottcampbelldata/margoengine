import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  streamLayer,
  smoothTime,
  SlidingTimeWindow,
  parseServerEvents,
  pollingSource,
  eventSource,
  webSocketSource,
} from '../dist/stream.js';
const near = (a, b, t = 1e-10) => assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);
function fake(kind = 'line', data = { x: [0, 1], y: [10, 20] }) {
  const layer = {
    kind,
    name: 'native',
    positions: Float32Array.from(data.x.flatMap((x, i) => [x, data.y[i], 0])),
    values: data.color,
    line: { visible: true },
    cloud: { visible: true, sizes: data.size },
    bounds: [0, 1, 10, 20, 0, 0],
  };
  const s = { type: 'linear', forward: (v) => v, inverse: (v) => v };
  let calls = 0,
    frame;
  const figure = {
    is2d: true,
    layers: [layer],
    axisScales: [s, s, s],
    bounds: [0, 1, 0, 30, 0, 0],
    engine: {
      onFrame(fn) {
        frame = fn;
        return () => {
          frame = undefined;
        };
      },
    },
    setLimits(b) {
      this.bounds = [...b, 0, 0];
    },
    async updateData(l, d, { signal } = {}) {
      await Promise.resolve();
      signal?.throwIfAborted();
      calls++;
      l.positions = Float32Array.from(Array.from(d.x, (x, i) => [x, d.y[i], d.z?.[i] ?? 0]).flat());
      l.values = d.color;
      l.count = d.x.length;
      return l;
    },
  };
  return {
    layer,
    figure,
    get calls() {
      return calls;
    },
    get frame() {
      return frame;
    },
  };
}
test('append rollover, patch, concurrent requests and input ownership retain native identity', async () => {
  const f = fake(),
    live = await streamLayer(f.figure, f.layer, { rollover: 3, data: { x: [0, 1], y: [10, 20] } });
  assert.equal(live, f.layer);
  const x = [2, 3],
    a = live.append({ x, y: [30, 40] });
  x[0] = 999;
  const b = live.append({ x: [4], y: [50] });
  await Promise.all([a, b]);
  assert.deepEqual([...live.streamData.x], [2, 3, 4]);
  assert.deepEqual([...live.streamData.y], [30, 40, 50]);
  await live.patch(1, { y: [99] });
  assert.deepEqual([...live.streamData.y], [30, 99, 50]);
  const snapshot = live.streamData;
  snapshot.x[0] = 999;
  assert.equal(live.streamData.x[0], 2);
  const before = f.calls;
  await live.append({ x: [], y: [] });
  assert.equal(f.calls, before);
  await assert.rejects(live.patch(3, { y: [1] }));
  await assert.rejects(live.append({ x: [NaN], y: [0] }));
  await live.append({ x: [5, 6, 7, 8, 9], y: [5, 6, 7, 8, 9] });
  assert.deepEqual([...live.streamData.x], [7, 8, 9]);
  live.disposeStream();
  await assert.rejects(live.append({ x: [10], y: [10] }));
  const again = await streamLayer(f.figure, f.layer, { rollover: 3 });
  assert.equal(again, live);
  again[Symbol.dispose]();
});
test('live channels remain aligned; abort cancels queued publication without hiding an error', async () => {
  const f = fake('scatter', { x: [0, 1], y: [1, 2], color: [0.1, 0.2], size: [2, 3] }),
    controller = new AbortController(),
    live = await streamLayer(f.figure, f.layer, { rollover: 2, signal: controller.signal });
  await assert.rejects(live.append({ x: [2], y: [3] }));
  await live.append({ x: [2], y: [3], color: [0.3], size: [4] });
  near(live.streamData.color[1], 0.3);
  assert.deepEqual([...live.streamData.size], [3, 4]);
  const count = f.calls,
    pending = live.append({ x: [3], y: [4], color: [0.4], size: [5] });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(f.calls, count);
});
test('time smoothing has a semigroup law and windows preserve y bounds without wall-clock assertions', () => {
  near(smoothTime(smoothTime(0, 100, 50, 250), 100, 50, 250), smoothTime(0, 100, 100, 250));
  near(smoothTime(2, 5, 0, 0), 5);
  near(smoothTime(0, 100, 250, 250), 100 * (1 - Math.exp(-1)));
  assert.throws(() => smoothTime(0, 1, -1, 1));
  const f = fake(),
    window = new SlidingTimeWindow(f.figure, { duration: 10, end: 20, smoothing: 250, clock: () => 0 });
  window.setTime(100);
  window.advance(250);
  near(window.end, 20 + 80 * (1 - Math.exp(-1)));
  near(f.figure.bounds[1] - f.figure.bounds[0], 10);
  assert.deepEqual(f.figure.bounds.slice(2, 4), [0, 30]);
  window.setTime(200, true);
  assert.equal(window.end, 200);
  window.dispose();
  assert.equal(f.frame, undefined);
  assert.throws(() => window.setTime(300));
});
async function* byteChunks(text) {
  for (const byte of new TextEncoder().encode(text)) yield Uint8Array.of(byte);
}
test('SSE handles byte-split UTF-8, BOM, CRLF, metadata, multiline JSON and final discard', async () => {
  const items = [];
  for await (const e of parseServerEvents(
    byteChunks(
      '\uFEFF: comment\r\ndata: {"x":1,\r\ndata: "y":"π"}\r\nid: a\r\nevent: point\r\nretry: 300\r\n\r\ndata: 2\n\ndata: 3',
    ),
  ))
    items.push(e);
  assert.deepEqual(items, [
    { data: { x: 1, y: 'π' }, event: 'point', id: 'a', retry: 300 },
    { data: 2, event: 'message', id: 'a', retry: 300 },
  ]);
  const exact = [];
  for await (const e of parseServerEvents(byteChunks('data: 1234\n\n'), { maxBytes: 4 })) exact.push(e.data);
  assert.deepEqual(exact, [1234]);
  await assert.rejects(async () => {
    for await (const _ of parseServerEvents(byteChunks('data: 12345\n\n'), { maxBytes: 4 })) void _;
  });
  const cr = [];
  for await (const e of parseServerEvents(byteChunks('data: 1\r\r'))) cr.push(e.data);
  assert.deepEqual(cr, [1]);
});
test('polling yields on consumer demand and cancels interval and in-flight fetch', async () => {
  const controller = new AbortController();
  let calls = 0;
  const it = pollingSource('https://example.test', {
    signal: controller.signal,
    interval: 1000000,
    fetch: async () => {
      calls++;
      return new Response('{"n":1}');
    },
  });
  assert.equal((await it.next()).value.n, 1);
  await Promise.resolve();
  assert.equal(calls, 1);
  const next = it.next();
  controller.abort();
  await assert.rejects(next);
  assert.equal(calls, 1);
  const pendingController = new AbortController(),
    pending = pollingSource('https://example.test', {
      signal: pendingController.signal,
      fetch: (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    });
  const read = pending.next();
  pendingController.abort();
  await assert.rejects(read);
  let entered;
  const parsing = new Promise((resolve) => {
      entered = resolve;
    }),
    parseController = new AbortController(),
    decoding = pollingSource('https://example.test', {
      signal: parseController.signal,
      fetch: async () => new Response('1'),
      parse: () => {
        entered();
        return new Promise(() => {});
      },
    }),
    decodeRead = decoding.next();
  await parsing;
  parseController.abort();
  await assert.rejects(decodeRead);
  const synchronousAbort = new AbortController(),
    syncSource = pollingSource('https://example.test', {
      signal: synchronousAbort.signal,
      fetch: async () => new Response('1'),
      parse: () => {
        synchronousAbort.abort();
        return new Promise(() => {});
      },
    });
  await assert.rejects(syncSource.next());
  await assert.rejects(
    async () => {
      const bad = pollingSource('https://example.test', { fetch: async () => new Response('bad', { status: 503 }) });
      await bad.next();
    },
    (e) => e.code === 'failed',
  );
});
async function serverFixture(fn) {
  const sockets = new Set(),
    server = createServer((req, res) => {
      if (req.url === '/stop') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('id: real\nevent: sample\ndata: {"value":4}\n\n');
      } else {
        res.setHeader('content-type', 'application/json');
        res.end('{"value":5}');
      }
    });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server, `http://127.0.0.1:${server.address().port}`);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
test('HTTP sources use actual streamed SSE and bounded JSON over a local connection', async () => {
  await serverFixture(async (_server, url) => {
    const events = [];
    for await (const event of eventSource(url + '/sse')) events.push(event);
    assert.deepEqual(events, [{ data: { value: 4 }, event: 'sample', id: 'real', retry: undefined }]);
    const stopped = [];
    for await (const e of eventSource(url + '/stop')) stopped.push(e);
    assert.deepEqual(stopped, []);
    const poll = pollingSource(url);
    assert.deepEqual((await poll.next()).value, { value: 5 });
    await poll.return();
    const tiny = pollingSource(url, { maxBytes: 3 });
    await assert.rejects(tiny.next(), (e) => e.code === 'state');
  });
});
const frame = (text) => {
  const data = Buffer.from(text);
  assert.ok(data.length < 126);
  return Buffer.concat([Buffer.from([0x81, data.length]), data]);
};
test('native WebSocket messages, clean close and explicit backlog overflow obey iterator lifetime', async () => {
  await serverFixture(async (server, url) => {
    let burst, closedResolve;
    const closed = new Promise((resolve) => (closedResolve = resolve));
    server.on('upgrade', (request, socket) => {
      const accept = createHash('sha1')
        .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n',
      );
      socket.on('data', (data) => {
        if ((data[0] & 15) === 8 && !socket.writableEnded) socket.end(Buffer.from([0x88, 2, 3, 232]));
      });
      if (request.url === '/clean') {
        socket.write(frame('{"n":1}'));
        socket.write(frame('{"n":2}'));
        socket.end(Buffer.from([0x88, 2, 3, 232]));
      } else {
        socket.on('close', closedResolve);
        burst = () => {
          socket.write(Buffer.concat(Array.from({ length: 10 }, (_, i) => frame(JSON.stringify({ n: i + 2 })))));
        };
        socket.write(frame('{"n":1}'));
      }
    });
    const normal = [];
    for await (const item of webSocketSource(url.replace('http:', 'ws:') + '/clean')) normal.push(item.n);
    assert.deepEqual(normal, [1, 2]);
    const source = webSocketSource(url.replace('http:', 'ws:') + '/overflow', { capacity: 1 });
    assert.equal((await source.next()).value.n, 1);
    burst();
    await closed;
    await assert.rejects(source.next(), (e) => e.code === 'state');
  });
});
test('USGS feed fixture is unmodified and pinned by source SHA-256', () => {
  const root = new URL('../../../examples/assets/sciviz/stream/', import.meta.url),
    bytes = readFileSync(new URL('earthquakes.geojson', root)),
    source = JSON.parse(readFileSync(new URL('source.json', root))),
    data = JSON.parse(bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  assert.equal(data.features.length, source.count);
  assert.ok(data.features.some((f) => Number.isFinite(f.properties.time) && Number.isFinite(f.properties.mag)));
});

test('SSE abort settles pending reads and cleanup without waiting for the source', async () => {
  const { setImmediate: immediate } = await import('node:timers/promises');
  const controller = new AbortController(), reason = new Error('cancel SSE');
  let finish, returned = 0;
  const chunks = {
    [Symbol.asyncIterator]() {
      return {
        next() { return new Promise(resolve => { finish = resolve; }); },
        return() { returned++; return new Promise(() => {}); },
      };
    },
  };
  const iterator = parseServerEvents(chunks, { signal: controller.signal });
  let outcome = 'pending';
  const pending = iterator.next().then(() => { outcome = 'resolved'; }, error => {
    assert.equal(error, reason); outcome = 'aborted';
  });
  controller.abort(reason);
  await immediate();
  const observed = outcome;
  finish({ done: true });
  await pending;
  assert.equal(observed, 'aborted');
  assert.equal(returned, 1);
});

test('SSE preserves normal source exhaustion and closes a returned iterator once', async () => {
  let returned = 0;
  const chunks = {
    [Symbol.asyncIterator]() {
      let count = 0;
      return {
        async next() { return count++ === 0 ? { done: false, value: new TextEncoder().encode('data: 1\n\n') } : { done: true }; },
        async return() { returned++; return { done: true }; },
      };
    },
  };
  const normal = [];
  for await (const event of parseServerEvents(chunks)) normal.push(event.data);
  assert.deepEqual(normal, [1]);
  assert.equal(returned, 0);
  const early = parseServerEvents(chunks);
  await early.next();
  await early.return();
  assert.equal(returned, 1);
});
