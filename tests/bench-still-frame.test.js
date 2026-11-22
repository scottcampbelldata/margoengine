// KB2864b: the parity screenshot's still frame is two renders, t = 1/60 then t = 0, so motion blur shows one frame
// step. three's WebGPU scene pass renders once per animation frame, so a second render() in the same task showed the
// first render's picture, blurred by the jump from wherever the timed loop stopped. Each still-frame render must be its
// own animation frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the parity still frame waits an animation frame between its two renders', async () => {
  const code = await readFile(new URL('../bench/scenes/harness.js', import.meta.url), 'utf8'),
    first = code.indexOf('app.render(1 / 60);'),
    second = code.indexOf('app.render(0);', first);
  assert.ok(first > 0 && second > first, 'the still frame renders t = 1/60, then t = 0');
  const between = code.slice(first, second);
  assert.match(between, /await app\.idle\(\);/, 'the first still render finishes before the second');
  assert.match(between, /await raf\(\);/, 'the second still render is in the next animation frame');
  assert.match(
    code.slice(second),
    /^app\.render\(0\);\s*await app\.idle\(\);\s*await raf\(\);/,
    'the screenshot waits for it',
  );
});
