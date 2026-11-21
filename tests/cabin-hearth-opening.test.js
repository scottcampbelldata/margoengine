// KB-BOUNCE-REVEAL1: Cabin Hearth's window light is set back in its frame, so the snow and logs it lights (and the
// bounce off that snow) see it only past the frame and the sill (@margoengine/clustered/area `openingLight` `recess`
// and `sill`; the clip itself is checked against a traced wall in packages/clustered/test/area.test.js and
// test/bounce.test.js). Without them the window's bounce at the log crest read 42% over the shaded quadrature of
// scripts/cabin-hearth-browser-test.mjs, the pixel check this keeps the demo on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test("Cabin Hearth's opening light carries its frame's recess and sill", () => {
  const source = readFileSync(resolve(import.meta.dirname, '../examples/cabin-hearth/main.ts'), 'utf8'),
    opening = source.match(/\bopening = \{([\s\S]*?)\} as const;/)?.[1];
  assert.ok(opening, 'the opening object');
  assert.match(opening, /\brecess: depth \/ 2 \+ 0\.17 - \(paneAt\[2\] \+ 0\.002\),/, "the frame's outer face, z 2.67");
  assert.match(opening, /\bsill: 0\.09,/, 'the sill, 0.09 m proud of the frame (to z 2.76)');
  assert.match(source, /const roomLight = openingLight\(opening\);/);
});
