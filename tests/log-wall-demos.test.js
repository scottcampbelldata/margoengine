// KB-CABIN-SEAM1: Cabin Hearth and Whiteout Pass stacked their own faceted cylinders at a pitch of one diameter, and the
// slit a facet leaves at every course line showed the sky as one-pixel lines (cabin-window-snow, the back wall through
// the window). @margoengine/procedural's generateLogWall chinks the course lines; its own test casts lines through
// them (packages/procedural/test/log-wall.test.js). This keeps both demos on it. (Moved from tests/cabin-hearth.test.js,
// which now lives as the pixel test scripts/cabin-hearth-browser-test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('Cabin Hearth and Whiteout Pass build their log walls with generateLogWall, so no seam shows the sky', () => {
  for (const demo of ['cabin-hearth', 'whiteout-pass']) {
    const source = readFileSync(resolve(root, `examples/${demo}/main.ts`), 'utf8');
    // Other names may share the import (Cabin Hearth also takes generateWindowPane).
    assert.match(source, /import \{[^}]*\bgenerateLogWall\b[^}]*\} from '@margoengine\/procedural';/, demo);
    assert.ok((source.match(/generateLogWall\(\{/g) ?? []).length >= 3, `${demo}: front, back and side walls`);
    assert.doesNotMatch(source, /cylinderGeometry\(log \/ 2/, `${demo} stacks its own logs`);
  }
});
