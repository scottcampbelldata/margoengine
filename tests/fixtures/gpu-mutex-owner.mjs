// CPU-only process handshake for the live-owner mutex regression. All paths are supplied by the test.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [role, folder] = process.argv.slice(2);
const mutex = join(folder, 'gpu.lock', 'mutex');
const mark = (name, value = '') => fs.writeFileSync(join(folder, name), value);
const until = (name) => {
  const end = Date.now() + 30_000;
  while (!fs.existsSync(join(folder, name))) {
    if (Date.now() > end) throw new Error(`mutex fixture timed out waiting for ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
if (role === 'heartbeat') {
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(mutex, old, old);
  const deadline = Date.now() + 10_000;
  while (Date.now() - fs.statSync(mutex).mtimeMs > 10_000) {
    if (Date.now() > deadline) throw new Error('a legacy client still sees an aged live mutex');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  mark('heartbeat.json', JSON.stringify({ fresh: true }));
  process.exit(0);
}
let paused = false;
for (const method of ['mkdirSync', 'symlinkSync']) {
  const original = fs[method];
  fs[method] = (...args) => {
    const path = method === 'symlinkSync' ? args[1] : args[0];
    if (role === 'contender' && path === mutex && fs.existsSync(mutex)) {
      const old = new Date(Date.now() - 20_000);
      fs.utimesSync(mutex, old, old); // independent of machine load and the heartbeat
    }
    const result = original(...args);
    if (role === 'holder' && path === mutex && !paused) {
      paused = true;
      const owner = fs.existsSync(join(mutex, 'owner.json'))
        ? JSON.parse(fs.readFileSync(join(mutex, 'owner.json'), 'utf8'))
        : null;
      mark('paused.json', JSON.stringify({ pid: process.pid, owner }));
      until('resume');
    }
    return result;
  };
}
syncBuiltinESMExports();
const gpu = await import('../../scripts/gpu-lock.mjs');
try {
  const release = await gpu.acquire({ owner: role, waitMax: 0.01, max: 1, poll: 10, log() {} });
  mark(`${role}.json`, JSON.stringify({ acquired: true }));
  release();
} catch (error) {
  mark(`${role}.json`, JSON.stringify({ acquired: false, code: error.code, message: error.message }));
  process.exitCode = 2;
}
