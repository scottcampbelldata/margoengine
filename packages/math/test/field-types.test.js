// A number field declared before the constructor starts as undefined, so V8 stores it as a tagged field and every write
// of a fraction allocates (10,000 setFromEuler calls: 0.48 ms against 0.29 ms). packages/gltf/tsconfig.json, which this package extends,
// sets useDefineForClassFields false; this fails if the build goes back to declaring them.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const dist = new URL('../dist/', import.meta.url);

test('no built class declares a bare field before its constructor assigns it', () => {
  const files = readdirSync(dist).filter((name) => name.endsWith('.js'));
  assert.ok(files.includes('quaternion.js') && files.includes('vector3.js') && files.includes('euler.js'));
  for (const name of files)
    assert.doesNotMatch(readFileSync(new URL(name, dist), 'utf8'), /(?:^|[{;}])\s*[a-zA-Z_$][\w$]*;\s*constructor\(/m, name);
});
