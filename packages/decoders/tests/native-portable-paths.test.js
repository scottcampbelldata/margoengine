import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hostPath, NATIVE_FEATURES } from '../scripts/build-native.mjs';

// The clean-room decoder modules keep each Rust file's path for panic locations. Built on Windows they held src\kd.rs,
// elsewhere src/kd.rs, so one source tree gave two different committed modules and a rebuild on another system could
// not reproduce the record. build-native maps src to src/ and refuses a module with a backslash path.
test('clean-room decoder modules hold no host-specific source path, so every system builds the same bytes', () => {
  assert.equal(hostPath(Buffer.from('panic at src\\kd.rs')), 'src\\kd.rs');
  assert.equal(hostPath(Buffer.from('panic at src/kd.rs')), null);
  for (const { file } of Object.values(NATIVE_FEATURES)) {
    const bytes = readFileSync(new URL(`../src/${file}`, import.meta.url));
    assert.equal(hostPath(bytes), null, `${file} holds a host path`);
  }
});
