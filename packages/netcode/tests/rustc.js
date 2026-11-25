import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Runs a compiler and fails with a readable message. A missing binary (spawn ENOENT) or a crash leaves status, stdout and
// stderr null, which used to turn the assert message into NaN (null + null) and hide the cause.
export function compile(args, { command = 'rustc', ...options } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 << 20, ...options });
  assert.ok(
    !result.error,
    result.error?.code === 'ENOENT'
      ? `${command} not installed: install the Rust toolchain (https://rustup.rs) to run this test`
      : `${command} failed to run: ${result.error?.message}`,
  );
  assert.equal(result.status, 0, `${command} exited ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result;
}
