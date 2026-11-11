// Rapier's Wasm is its own file (dist/rapier3d.wasm), fetched and compiled by Physics.load(). This file runs in its own
// process, so nothing has loaded when it starts: the failures come first, while every call still has to load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { Physics } from '../dist/index.js';
import { emptyWasm, lookAlikeWasm } from './wasm-fixtures.js';

const wasmFile = new URL('../dist/rapier3d.wasm', import.meta.url);

/** A local server; `handle` answers each request. Closed when the test ends. */
async function serve(t, handle) {
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the package ships the Wasm as a file of its own, beside a solver chunk that does not inline it', async () => {
  const bytes = await readFile(wasmFile);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'a Wasm binary');
  assert.ok(WebAssembly.validate(bytes), 'valid Wasm');
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(new URL('../dist/', import.meta.url))) {
    if (!name.endsWith('.js')) continue;
    const size = (await stat(new URL(`../dist/${name}`, import.meta.url))).size;
    assert.ok(size < 500_000, `${name} is ${size} bytes; a JavaScript file over 500 kB means the Wasm was inlined again`);
    // The app's bundler emits the file only when it sees a plain `new URL(literal, import.meta.url)`: an ignore
    // comment left in front of it would make Vite skip the asset and the app 404 on the Wasm.
    const code = await readFile(new URL(`../dist/${name}`, import.meta.url), 'utf8');
    if (!code.includes('rapier3d.wasm?')) continue;
    assert.match(code, /new URL\("\.\/rapier3d\.wasm\?no-inline", import\.meta\.url\)/, name);
    assert.doesNotMatch(code, /@vite-ignore[^)]*rapier3d\.wasm/, name);
  }
});

test('a bad Wasm URL rejects with a coded error naming the URL, and nothing is loaded', async (t) => {
  const base = await serve(t, (request, response) => {
    if (request.url === '/missing.wasm') {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not here');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/wasm' }).end(Buffer.from('not wasm at all'));
  });
  await assert.rejects(Physics.load({ wasm: `${base}/missing.wasm` }), (error) => {
    assert.equal(error.name, 'MargoError');
    assert.equal(error.code, 'failed');
    assert.match(error.message, /missing\.wasm \(404 Not Found\)/);
    return true;
  });
  await assert.rejects(Physics.load({ wasm: `${base}/garbage.wasm` }), { name: 'MargoError', code: 'failed' });
  await assert.rejects(Physics.load({ wasm: new URL('./no-such-file.wasm', wasmFile) }), (error) => {
    assert.equal(error.code, 'failed');
    assert.match(error.message, /could not be read from file:/);
    return true;
  });
  // Valid Wasm that is not Rapier's instantiates fine; it must still be refused, not handed to the solver.
  for (const wasm of [emptyWasm, lookAlikeWasm])
    await assert.rejects(Physics.load({ wasm }), (error) => {
      assert.equal(error.name, 'MargoError');
      assert.equal(error.code, 'failed');
      assert.match(error.message, /not the Rapier build/);
      return true;
    });
  await assert.rejects(Physics.load({ wasm: 'http://[bad' }), { name: 'TypeError' });
  assert.throws(() => new Physics(null), { name: 'MargoError', code: 'state' }, 'a failed load loads nothing');
});

test('aborting the only waiting call cancels the download; another caller keeps a shared load going', async (t) => {
  const wasm = await readFile(wasmFile);
  let closed = 0,
    requests = 0;
  const held = [];
  const base = await serve(t, (request, response) => {
    requests++;
    response.on('close', () => {
      if (!response.writableEnded) closed++;
    });
    if (request.url === '/hang.wasm') return; // never answers
    held.push(() => response.writeHead(200, { 'content-type': 'application/wasm' }).end(wasm));
  });

  const controller = new AbortController();
  const load = Physics.load({ wasm: `${base}/hang.wasm`, signal: controller.signal });
  for (let i = 0; i < 400 && requests === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests, 1, 'the request reached the server');
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(load, { name: 'AbortError' });
  for (let i = 0; i < 200 && closed === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closed, 1, 'the download was cancelled, not left running');
  assert.throws(() => new Physics(null), { code: 'state' });

  // Two calls share one load: the first one's abort stops only its own wait.
  const first = new AbortController();
  const a = Physics.load({ wasm: `${base}/slow.wasm`, signal: first.signal }),
    b = Physics.load({ signal: new AbortController().signal });
  for (let i = 0; i < 400 && held.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  first.abort();
  await assert.rejects(a, { name: 'AbortError' });
  held.shift()();
  await b;
  const physics = new Physics(null, { gravity: [0, -10, 0], interpolate: false }),
    body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(Math.abs(body.position[1] + 5) < 0.0834, `fell to ${body.position[1]}`);
  physics.dispose();
  assert.equal(closed, 1, 'the shared download finished');
  await Physics.load({ wasm: `${base}/hang.wasm` }); // loaded: resolves at once and fetches nothing
});
