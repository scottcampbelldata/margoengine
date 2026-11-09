import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readmeEntries } from '../../../scripts/support/readme-types.mjs';
import { placeOf } from '../../../scripts/run-readme-examples.mjs';

test('the Node glTF README supplies a real headless runtime and a complete pinned Basis model', () => {
  const entries = readmeEntries(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
  const examples = entries.filter(({ code }) => code.includes('ktx2: nodeKTX2'));
  assert.equal(examples.length, 1);
  const { code } = examples[0];
  assert.equal(placeOf(code), 'node');
  assert.doesNotMatch(code, /document\.|example\.com|new Worker/);
  assert.match(code, /installGPU\(\{gpu\}\)/);
  assert.match(code, /Engine\.create\(createHeadlessCanvas/);
  assert.match(code, /using model = await loadGLTF/);
  assert.match(code, /8f492390\/Models\/FlightHelmet\/glTF-KTX-BasisU\/FlightHelmet\.gltf/);
});
