import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The erosion browser suite serves test-results/biomes-erosion-consumer/dist. It used to rely on an earlier run of
// erosion-bundle.test.js to build that folder, so check:gpu-packages, which runs the browser suite alone, got a 404 at
// the consumer's root (list 5 AMD GPU sweep, 2026-11-10). The suite must build the consumer before it serves it.
test('the erosion browser suite builds the consumer it serves before serving it', () => {
  const text = readFileSync(new URL('./erosion-browser.mjs', import.meta.url), 'utf8');
  const build = text.indexOf('await buildErosionConsumer()'),
    serve = text.indexOf('await preview(');
  assert.ok(build >= 0, 'erosion-browser.mjs awaits buildErosionConsumer()');
  assert.ok(serve > build, 'the consumer is built before preview() serves it');
});
