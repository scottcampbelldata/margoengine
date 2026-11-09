import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildErosionConsumer, consumerRoot } from './erosion-consumer.mjs';

test('production consumer emits the exact feature-local Wasm as a separate asset', { timeout: 120000 }, async () => {
  await buildErosionConsumer();
  const dir = join(consumerRoot, 'dist/assets');
  const files = readdirSync(dir);
  const wasm = files.filter((file) => file.endsWith('.wasm'));
  assert.equal(wasm.length, 1);
  assert.deepEqual(readFileSync(join(dir, wasm[0])), readFileSync(new URL('../dist/erosion.wasm', import.meta.url)));
  const js = files
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');
  assert.ok(js.includes(wasm[0]), 'factory keeps the emitted feature asset URL');
  assert.doesNotMatch(js, /data:application\/wasm|AGFzbQ/);
});
