import assert from 'node:assert/strict';
import test from 'node:test';
import { serveVoxelBun, serveVoxelDeno } from '../dist/server-runtimes.js';

test('native runtime factories fail with a coded unsupported error in Node', async () => {
  await assert.rejects(serveVoxelBun({}), (error) => error.code === 'unsupported' && /bun/.test(error.message));
  await assert.rejects(serveVoxelDeno({}), (error) => error.code === 'unsupported' && /deno/.test(error.message));
});

// KB5545a: Deno answers pings inside the runtime and shows no pong, so the server's byte-silence clock closed a live idle
// client. A connection whose runtime closes an unanswering client itself (livenessByRuntime) is left to that runtime.
test('a connection whose runtime checks liveness is not closed for byte silence; Deno gets an idle ping', async (t) => {
  const { VoxelServer } = await import('../dist/server.js'),
    { encodeClientMessage, PROTOCOL_VERSION } = await import('../dist/index.js'),
    { testBlocks } = await import('./blocks.js');
  const server = new VoxelServer({
    blocks: testBlocks(),
    workers: 1,
    generator: new URL('./flat-generator.js', import.meta.url),
    spawn: () => [0, 0],
    tickRate: 60,
    heartbeatInterval: 50,
    clientTimeout: 200,
  });
  server.onError = () => {};
  await server.listen(0);
  t.after(() => server.close());
  const fake = (livenessByRuntime) => {
    const c = {
      closed: undefined,
      bytesIn: 0,
      buffered: 0,
      livenessByRuntime,
      onmessage: null,
      onclose: null,
      send() {},
      close(code, reason) {
        if (c.closed) return;
        c.closed = { code, reason };
        c.onclose?.(code, reason);
      },
      cork() {},
      uncork() {},
      ping() {},
    };
    return c;
  };
  const silent = fake(false),
    native = fake(true);
  for (const [c, name] of [
    [silent, 'ann'],
    [native, 'bob'],
  ]) {
    server.accept(c);
    const hello = encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view: 2, name });
    c.bytesIn += hello.length;
    c.onmessage(hello);
  }
  const deadline = Date.now() + 5000;
  while (!silent.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20)); // poll: ticks at 60 Hz
  assert.deepEqual(silent.closed, { code: 1008, reason: 'client-silent' });
  assert.equal(native.closed, undefined, 'the runtime-checked connection stays open');

  // Deno: upgradeWebSocket gets an idle ping no later than half of clientTimeout, so a dead client closes within it.
  let upgrade;
  const previous = globalThis.Deno;
  globalThis.Deno = {
    serve(_options, handler) {
      this.handler = handler;
      return { addr: { hostname: '127.0.0.1', port: 1 }, shutdown: async () => {} };
    },
    upgradeWebSocket(_request, options) {
      upgrade = options;
      const socket = new EventTarget();
      socket.close = () => {};
      socket.send = () => 1;
      return { socket, response: new Response(null, { status: 200 }) };
    },
  };
  t.after(() => (globalThis.Deno = previous));
  const host = await serveVoxelDeno({ blocks: testBlocks(), workers: 1, generator: new URL('./flat-generator.js', import.meta.url), clientTimeout: 9000 });
  try {
    globalThis.Deno.handler(new Request('http://127.0.0.1/', { headers: { upgrade: 'websocket' } }), {
      remoteAddr: { hostname: '127.0.0.1' },
    });
    assert.equal(upgrade.idleTimeout, 4, 'floor(9000 ms / 2) in whole seconds');
  } finally {
    await host.close();
  }
});
