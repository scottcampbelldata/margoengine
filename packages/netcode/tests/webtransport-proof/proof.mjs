// Real WebTransport proof: a real Chromium opens `openWebTransport` to a real HTTP/3 server (server.py, on the outside
// tool aioquic) and sends reliable messages, datagrams and a message too big for a datagram; each comes back through
// QUIC, and the close code the server sends reaches the Connection's onclose. Needs Python with aioquic, so it is not
// part of `npm test`: after `npm run build --workspace @margoengine/netcode`, run
// `node packages/netcode/tests/webtransport-proof/proof.mjs <python>` (see docs/whitepaper/reproduce.md).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'rolldown';
import { closeAll, killTree } from '../../../../scripts/support/shutdown.mjs';

const [python, browserPath] = process.argv.slice(2),
  here = dirname(fileURLToPath(import.meta.url)),
  port = 44330 + (process.pid % 200),
  keys = mkdtempSync(join(tmpdir(), 'webtransport-proof-'));
// The built entry, in one file for the page.
await build({
  input: { entry: join(here, '../../dist/webtransport.js') },
  output: { dir: keys, format: 'esm', entryFileNames: '[name].js' },
  logLevel: 'silent',
});
const bundle = join(keys, 'entry.js');
const server = spawn(python, [join(here, 'server.py'), String(port), keys], { stdio: ['ignore', 'pipe', 'inherit'] });
const limit = setTimeout(() => {
  server.kill();
  console.error('proof timed out');
  process.exit(1);
}, 60_000);
const hash = await new Promise((resolve, reject) => {
  server.stdout.on('data', (data) => {
    const line = /ready (\S+)/.exec(String(data));
    if (line) resolve(line[1]);
  });
  server.on('exit', (code) => reject(new Error(`server.py exited with ${code}`)));
});
const web = createServer((request, response) => {
  if (request.url === '/entry.js') {
    response.setHeader('content-type', 'text/javascript');
    return response.end(readFileSync(bundle));
  }
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>proof</title>');
});
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
let failed = true;
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${web.address().port}/`);
  const result = await page.evaluate(
    async ({ url, hash }) => {
      const { openWebTransport } = await import('/entry.js');
      const value = Uint8Array.from(atob(hash), (c) => c.charCodeAt(0));
      const connection = await openWebTransport(url, {
        serverCertificateHashes: [{ algorithm: 'sha-256', value }],
      });
      const probe = new WebTransport(url, { serverCertificateHashes: [{ algorithm: 'sha-256', value }] });
      await probe.ready;
      window.size = probe.datagrams.maxDatagramSize;
      probe.close();
      const got = [];
      const closed = new Promise((resolve) => {
        connection.onclose = (code, reason) => resolve({ code, reason });
      });
      const count = (n) => new Promise((resolve) => (want = [n, resolve]));
      let want = [0, null];
      connection.onmessage = (data, channel) => {
        got.push({ channel, size: data.length, first: data[0] });
        if (got.length === want[0]) want[1]();
      };
      // fixed-wait: a time limit on the echo, which ends the wait as soon as it comes
      const wait = (n) => Promise.race([count(n), new Promise((r) => setTimeout(r, 10_000))]);
      connection.send(new Uint8Array([1, 2, 3]), 'reliable');
      connection.send(new Uint8Array(200_000).fill(2), 'reliable');
      connection.send(new Uint8Array(300).fill(3), 'reliable');
      connection.send(new Uint8Array(500).fill(4), 'unreliable');
      await wait(4);
      // Over any datagram size, with the stream clear: it goes on the stream rather than vanish.
      connection.send(new Uint8Array(30_000).fill(5), 'unreliable');
      await wait(5);
      connection.send(new TextEncoder().encode('bye'), 'unreliable');
      // fixed-wait: a time limit on the close, which ends the wait as soon as it comes
      const close = await Promise.race([closed, new Promise((r) => setTimeout(() => r('no close'), 10_000))]);
      return { got, close, version: navigator.userAgent, size: window.size };
    },
    { url: `https://127.0.0.1:${port}/echo`, hash },
  );
  console.log(JSON.stringify(result));
  const channels = Object.fromEntries(result.got.map((m) => [m.first, m.channel]));
  const sizes = Object.fromEntries(result.got.map((m) => [m.first, m.size]));
  failed = !(
    channels[1] === 'reliable' &&
    sizes[2] === 200_000 &&
    sizes[3] === 300 &&
    channels[4] === 'unreliable' &&
    sizes[4] === 500 &&
    channels[5] === 'reliable' &&
    sizes[5] === 30_000 &&
    result.close.code === 4007 &&
    result.close.reason === 'proof done'
  );
  console.log(failed ? 'PROOF FAILED' : 'proof passed');
} finally {
  clearTimeout(limit);
  server.removeAllListeners('exit');
  await killTree(server);
  await closeAll({ browser, servers: [web] });
  rmSync(keys, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
