import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readDisplacement } from '../../../examples/sciviz-glyph-data.ts';
import { warpByVector } from '../dist/glyph.js';
test('original pinned SEACAS displacement file retains all nodes, cells and displacement components', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../../../examples/assets/sciviz/glyph/displacement.e', import.meta.url))),
    source = JSON.parse(readFileSync(new URL('../../../examples/assets/sciviz/glyph/source.json', import.meta.url)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  const g = await readDisplacement(bytes);
  assert.equal(g.points.length / 3, 2185);
  assert.equal(g.types.length, 1300);
  assert(g.types.every((t) => t === 12));
  assert(g.pointData.some((x) => x > 0));
  const w = await warpByVector(g, 'displacement', { scaleFactor: 20 });
  assert.equal(w.connectivity, g.connectivity);
  for (let i = 0; i < w.points.length; i++) assert.equal(w.points[i], g.points[i] + 20 * g.pointArrays.displacement[i]);
  await assert.rejects(readDisplacement(bytes, 5), RangeError);
});
