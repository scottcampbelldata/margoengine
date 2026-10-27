// The arena example's page and the commands its README gives, followed as written (only the server's port is picked
// free with ARENA_PORT=0, so parallel runs do not collide).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { GameClient } from '../dist/index.js';
import { openWebSocket } from '../dist/websocket.js';
import { game } from '../examples/arena/game.js';

const here = resolve(import.meta.dirname, '..'),
  // The repository by its canonical path. Reached through a Windows 8.3 short name (the fresh-clone check runs under
  // os.tmpdir(), C:/Users//...), Vite compares the short root of its file-serving allow list with each file's
  // long real path and refuses every file with 403.
  root = realpathSync.native(resolve(here, '../..')),
  page = readFileSync(resolve(here, 'examples/arena/index.html'), 'utf8'),
  readme = readFileSync(resolve(here, 'README.md'), 'utf8');

// Runs the page's inline (non-module) script against a stand-in document at `protocol`.
function inline(protocol) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1],
    status = { textContent: '' },
    timers = [];
  runInNewContext(script, {
    location: { protocol },
    document: { getElementById: (id) => (id === 'status' ? status : null), body: { dataset: {} } },
    setTimeout: (run) => timers.push(run),
  });
  return { status, timers };
}

test('opened from a file, the arena page says how to serve it instead of showing blank views', () => {
  const { status } = inline('file:');
  assert.match(status.textContent, /opened from a file/);
  assert.match(status.textContent, /node packages\/netcode\/examples\/arena\/server\.mjs/);
  assert.match(status.textContent, /npm run dev:examples/);
  assert.match(status.textContent, /\?server=ws:\/\/127\.0\.0\.1:8787/);
  // Served over http, the message appears only if the module never started.
  const served = inline('http:');
  assert.equal(served.status.textContent, '');
  served.timers[0]();
  assert.match(served.status.textContent, /did not start/);
});

// Starts `command` in the repository and resolves with the first match of `pattern` in its output.
function start(t, command, pattern, env = {}) {
  const child = spawn(command, { cwd: root, shell: true, env: { ...process.env, ...env } });
  t.after(() => {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill('SIGKILL');
  });
  return new Promise((done, fail) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error(`${command} printed no ${pattern}:\n${output}`)), 60_000);
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output += chunk;
        const match = pattern.exec(output.replace(/\x1b\[[0-9;]*m/g, ''));
        if (match) {
          clearTimeout(timer);
          done(match);
        }
      });
    child.on('exit', (code) => fail(new Error(`${command} exited (${code}):\n${output}`)));
  });
}

test('the README commands run: the arena server accepts a client and the dev server serves the page', {
  timeout: 120_000,
}, async (t) => {
  const section = readme.slice(readme.indexOf('## The arena demo'));
  const server = /`(node packages\/netcode\/examples\/arena\/server\.mjs)`/.exec(section)?.[1],
    dev = /`(npm run dev:examples)`/.exec(section)?.[1],
    url =
      /`(http:\/\/127\.0\.0\.1:5173(\/packages\/netcode\/examples\/arena\/)\?server=ws:\/\/127\.0\.0\.1:8787)`/.exec(
        section,
      );
  assert.ok(server && dev && url, 'the README names both commands and the page URL');
  const [, port] = await start(t, server, /arena server on ws:\/\/127\.0\.0\.1:(\d+)/, { ARENA_PORT: '0' });
  const client = await GameClient.join(game, await openWebSocket(`ws://127.0.0.1:${port}`), {
    input: () => ({ x: 1, y: 0, boost: false }),
  });
  assert.ok(client.player > 0);
  client.close();
  const [, origin] = await start(t, dev, /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/);
  const html = await (await fetch(`${origin}${url[2]}?server=ws://127.0.0.1:${port}`)).text();
  assert.match(html, /<canvas id="a"/);
  const script = await fetch(`${origin}${url[2]}client.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /GameClient/);
});
