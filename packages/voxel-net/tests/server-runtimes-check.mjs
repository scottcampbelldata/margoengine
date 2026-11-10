import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelNetClient } from '../dist/index.js';
import { connectWebSocket } from '../dist/server.js';
import { testBlocks } from './blocks.js';

const root = resolve(import.meta.dirname, '../../..');
const fixture = resolve(import.meta.dirname, 'native-server-fixture.js');
const runtimes = [
  ['Bun', process.env.MARGO_BUN_BIN ?? 'bun', []],
  ['Deno', process.env.MARGO_DENO_BIN ?? 'deno', ['run', '--allow-all', '--node-modules-dir=manual']],
];
async function until(fn) {
  const signal = AbortSignal.timeout(10000);
  while (!fn()) await delay(10, undefined, { signal });
}
for (const [name, bin, args] of runtimes) {
  const child = spawn(bin, [...args, fixture], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const errors = [];
  child.stderr.on('data', (data) => errors.push(String(data)));
  const exit = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => done(code));
  });
  // Register the rejection handler before awaiting startup, including a missing executable.
  exit.catch(() => {});
  const kill = () =>
    process.platform === 'win32'
      ? spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      : child.kill('SIGKILL');
  const timer = setTimeout(kill, 40000);
  const connections = [];
  const lines = createInterface({ input: child.stdout });
  let url;
  lines.on('line', (line) => {
    if (line.startsWith('{')) url = JSON.parse(line).url;
    else console.log(`${name}: ${line}`);
  });
  try {
    await Promise.race([
      until(() => !!url),
      exit.then((code) => {
        throw new RangeError(`${name} exited ${code} before listening: ${errors.join('')}`);
      }),
    ]);
    const http = url.replace(/^ws/, 'http');
    assert.equal((await fetch(http)).status, 426);
    await assert.rejects(connectWebSocket(url, { headers: { origin: 'https://other.example' } }), /403/);
    const refused = await connectWebSocket(url);
    connections.push(refused);
    assert.equal(
      await new Promise((done) => {
        refused.onclose = (code) => done(code);
      }),
      1008,
    );
    const conn = await connectWebSocket(url, { headers: { cookie: 'access=allow' } });
    connections.push(conn);
    const client = new VoxelNetClient(
      new VoxelWorld({ blocks: testBlocks() }),
      { send: (data) => conn.send(data), close: () => conn.close() },
      { view: 2 },
    );
    client.onError = (error) => assert.fail(error);
    conn.onmessage = (data) => client.receive(data);
    const apps = [];
    client.onApp = (data) => apps.push([...data]);
    await until(() => client.spawned);
    assert.equal(client.world.getBlock(16, 7, 16), 1);
    assert.equal(client.sendApp(Uint8Array.of(7, 0, 255)), true);
    await until(() => apps.length === 1);
    assert.deepEqual(apps, [[7, 0, 255]]);
    client.close();
    // One pending connection is enough to exercise the same per-address admission rule on both runtimes.
    const pending = await connectWebSocket(`${url}?token=allow`);
    connections.push(pending);
    const pendingClosed = new Promise((done) => {
      pending.onclose = (code) => done(code);
    });
    await assert.rejects(connectWebSocket(`${url}?token=allow`), /429/);
    assert.equal(await pendingClosed, 1008);
    const text = new WebSocket(`${url}?token=allow`);
    const textClosed = new Promise((done) => text.addEventListener('close', (e) => done(e.code), { once: true }));
    await new Promise((done, reject) => {
      text.addEventListener('open', done, { once: true });
      text.addEventListener('error', reject, { once: true });
    });
    text.send('not binary');
    assert.equal(await textClosed, 1003);
    const oversized = await connectWebSocket(`${url}?token=allow`);
    connections.push(oversized);
    const oversizedClosed = new Promise((done) => {
      oversized.onclose = (code) => done(code);
    });
    oversized.send(new Uint8Array(4097));
    assert.equal(await oversizedClosed, 1009);
    child.stdin.end('close\n');
    assert.equal(await exit, 0, `${name}: ${errors.join('')}`);
    assert.deepEqual(errors, []);
    console.log(
      `${name}: same contract passed: native upgrade, HTTP/origin/auth, authoritative chunks, app echo, pending limit, hello timeout, binary limit and abort shutdown`,
    );
  } catch (error) {
    console.error(`${name} native contract failed: ${errors.join('')}`);
    throw error;
  } finally {
    for (const conn of connections) conn.close();
    lines.close();
    if (child.exitCode === null) {
      child.stdin.end('close\n');
      await Promise.race([
        exit,
        delay(3000).then(() => {
          kill();
        }),
      ]);
    }
    clearTimeout(timer);
  }
}
