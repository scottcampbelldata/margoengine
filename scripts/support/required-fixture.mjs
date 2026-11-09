// Test data is required evidence. A missing checkout or LFS pointer must fail before a parser sees it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Reads a required fixture, naming its exact path and recovery command on an absent file or Git LFS pointer. */
export function requiredFixture(file, command) {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  const help = `Required test fixture ${path}; fetch it with: ${command}`;
  assert.ok(existsSync(path), `Missing ${help}`);
  const bytes = readFileSync(path);
  assert.ok(
    !bytes.subarray(0, 42).toString().startsWith('version https://git-lfs.github.com/spec/v1'),
    `Git LFS pointer instead of data: ${help}`,
  );
  return bytes;
}
