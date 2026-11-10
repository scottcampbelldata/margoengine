import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { endTree } from '../../../scripts/support/shutdown.mjs';

// Native Rust fixtures must run under standard Node test discovery too: check:merge
// discovers this test, while the generic Rust-kernel finder does not scan native/avif.
test('AVIF native specification fixtures and Wasm references run in the CPU gate', { timeout: 610000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/test-avif-native.mjs', import.meta.url))], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (data) => chunks.push(data));
  child.stderr.on('data', (data) => chunks.push(data));
  let expired = false;
  let ended = Promise.resolve([]);
  const timer = setTimeout(() => {
    expired = true;
    if (child.pid) ended = endTree(child.pid);
  }, 600000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const survivors = await ended;
    const output = Buffer.concat(chunks).toString();
    assert.equal(expired, false, `AVIF native gate exceeded 600 s\n${output}`);
    assert.deepEqual(survivors, [], 'AVIF native gate left live processes');
    assert.equal(code, 0, output);
  } finally {
    clearTimeout(timer);
  }
});
