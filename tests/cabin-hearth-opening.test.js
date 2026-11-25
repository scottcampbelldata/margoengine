// KB-BOUNCE-REVEAL1: Cabin Hearth's window opening must give its light the recess and sill the frame and sill stand
// out of the glass, or the opening light and its bounce light snow the reveal and sill hide (the window's bounce at the
// log crest was +60% over the shaded quadrature). The GPU proof is scripts/cabin-hearth-browser-test.mjs (crest check).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../examples/cabin-hearth/main.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
);

test('the cabin window opening passes the recess and sill of its frame', () => {
  const start = source.indexOf('  opening = {'),
    end = source.indexOf('} as const;', start);
  assert.ok(start > 0 && end > start, 'the opening object is found');
  const opening = source.slice(start, end);
  // The frame's outer face is depth / 2 + 0.17 (its 0.34 m sides centred on the wall line); the glass's outdoor face
  // paneAt z + 0.002 is the opening's plane.
  assert.match(opening, /\n\s*recess: depth \/ 2 \+ 0\.17 - \(paneAt\[2\] \+ 0\.002\),/);
  // The sill block runs to depth / 2 + 0.05 + 0.21 = 2.76, 0.09 m past the frame's face at 2.67.
  assert.match(opening, /\n\s*sill: 0\.09,/);
  // The room's opening light is built from that object, so the clip reaches the light and its bounce.
  assert.match(source, /const roomLight = openingLight\(opening\);/);
});
