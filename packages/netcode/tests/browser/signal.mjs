// Real signalling proof: three real Chromium pages find each other through a SignalServer on a real WebSocket, make a
// full mesh of WebRTC data channels with PeerMesh, and pass reliable and unreliable messages. Then the server closes
// and they go on talking, so nothing but the setup went through it. `npm run test:browser --workspace @margoengine/netcode`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';
import { launchBrowser } from '../../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../../scripts/support/shutdown.mjs';
import { listenWebSocket } from '../../dist/node.js';
import { SignalServer } from '../../dist/signal.js';

const PAGES = 3;
const limit = setTimeout(() => {
  console.error('signal proof timed out');
  process.exit(1);
}, 60_000);

const dist = join(dirname(fileURLToPath(import.meta.url)), '../../dist'),
  folder = mkdtempSync(join(tmpdir(), 'signal-proof-'));
await build({
  input: { signal: join(dist, 'signal.js'), websocket: join(dist, 'websocket.js') },
  output: { dir: folder, format: 'esm', entryFileNames: '[name].js', chunkFileNames: '[name].js' },
  logLevel: 'silent',
});
const web = createServer((request, response) => {
  if (request.url.endsWith('.js')) {
    response.setHeader('content-type', 'text/javascript');
    return response.end(readFileSync(join(folder, request.url.slice(1))));
  }
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>proof</title>');
});
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));

const signals = new SignalServer(),
  listener = await listenWebSocket({ port: 0, host: '127.0.0.1', origins: '*' });
listener.onconnection = (connection) => signals.accept(connection);

const browser = await launchBrowser({ headless: true, needs: 'dom' });
try {
  const pages = [];
  for (let i = 0; i < PAGES; i++) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${web.address().port}/`);
    pages.push(page);
  }
  // All at once: the server's order decides who offers to whom.
  const meshes = [];
  for (const page of pages)
    meshes.push(
      page.evaluate(
        async ({ url, peers }) => {
          const { PeerMesh, SignalClient } = await import('/signal.js'),
            { openWebSocket } = await import('/websocket.js'),
            room = await SignalClient.join(await openWebSocket(url), 'proof'),
            heard = new Map();
          window.heard = heard;
          return new Promise((resolve, reject) => {
            const check = () => {
              const done = [...heard.values()].filter((set) => set.has('reliable') && set.has('unreliable'));
              if (done.length === peers) resolve({ id: room.id, heard: [...heard.keys()].sort() });
            };
            window.mesh = new PeerMesh(room, {
              onerror: (_peer, error) => reject(error),
              onconnection(peer, connection) {
                heard.set(peer, new Set());
                connection.onmessage = (data, channel) => {
                  heard.get(peer).add(data[0] === 9 ? 'after' : channel);
                  check();
                };
                // Datagrams may be lost, so both kinds repeat until the proof ends.
                setInterval(() => {
                  connection.send(new Uint8Array([window.after ? 9 : 1]), 'reliable');
                  connection.send(new Uint8Array([window.after ? 9 : 1]), 'unreliable');
                }, 20);
              },
            });
          });
        },
        { url: `ws://127.0.0.1:${listener.port}`, peers: PAGES - 1 },
      ),
    );
  const results = await Promise.all(meshes);
  const ids = results.map((r) => r.id);
  assert.equal(new Set(ids).size, PAGES);
  for (const { id, heard } of results)
    assert.deepEqual(heard, ids.filter((other) => other !== id).sort(), 'each page heard every other, on both channels');
  assert.equal(signals.peers('proof'), PAGES);

  signals.close();
  listener.close();
  const after = await Promise.all(
    pages.map((page) =>
      page.evaluate(async () => {
        window.after = true;
        for (let i = 0; i < 500; i++) {
          if ([...window.heard.values()].every((set) => set.has('after'))) return true;
          // fixed-wait: one poll of what has been heard; the loop ends as soon as it is all there
          await new Promise((r) => setTimeout(r, 10));
        }
        return false;
      }),
    ),
  );
  assert.deepEqual(after, new Array(PAGES).fill(true), 'the mesh goes on with the signalling server gone');
  console.log(`signal proof passed: ${PAGES} pages, ${(PAGES * (PAGES - 1)) / 2} links, ${browser.version()}`);
} finally {
  clearTimeout(limit);
  await closeAll({ browser, servers: [web] });
  rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(0);
