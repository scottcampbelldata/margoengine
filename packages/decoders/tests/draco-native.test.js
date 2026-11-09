// This package test is reached by verify, hence by every check:merge run.
// Keep the clean-room decoder's native and Wasm regressions in that gate even
// while its development crate is not yet connected to the public entry.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { endTree } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = 'packages/decoders/native/draco/Cargo.toml';

async function run(command, args, limitMs, signal, logFile) {
  const fd = openSync(logFile, 'w');
  // Match the Rust-kernel gate: direct spawn uses the OS command search on
  // Windows, where cmd.exe does not necessarily find the installed cargo.
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', fd, fd] });
  let ended = Promise.resolve([]), timedOut = false;
  const abort = () => { if (child.pid) ended = endTree(child.pid); };
  const timer = setTimeout(() => { timedOut = true; abort(); }, limitMs);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const result = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('close', (code) => resolve({ code }));
    });
    const survivors = await ended;
    assert.deepEqual(survivors, [], `processes survived ${command}`);
    assert.ok(!timedOut && !signal.aborted && !result.error && result.code === 0,
      `${command} ${args.join(' ')}: ${timedOut ? 'TIMEOUT, process tree ended' : result.error?.message ?? `exit ${result.code}`}\n${readFileSync(logFile, 'utf8')}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    closeSync(fd);
  }
}

test('clean-room Draco: native and Wasm metadata, traversal, prediction and memory regressions', { timeout: 300_000 }, async (t) => {
  const directory = join(root, 'test-results');
  mkdirSync(directory, { recursive: true });
  const logs = mkdtempSync(join(directory, 'draco-native-'));
  const commands = [
    ['cargo', ['test', '--offline', '--locked', '--manifest-path', manifest], 120_000],
    ['cargo', ['build', '--offline', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest], 120_000],
    ...['kd', 'memory', 'prediction', 'metadata', 'flavor', 'predictive'].map((name) => [
      process.execPath, [`packages/decoders/native/draco/tests/wasm-${name}.mjs`], 180_000,
    ]),
  ];
  for (const [index, [command, args, limitMs]] of commands.entries()) {
    const logFile = join(logs, `${index}.log`);
    await run(command, args, limitMs, t.signal, logFile);
  }
});
