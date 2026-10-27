// modern:test:browser started `next start --port 5195` and polled http://127.0.0.1:5195 until it answered. With two
// worktrees' suites on the GPU at once, the second Next exits with "address in use" while the first one answers the
// poll, so the second suite tested the other worktree's build (and failed when that server closed). Servers a suite
// spawns start on port 0 and the suite reads the URL the process prints (scripts/support/server-url.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { serverUrl } from '../scripts/support/server-url.mjs';

const pattern = /- Local:\s+(http:\/\/\S+)[\s\S]*\bReady\b/;
const node = (code, ...args) =>
  spawn(process.execPath, ['-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
// Prints Next's lines for the port it got; answers every request with its own pid.
const fakeNext = `
  const server = require('node:http').createServer((_, res) => res.end(String(process.pid)));
  server.listen(Number(process.argv[1]), '127.0.0.1', () => {
    console.log('- Local:         http://127.0.0.1:' + server.address().port);
    setTimeout(() => console.log('Ready in 5ms'), 50);
  });
  server.on('error', (error) => { console.error(error.message); process.exit(1); });`;

test('the URL is the one the process printed once ready, and it is that process answering', async () => {
  const child = node(fakeNext, '0');
  try {
    const { url } = await serverUrl(child, { pattern, name: 'fake next' });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await (await fetch(url)).text(), String(child.pid));
  } finally {
    child.kill();
  }
});

test('a server that cannot listen fails, even while another one answers on its port', async () => {
  const other = createServer((_, res) => res.end('another worktree')).listen(0, '127.0.0.1');
  await new Promise((resolve) => other.once('listening', resolve));
  const child = node(fakeNext, String(other.address().port));
  try {
    await assert.rejects(serverUrl(child, { pattern, name: 'fake next' }), (error) => {
      assert.match(error.message, /fake next exited \(code 1\) before it printed its URL/);
      assert.match(error.message, /EADDRINUSE/);
      return true;
    });
  } finally {
    other.close();
  }
});

test('a server that prints no URL in time fails, naming it, with its output', async () => {
  const child = node(`console.log('starting'); setInterval(() => {}, 1000);`);
  try {
    await assert.rejects(
      serverUrl(child, { pattern, name: 'quiet server', ms: 300 }),
      /quiet server printed no URL within 0 s:\nstarting/,
    );
  } finally {
    child.kill();
  }
});

test('modern:test:browser starts Next on port 0 and opens the URL it printed', () => {
  const source = readFileSync('scripts/modern-browser-tests.js', 'utf8');
  assert.match(source, /'start', '--hostname', '127\.0\.0\.1', '--port', '0'\]/);
  assert.doesNotMatch(source, /127\.0\.0\.1:5195/);
  assert.match(source, /page\.goto\(nextUrl\)/);
});
